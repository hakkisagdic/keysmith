import { accessSync, constants as fsConstants, statSync, lstatSync, mkdirSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { getParser, toLines } from './parsers.js';
import { expand } from './config.js';
import { LlmError, flattenMessages, joinArgs, Semaphore, truncate, keepTail, agentCleanEnv } from './util.js';
import { checkToolMode } from './tools/router.js';
import { checkMedia, hasMedia, mediaPrompt } from './media.js';
import { takesEffort } from './effort.js';
import { CLI_PROFILES, FORMER_PARSERS } from './profiles.js';
import { credentialAccount } from './usage.js';

/**
 * Run a coding CLI once per request and turn its stdout into a chat completion.
 *
 * This is the point of keysmith: the CLI *is* the model. An adapter is pure
 * configuration — argv template, parser, timeout — so wiring up an agent nobody has
 * heard of is a config edit, not a code change or a fork.
 *
 * Two honest caveats, both handled by the built-in profiles:
 *  - A CLI injects its own (large) system prompt, so reported `input` tokens are not
 *    the tokens you sent. We report what the upstream actually charged, not what we
 *    wished it charged.
 *  - A CLI is an agent: with tools, it will run commands and edit files. Profiles take the
 *    tools away with the CLI's own switches and run it in an empty workspace keysmith owns;
 *    one whose tools cannot be taken away is marked `unsafeTools` and ships disabled.
 */
export class CliAdapter {
  constructor(id, cfg) {
    this.id = id;
    this.kind = 'cli';
    this.bin = cfg.bin || id;
    this.args = cfg.args || ['{prompt}'];
    this.resumeArgs = cfg.resumeArgs || null;
    this.persistSessions = !!cfg.persistSessions;
    this.parser = cfg.parser || 'raw';
    this.promptVia = cfg.promptVia || 'arg';
    this.cwd = cfg.cwd ? expand(cfg.cwd) : process.cwd();
    // A configured cwd is the agent's workspace: an empty directory keysmith owns, so
    // whatever the CLI reads "from the project" is nothing. Created on first spawn, because
    // a missing cwd makes spawn() fail with an ENOENT that reads like a missing binary.
    this._ownsCwd = !!cfg.cwd;
    // Files keysmith keeps inside that workspace (relative path -> exact content), rewritten
    // whenever they drift. This is how an agent's own configuration travels with the profile:
    // agy reads a tool-less agent definition from `.agents/agents/` in its cwd.
    this.workspaceFiles = checkWorkspaceFiles(id, cfg.workspaceFiles, this._ownsCwd);
    this.workspaceFilesCustom = !!cfg.workspaceFilesCustom;
    // One more attempt, with this instruction in front of the prompt, when a run ends in a
    // refused tool call and no text (a parser `error` event with code 'tool_denied').
    this.toolDenialRetry = typeof cfg.toolDenialRetry === 'string' && cfg.toolDenialRetry.trim() ? cfg.toolDenialRetry.trim() : null;
    // A CLI whose tools keysmith could not take away: it can run commands and edit files.
    // Never an alias leg, never probed by `doctor --probe-models` (see Gateway.resolve).
    this.unsafeTools = !!cfg.unsafeTools;
    // For a CLI run as a text model: once the answer has text, the first tool call ends it.
    // A harness can keep a tool of its own that no agent definition removes (agy:
    // `manage_task`), and a model that calls it after answering answers again, and again.
    // `'always'` ends the run at a tool call before any text too, and fails the request: for
    // a CLI whose tools could not be taken away (Warp), or a keysmith-owned opencode workspace
    // where `read` stays in the schema only as a denied placeholder, a tool call is never the
    // way to an answer. User opencode adapters without `cwd`, with their own project `cwd` and
    // no `workspaceFiles`, or with `unsafeTools: true` keep their setting; a user opencode
    // adapter that sets both `cwd` and `workspaceFiles` (without `unsafeTools`) is treated as a
    // keysmith-owned workspace (`_ownsOpencodeWorkspace`) and gets the scratch directory and
    // forced `stopAtToolCall: 'always'` unless `stopAtToolCall: false` is set explicitly.
    const isOpencode = path.basename(String(this.bin)) === 'opencode' || this.parser === 'opencode-ndjson';
    this._isOpencode = isOpencode;
    this._ownsOpencodeWorkspace = isOpencode && this._ownsCwd && !this.unsafeTools && !!this.workspaceFiles;
    this.stopAtToolCall = cfg.stopAtToolCall === 'always' || (this._ownsOpencodeWorkspace && cfg.stopAtToolCall !== false) ? 'always' : !!cfg.stopAtToolCall;
    // What `{noSession}` renders as when the run is not resumed. CLIs disagree on the spelling:
    // Command Code takes `--no-session`, Claude Code and Qoder refuse it and take
    // `--no-session-persistence`.
    this.noSessionFlag = typeof cfg.noSessionFlag === 'string' ? cfg.noSessionFlag : '--no-session';
    // How this CLI answers a request that offers tools (src/tools/router.js): never ('off', the
    // default), EMULATE, the MCP bridge, or `auto`. Never on a CLI that kept its own tools.
    this.toolMode = checkToolMode(id, cfg);
    // The argv of an EMULATE run (`args` when there is none): agy's names the `keysmith-tools`
    // agent. And the MCP bridge's own settings, its argv among them (design U7).
    this.emulateArgs = checkTemplate(id, 'emulateArgs', cfg.emulateArgs);
    this.bridge = checkBridge(id, cfg.bridge);
    // A CLI that takes media (`media`, `vision: true` for images): a request that carries some runs
    // `visionArgs`, its prompt on stdin as one stream-json user message with the media in it
    // (src/media.js). Any other CLI reads each item as a label: `[image omitted by keysmith]`.
    const { kinds, limits } = checkMedia(id, cfg, { wire: 'anthropic', where: 'to a CLI (its stream-json input is an Anthropic message)' });
    if (kinds.length && !cfg.visionArgs) {
      const field = cfg.vision ? 'vision' : 'media';
      throw new Error(`adapter "${id}": ${field} needs visionArgs — the argv of a run whose prompt, media included, goes on stdin as stream-json (\`keysmith set ${id} ${field} ${cfg.vision ? 'true' : kinds.join(',')}\` fills the built-in profile's)`);
    }
    this.media = kinds;
    this.vision = kinds.includes('image');
    this.visionArgs = checkTemplate(id, 'visionArgs', cfg.visionArgs);
    this.mediaOpts = { adapterId: id, kinds, limits, fetchUrls: cfg._fetchMedia !== false };
    // An argv that auto-approves the agent's tool calls (`opencode --auto`, `--yolo`, …) is an
    // agent that acts on this machine for whoever holds a key. That is never a default: it
    // loads only when the entry says so with `unsafeTools`, which keeps it out of every alias
    // and every probe. A config copied from an older profile stops here, with the way out.
    // Every template is read: `args`, `resumeArgs`, `emulateArgs`, `visionArgs` and the bridge's `args`.
    const approving = autoApproveFlag(cfg);
    if (approving && !this.unsafeTools) {
      throw new Error(
        `adapter "${id}": its argv passes ${approving}, which auto-approves the agent's tool calls — it could run commands and edit files on this machine for any request that reaches it. ` +
          `Take the flag out (\`keysmith add <profile> --as ${id}\` re-copies a built-in profile's tool-less argv), or mark it unsafeTools with --allow-unsafe-tools`,
      );
    }
    // Answers only a request that names it: never an alias leg, never probed.
    this.explicitOnly = !!cfg.explicitOnly || this.unsafeTools;
    // An entry of a built-in profile that changed parser along with its argv (FORMER_PARSERS — codex:
    // plain `exec` under raw, then `exec --json` under codex-json-final) runs the two together or
    // not at all. `upgrade --take` brings one field at a time, and an entry left half-way answers
    // every request with codex's JSONL event stream (200 OK) or with nothing: refused here, with the
    // fields that bring it whole.
    this._lineage = parserLineage(this.bin, this.parser);
    checkLineage(id, this._lineage, this._textTemplates());
    // A CLI that takes a reasoning effort: every argv template it has says where (`{effort}`), and
    // its catalogue which levels each model takes (src/effort.js). An entry upgraded in part (the
    // bridge's argv has it, `args` not yet) takes none, so no path of it runs a request's effort
    // and another refuses it: `effortGap` names the templates that lack it.
    const present = [...this._textTemplates(), ...(Array.isArray(this.bridge?.args) ? [['bridge.args', this.bridge.args]] : [])];
    const lacking = present.filter(([, t]) => !takesEffort(t)).map(([k]) => k);
    this.takesEffort = present.length > 0 && !lacking.length;
    this.effortGap = lacking.length && lacking.length < present.length ? `${id}'s ${lacking.join(', ')} take${lacking.length > 1 ? '' : 's'} no {effort} — keysmith upgrade ${id} --take ${this.takeFor(lacking).join(',')} --apply brings the profile's` : null;
    this.env = cfg.env || {};
    this.timeoutMs = cfg.timeoutMs ?? 300_000;
    const defaultFirstEventMs = this._isOpencode ? CLI_PROFILES.opencode?.firstEventTimeoutMs ?? 45_000 : null;
    this.firstEventTimeoutMs = cfg.firstEventTimeoutMs === 0 || cfg.firstEventTimeoutMs === null ? null : (cfg.firstEventTimeoutMs ?? defaultFirstEventMs);
    this._firstEventTimeoutScopedToFreeTier = this._isOpencode && (cfg.firstEventTimeoutMs === undefined || cfg.firstEventTimeoutMs === defaultFirstEventMs);
    this.priority = cfg.priority ?? 200;
    this.disabled = !!cfg.disabled;
    this.stripSystemPrompt = !!cfg.stripSystemPrompt;
    this.systemFlag = cfg.systemFlag || null;
    this.maxPromptChars = cfg.maxPromptChars ?? 200_000;
    this.modelsFrom = cfg.modelsFrom || null;
    this.declaredModels = cfg.models || null;
    this.defaultModel = cfg.defaultModel || null;
    this.note = cfg.note || null;
    this.provenance = typeof cfg.provenance === 'string' && cfg.provenance.trim() ? cfg.provenance.trim() : this._isOpencode ? CLI_PROFILES.opencode?.provenance || null : null;
    this.verifiedVersion =
      typeof cfg.verifiedVersion === 'string' && cfg.verifiedVersion.trim()
        ? cfg.verifiedVersion.trim()
        : this.provenance?.match(/^opencode\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i)?.[1] || (this._isOpencode ? CLI_PROFILES.opencode?.verifiedVersion || null : null);
    this.provenanceVersion = this.verifiedVersion;
    this.allowUnverifiedVersion = !!cfg.allowUnverifiedVersion;
    this.versionCacheTtlMs = cfg.versionCacheTtlMs ?? OPENCODE_VERSION_TTL_MS;
    this.negativeVersionCacheTtlMs = cfg.negativeVersionCacheTtlMs ?? OPENCODE_NEGATIVE_VERSION_TTL_MS;
    this.orgConfigCacheTtlMs = cfg.orgConfigCacheTtlMs ?? OPENCODE_ORG_CONFIG_TTL_MS;
    this.orgConfigFetchTimeoutMs = cfg.orgConfigFetchTimeoutMs ?? OPENCODE_ORG_CONFIG_TIMEOUT_MS;
    this.managedConfigDir = cfg.managedConfigDir ? expand(cfg.managedConfigDir) : null;
    this.managedPlistPaths = Array.isArray(cfg.managedPlistPaths) ? cfg.managedPlistPaths.map((p) => expand(p)) : [];
    this.account = credentialAccount(cfg);
    this.costBasis = cfg.costBasis || 'subscription';
    this._sem = new Semaphore(cfg.maxConcurrent ?? 1);
    this._modelCache = null;
    this._sessionDirs = new Map();
    this._activeScratchRuns = new Map();
    this._preflightRuns = 0;
    this._preflightHits = 0;
  }

  get resumable() {
    return !!(this.resumeArgs && this.persistSessions);
  }

  /** The argv templates whose output `this.parser` reads, as `[field, template]`: every one the entry has but the bridge's. */
  _textTemplates() {
    return Object.entries({ args: this.args, resumeArgs: this.resumeArgs, emulateArgs: this.emulateArgs, visionArgs: this.visionArgs }).filter(([, t]) => Array.isArray(t));
  }

  /**
   * The `keysmith upgrade <id> --take` list that brings these fields from the built-in profile, as
   * the command takes them: the bridge's argv is `bridge`; and on an entry still on a parser its
   * profile had before (codex: raw), a field whose profile argv has the token that parser cannot
   * read (`--json`) brings the parser, and with it every text template still without the token —
   * `--take args` alone would be refused at load (checkLineage).
   */
  takeFor(fields) {
    const take = fields.map((f) => (f === 'bridge.args' ? 'bridge' : f));
    const l = this._lineage;
    if (l?.former && fields.some((f) => hasToken(l.profile[f], l.token))) {
      for (const [field, t] of this._textTemplates()) if (!hasToken(t, l.token) && Object.hasOwn(l.profile, field)) take.push(field);
      take.push('parser');
    }
    return [...new Set(take)];
  }

  async models() {
    if (this.disabled) return [];
    if (this._modelCache && Date.now() - this._modelCache.at < 600_000) return this._modelCache.list;
    if (this.declaredModels) {
      const list = (Array.isArray(this.declaredModels) ? this.declaredModels : Object.keys(this.declaredModels)).map((m) =>
        typeof m === 'string' ? { id: m } : m,
      );
      this._modelCache = { at: Date.now(), list };
      return list;
    }
    if (!this.modelsFrom) return [];
    const list = await this._listModels();
    this._modelCache = { at: Date.now(), list };
    return list;
  }

  /**
   * The catalogue an effort is checked against (src/effort.js): the models, with the levels each
   * takes. A declared `models` list whose entries say nothing of efforts leaves them to the CLI's
   * own listing (`modelsFrom`), when it has one — a level is never guessed.
   */
  async effortCatalogue() {
    const list = await this._staleOk('_modelCache', () => this.models());
    if (!this.declaredModels || list.some((m) => Array.isArray(m?.efforts)) || !this.modelsFrom) return list;
    return this._staleOk('_listedCache', async () => {
      const listed = await this._listModels();
      this._listedCache = { at: Date.now(), list: listed };
      return listed;
    });
  }

  /**
   * A catalogue read for a request: the one in `field` when there is one — a stale one is read
   * again in the background, so a request waits on a CLI's listing (Claude Code's `initialize`
   * takes ~4 s) only when there has never been one — or `read()` now.
   */
  async _staleOk(field, read) {
    const c = this[field];
    if (!c) return read();
    if (Date.now() - c.at >= 600_000 && !this[`${field}Refresh`]) {
      this[`${field}Refresh`] = Promise.resolve()
        .then(read)
        .catch(() => {})
        .finally(() => (this[`${field}Refresh`] = null));
    }
    return c.list;
  }

  /** The CLI's own model listing (`modelsFrom`), read now. */
  async _listModels() {
    if (!which(this.bin)) throw new LlmError(`${this.bin} is not on PATH`, { status: 503, provider: this.id });
    const spec = this.modelsFrom;
    const out = await this._spawn({ args: spec.args || ['--list-models'], stdin: typeof spec.stdin === 'string' ? spec.stdin : null, timeoutMs: spec.timeoutMs ?? 30_000 });
    if (out.code !== 0) throw new LlmError(`${this.bin} ${spec.args?.join(' ')} exited ${out.code}: ${truncate(out.stderr, 160)}`, { status: 502, provider: this.id });
    // CLIs print their picker verbatim: section headers ("Open Source"), counts, and
    // one model per line with an optional description after two or more spaces or a
    // tab (`agy models` prints `id<TAB>Display Name`).
    // A row only counts as a model if its first token is id-shaped and carries a
    // slash, digit or dot — that is what separates `gpt-5.4` from `Google`.
    const MODELISH = /^[a-z0-9][a-z0-9._+\-/]*$/i;
    // Some CLIs list their models as JSON (`kiro-cli chat --list-models --format json`,
    // `oz model list --output-format json`, `codex debug models`): read that as JSON.
    const fromJson = jsonModelList(out.stdout || out.stderr);
    if (fromJson) return fromJson.filter((m) => !spec.drop?.some((d) => m.id.startsWith(d)));
    const list = [];
    for (const line of (out.stdout || out.stderr).split('\n')) {
      const m = line.trim().match(/^(\S+)(?:(?:\t|\s{2,})\s*(.+))?$/);
      if (!m) continue;
      const id = m[1];
      if (!MODELISH.test(id) || !/[\/\d.]/.test(id)) continue;
      if (spec.drop?.some((d) => id.startsWith(d))) continue;
      list.push({ id, ...(m[2] ? { name: m[2].trim() } : {}) });
    }
    return list;
  }

  /** Throws the 503 a request to this adapter gets when it cannot run at all: disabled, or its binary is not on PATH. */
  ready() {
    if (this.disabled) throw new LlmError(`adapter "${this.id}" is disabled`, { status: 503, provider: this.id });
    if (!which(this.bin)) throw new LlmError(`adapter "${this.id}": "${this.bin}" is not on PATH`, { status: 503, provider: this.id });
  }

  /**
   * Check whether an opencode adapter's `workspaceFiles` match `CLI_PROFILES.opencode.workspaceFiles`.
   * Returns `{ stale, missing, warning }` (`warning` names `keysmith upgrade <id> --take workspaceFiles`).
   */
  checkWorkspaceFiles() {
    if (!this._ownsOpencodeWorkspace || this.disabled || this.workspaceFilesCustom) return { stale: [], missing: [], warning: null };
    const expected = CLI_PROFILES.opencode?.workspaceFiles || {};
    const actual = this.workspaceFiles || {};
    const missing = [];
    const stale = [];
    for (const [file, content] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, file)) missing.push(file);
      else if (actual[file] !== content) stale.push(file);
    }
    if (!missing.length && !stale.length) return { stale, missing, warning: null };
    const detail = [stale.length ? `stale: ${stale.join(', ')}` : '', missing.length ? `missing: ${missing.join(', ')}` : ''].filter(Boolean).join('; ');
    return {
      stale,
      missing,
      warning: `workspaceFiles out of date (${detail}) — run \`keysmith upgrade ${this.id} --take workspaceFiles\` (with \`--apply\` to write, or \`keysmith set ${this.id} workspaceFilesCustom true\` if customised)`,
    };
  }

  /**
   * Probe and cache the installed CLI's `--version` semver, keyed on `realpathSync(binPath)` plus
   * `ino`, `ctimeMs`/`ctimeNs`, `size`, and `mtimeMs`/`mtimeNs`, with a short TTL (60 s default;
   * failed/unrecognised probes cached briefly for 5 s so every request does not spawn a new probe
   * while still failing closed). A missing stat is never cached.
   */
  async _probeInstalledVersion({ force = false } = {}) {
    const binPath = which(this.bin);
    if (this.disabled || !binPath) return null;
    if (!force) {
      const hit = readVersionCache(binPath);
      if (hit) return hit.installed;
    }
    const preStatKey = getBinStatKey(binPath);
    const flightKey = `${binPath}|${preStatKey || 'nostat'}|${force ? 'force' : 'cached'}`;
    if (_versionInFlight.has(flightKey)) {
      return _versionInFlight.get(flightKey);
    }
    const p = (async () => {
      const out = await this._spawn({ args: ['--version'], timeoutMs: 15_000 });
      let installed = null;
      if (out.code === 0) {
        const text = `${out.stdout || ''}\n${out.stderr || ''}`.trim();
        const m = text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
        installed = m ? m[1] : null;
      }
      const postStatKey = getBinStatKey(binPath);
      // Missing stat or mid-probe binary replacement means "not cached".
      if (postStatKey && (!preStatKey || postStatKey === preStatKey)) {
        const ttlMs = installed
          ? Number(this.versionCacheTtlMs ?? OPENCODE_VERSION_TTL_MS)
          : Number(this.negativeVersionCacheTtlMs ?? OPENCODE_NEGATIVE_VERSION_TTL_MS);
        if (ttlMs > 0) {
          const now = Date.now();
          if (_versionCache.size >= 256) {
            for (const [k, v] of _versionCache) {
              if (now >= v.expiresAt) _versionCache.delete(k);
            }
            if (_versionCache.size >= 256) {
              const oldest = _versionCache.keys().next().value;
              if (oldest !== undefined) _versionCache.delete(oldest);
            }
          }
          _versionCache.set(postStatKey, {
            installed,
            expiresAt: now + ttlMs,
          });
        } else {
          _versionCache.delete(postStatKey);
        }
      }
      return installed;
    })().finally(() => {
      _versionInFlight.delete(flightKey);
    });
    _versionInFlight.set(flightKey, p);
    return p;
  }

  /**
   * Compare the installed CLI's `--version` output against `this.verifiedVersion`.
   * Cached briefly per `(realpathSync(binPath), ino, ctime, size, mtime)`.
   * Returns `{ installed, expected, warning }` (`warning` is null when they match or when the
   * binary / version output is unavailable).
   */
  async checkVersion() {
    const expected = this.verifiedVersion;
    const binPath = which(this.bin);
    if (!expected || this.disabled || !binPath) return { installed: null, expected, warning: null };
    const installed = await this._probeInstalledVersion();
    if (!installed || installed === expected) return { installed, expected, warning: null };
    const refusalNote =
      this._ownsOpencodeWorkspace && !this.allowUnverifiedVersion
        ? `; runs are refused unless \`keysmith set ${this.id} allowUnverifiedVersion true\` is set`
        : '';
    return {
      installed,
      expected,
      warning: `${path.basename(this.bin)} ${installed} !== verified ${expected} (provenance ${expected}) — workspace config was verified against ${expected} (run \`keysmith upgrade ${this.id} --take workspaceFiles\`${refusalNote})`,
    };
  }

  /**
   * Run adapter health checks (workspace files + CLI version).
   */
  async probe() {
    const ws = this.checkWorkspaceFiles();
    const ver = await this.checkVersion();
    const warnings = [ws.warning, ver.warning].filter(Boolean);
    return {
      installed: ver.installed,
      expected: ver.expected,
      versionWarning: ver.warning,
      workspaceWarning: ws.warning,
      warnings,
    };
  }

  /**
   * A process slot (`maxConcurrent`) for an engine that runs the CLI itself; the release function.
   * A request whose client left while it waited never gets one: its abort already fired.
   */
  async acquire(signal) {
    const release = await this._sem.acquire();
    if (signal?.aborted) {
      release();
      throw new LlmError(`adapter "${this.id}": client disconnected while queued for a free process`, { status: 499, provider: this.id });
    }
    return release;
  }

  /**
   * One run for the EMULATE engine (src/tools/emulate.js): `text` is the whole prompt, the argv
   * is `emulateArgs` (or `args`), and nothing is resumed. `{ events, stop, done }`: the parser's
   * events, a stop switch, and the process outcome. The caller holds a slot (acquire()).
   */
  async emulateRun({ text, model, effort = null, timeoutMs, signal }) {
    const tpl = this.emulateArgs || this.args;
    const field = this.emulateArgs ? 'emulateArgs' : 'args';
    effortIn(this.id, field, tpl, effort, this.takeFor([field]));
    const argv = joinArgs(tpl, {
      model: model || '',
      effort: effort || '',
      prompt: this.promptVia === 'stdin' ? '' : text,
      system: '',
      session: '',
      noSession: this.persistSessions ? '' : this.noSessionFlag,
      maxTokens: '',
    });
    const run = await this._spawnStream({ args: argv, stdin: this.promptVia === 'stdin' ? text : null, timeoutMs, signal, model });
    return { events: getParser(this.parser)(toLines(run.stdout)), stop: run.stop, done: run.done };
  }

  /**
   * One completion. `rendered` ({ system, prompt }) is a prompt a tool engine wrote itself in
   * place of the flattened `messages` (router.js, tool_choice none); such a run is never resumed.
   */
  async *complete({ model, messages, session, sessionKey = null, signal, maxTokens, effort = null, rendered = null }) {
    this.ready();

    // A request with media, on a CLI that takes some of it: the prompt goes on stdin, media and all.
    // One whose media this CLI takes none of runs as text, each item its label.
    const withMedia = this.media.length && !rendered && hasMedia(messages) ? await mediaPrompt(messages, this.mediaOpts, { signal }) : null;
    const vision = withMedia?.media ? withMedia : null;
    const { system, prompt } = vision || rendered || withMedia || flattenMessages(messages);
    if (!prompt && !system) throw new LlmError('nothing to send: the message list is empty after flattening', { status: 400, provider: this.id });
    if (prompt.length > this.maxPromptChars) {
      throw new LlmError(
        `adapter "${this.id}": prompt is ${prompt.length} chars, over maxPromptChars=${this.maxPromptChars}. Trim history, or raise the cap on this adapter.`,
        { status: 400, provider: this.id },
      );
    }
    const keepSystem = !this.stripSystemPrompt;
    const body = keepSystem && system && !this.systemFlag ? `<system>\n${system}\n</system>\n\n${prompt}` : prompt;
    const useResume = !!(session && this.resumable) && !rendered && !vision;
    const scratchDir =
      this._ownsOpencodeWorkspace && this.resumable && !rendered && !vision
        ? (session && this._sessionDirs.get(session)) || (sessionKey || session ? this._sessionScratchDir(sessionKey || session) : null)
        : null;
    const stdinFor = (text) => (vision ? vision.stdin(text) : this.promptVia === 'stdin' ? text : null);
    const tpl = vision ? this.visionArgs : useResume ? this.resumeArgs : this.args;
    const field = vision ? 'visionArgs' : useResume ? 'resumeArgs' : 'args';
    effortIn(this.id, field, tpl, effort, this.takeFor([field]));
    const argvFor = (text) => {
      const argv = joinArgs(tpl, {
        model: model || '',
        effort: effort || '',
        prompt: this.promptVia === 'stdin' || vision ? '' : text,
        system: keepSystem ? system || '' : '',
        session: useResume ? session : '',
        noSession: this.persistSessions || useResume ? '' : this.noSessionFlag,
        maxTokens: maxTokens || '',
      });
      if (this.systemFlag && keepSystem && system) argv.push(...this.systemFlag.split(/\s+/), system);
      return argv;
    };

    // A request can wait here longer than its client does (a curl --speed-time guard, a
    // closed tab). Its abort already fired, and an AbortSignal does not re-fire for a late
    // listener — spawning now would run a whole agent for nobody while holding the slot.
    const release = await this.acquire(signal);
    try {
      const parse = getParser(this.parser);
      // A retry spends the same budget as the first run: one request never takes longer
      // than `timeoutMs`, however it got its answer.
      const deadline = Date.now() + this.timeoutMs;
      let carried = null; // what a refused-and-retried run cost, added to the next usage report
      for (let attempt = 0; ; attempt++) {
        const retryable = attempt === 0 && !!this.toolDenialRetry;
        const text = attempt === 0 ? body : `${this.toolDenialRetry}\n\n${body}`;
        const run = await this._spawnStream({
          args: argvFor(text),
          stdin: stdinFor(text),
          // The first run has the whole budget, to the millisecond its timeout error names.
          timeoutMs: attempt === 0 ? this.timeoutMs : Math.max(1_000, deadline - Date.now()),
          signal,
          scratchDir,
          model,
        });
        let emitted = false;
        // While a run may still be retried, everything but text is held back: a refused run's
        // session, usage and error must not reach the client if a second run replaces it.
        // The first text delta proves there is an answer, so the held events go out in order.
        const held = [];
        let carriedSent = false;
        let cut = null; // the tool call the answer was ended at
        let blocked = null; // a tool call before any text, stopped (`stopAtToolCall: 'always'`)
        let blockedError = null;
        let blockedErrorType = null;
        for await (let evt of noteUsageGap(parse(toLines(run.stdout)), () => this.usageGap())) {
          if (evt.type === 'session' && evt.id && this._ownsOpencodeWorkspace && this.resumable) {
            this._rememberSessionDir(evt.id, run.cwd);
          }
          if (evt.type === 'tool') {
            // Before any text the call may be how the model gets to its answer, so the run
            // goes on. After text, the answer exists: stop the process instead of letting
            // it loop until its own timeout, and keep whatever it says next out of the reply.
            // On a keysmith-owned opencode workspace, EVERY tool event in the stream is
            // inspected (even after `cut` is set) and any outcome other than DeniedError /
            // UnavailableToolError fails the run.
            const toolName = evt.name || 'a tool';
            const isUnexpected =
              this._ownsOpencodeWorkspace && evt.errorType !== 'DeniedError' && evt.errorType !== 'UnavailableToolError';
            if (isUnexpected && (!blockedErrorType || blockedErrorType === 'DeniedError' || blockedErrorType === 'UnavailableToolError')) {
              blocked = toolName;
              blockedError = evt.error || null;
              blockedErrorType = evt.errorType || 'unknown';
            }
            if (this.stopAtToolCall && emitted && !cut) {
              cut = toolName;
              if (isUnexpected) {
                run.stop(`stopped at a call to ${cut}: unexpected tool outcome ${blockedErrorType}`);
              } else {
                run.stop(`answer complete, stopped at a call to ${cut}`);
                yield { type: 'cut', reason: 'tool_call', tool: cut };
              }
            } else if (this.stopAtToolCall === 'always' && !emitted && !cut) {
              // A CLI that kept its tools: a call is stopped wherever it comes. The harness
              // may have started it already — this is a limit on the damage, not a sandbox.
              cut = blocked = toolName;
              if (!blockedErrorType) {
                blockedError = evt.error || null;
                blockedErrorType = evt.errorType || null;
              }
              run.stop(`stopped at a call to ${cut}: this adapter may not run tools`);
            } else if (isUnexpected) {
              if (!cut) cut = toolName;
              run.stop(`stopped at a call to ${toolName}: unexpected tool outcome ${blockedErrorType}`);
            }
            continue;
          }
          if (cut && (evt.type === 'delta' || evt.type === 'error')) continue;
          // An error the parser reports once the stream ended because keysmith's own timeout
          // stopped the run (codex's held `Reconnecting... 1/5`, said at the stream's end) is
          // that timeout: a 504 that names it, with the CLI's last error after it — never a 502
          // that reads as if the CLI had failed on its own.
          const timedOut = evt.type === 'error' && !emitted ? run.timedOut?.() : null;
          if (timedOut) {
            evt = { ...evt, status: 504, message: `${this.id} was stopped by keysmith (${timedOut}); the last error it reported: ${truncate(evt.message || 'none', 300)}` };
          }
          if (evt.type === 'usage' && carried && !carriedSent) {
            evt = { ...evt, usage: addUsage(carried, evt.usage) };
            carriedSent = true;
          }
          if (evt.type === 'done' && carried && !carriedSent) {
            yield { type: 'usage', usage: carried };
            carriedSent = true;
          }
          const isText = evt.type === 'delta' && !!evt.text;
          if (retryable && !emitted && !isText) {
            held.push(evt);
            continue;
          }
          if (isText && !emitted) {
            emitted = true;
            yield* held.splice(0);
          }
          yield evt;
        }
        const outcome = await run.done;
        const denial = held.find((e) => e.type === 'error' && e.code === 'tool_denied');
        if (retryable && !emitted && denial && !signal?.aborted && deadline - Date.now() > MIN_RETRY_BUDGET_MS) {
          carried = maxUsage(held.filter((e) => e.type === 'usage').map((e) => e.usage));
          // Not an answer and not an error: a marker the gateway logs and the usage log counts,
          // so a retried refusal is never mistaken for a model that behaved.
          yield { type: 'retry', reason: 'tool_denied', message: denial.message };
          continue;
        }
        yield* held.splice(0);
        const unexpectedOutcome =
          this._ownsOpencodeWorkspace && blockedErrorType && blockedErrorType !== 'DeniedError' && blockedErrorType !== 'UnavailableToolError';
        if (blocked && (!emitted || unexpectedOutcome)) {
          const unexpected = unexpectedOutcome
            ? ` (unexpected tool outcome: ${blockedErrorType}${blockedError ? ` — ${truncate(blockedError, 160)}` : ''})`
            : '';
          const where = emitted ? 'after answering' : 'before answering';
          const err = new LlmError(
            `adapter "${this.id}": the agent started a tool call (${blocked}) ${where}, and keysmith stopped the run — this adapter may not run tools${unexpected}`,
            {
              status: 502,
              provider: this.id,
            },
          );
          if (blockedErrorType) err.toolErrorType = blockedErrorType;
          if (blockedError) err.toolError = blockedError;
          throw err;
        }
        if (outcome.code !== 0 && !emitted) {
          if (outcome.abortError) {
            throw new LlmError(outcome.abortError.message, {
              status: outcome.abortError.status,
              provider: this.id,
              retriable: outcome.abortError.retriable,
            });
          }
          throw new LlmError(
            `${this.id} exited ${outcome.code}${outcome.killed ? ' (killed)' : ''}: ${truncate(outcome.stderr || outcome.error || 'no output', 300)}`,
            { status: outcome.killed ? 504 : 502, provider: this.id, retriable: !!outcome.killed },
          );
        }
        return;
      }
    } finally {
      release();
    }
  }

  /**
   * Why a run of this CLI has no token counts, for the `usage_unknown` event a face writes as null
   * counts with this reason (never as 0).
   */
  usageGap() {
    return this.parser === 'raw'
      ? `${this.id} runs with parser raw: the CLI's plain output carries no token counts`
      : `${this.id} reported no token counts for this run (parser ${this.parser})`;
  }

  _ensureCwd() {
    if (!this._ownsCwd) return;
    try {
      mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    } catch {}
    for (const [rel, content] of Object.entries(this.workspaceFiles || {})) {
      const file = path.join(this.cwd, rel);
      let current = null;
      try {
        current = readFileSync(file, 'utf8');
      } catch {}
      if (current === content) continue;
      // A missing agent file is not an error to agy: it falls back to its full harness and
      // tools without a word. So a file that cannot be written fails the request instead.
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, content, { mode: 0o600 });
        renameSync(tmp, file);
        chmodSync(file, 0o600);
      } catch (e) {
        throw new LlmError(`adapter "${this.id}": could not write ${file}: ${e.message}`, { status: 500, provider: this.id });
      }
    }
  }

  _sessionScratchDir(key) {
    this._ensureCwd();
    const root = ensureScratchRoot(this.id, this.cwd);
    const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
    const dir = path.join(root, `sess-${this.id}-${digest}`);
    ensurePrivateScratchDir(this.id, dir, { exclusive: false });
    return realpathSync(dir);
  }

  _rememberSessionDir(sessionId, dir) {
    if (!sessionId || !dir) return;
    if (this._sessionDirs.size >= 1000 && !this._sessionDirs.has(sessionId)) {
      const oldest = this._sessionDirs.keys().next().value;
      this._sessionDirs.delete(oldest);
    }
    this._sessionDirs.set(sessionId, dir);
  }

  /**
   * The child's environment. `PWD` is set to the working directory: spawn() changes the directory but
   * leaves the parent's PWD, and opencode takes PWD as its project directory — with the
   * gateway's (or the shell's that started it) it fails ("Unexpected server error"), or reads
   * that directory's config instead of the tool-less one in its workspace.
   * For keysmith-owned opencode workspaces (`this._ownsOpencodeWorkspace`), every inherited
   * `OPENCODE_*` variable from the gateway's environment (`OPENCODE_PERMISSION` included) is
   * removed first, and only allow-listed `OPENCODE_*` variables (`KEYSMITH_OPENCODE_ENV_ALLOWLIST`)
   * are set: when running in a scratch directory (`runCwd !== this.cwd`),
   * `OPENCODE_DISABLE_PROJECT_CONFIG=1` suppresses `ConfigPaths.projectFiles` and project
   * `.opencode` upward walks from the scratch directory (so an ancestor `~/opencode.json` is
   * skipped), `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` point back to the adapter's workspace
   * files, and `OPENCODE_CONFIG_CONTENT` re-applies `opencode.json` after `ConfigPaths.directories`.
   */
  _childEnv(runCwd = this.cwd) {
    if (!this._ownsOpencodeWorkspace) {
      return { ...agentCleanEnv(), PWD: runCwd, ...this.env };
    }
    const baseEnv = { ...agentCleanEnv(), PWD: runCwd };
    const xdgDataHome = this.env?.XDG_DATA_HOME || baseEnv.XDG_DATA_HOME;
    let ocConfigContent = this.workspaceFiles?.['opencode.json'];
    if (typeof ocConfigContent === 'string' && ocConfigContent.trim() && xdgDataHome) {
      try {
        const parsed = JSON.parse(ocConfigContent);
        const xdgGlob = path.join(xdgDataHome, 'opencode', 'tool-output', '*');
        if (isPlainObject(parsed?.permission?.external_directory)) {
          parsed.permission.external_directory[xdgGlob] = 'deny';
        }
        if (isPlainObject(parsed?.agent?.['keysmith-text']?.permission?.external_directory)) {
          parsed.agent['keysmith-text'].permission.external_directory[xdgGlob] = 'deny';
        }
        ocConfigContent = JSON.stringify(parsed);
      } catch {}
    }
    const ocConfigEnv = {
      OPENCODE_CONFIG: path.join(this.cwd, 'opencode.json'),
      OPENCODE_CONFIG_DIR: path.join(this.cwd, '.opencode'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      ...(typeof ocConfigContent === 'string' && ocConfigContent.trim()
        ? { OPENCODE_CONFIG_CONTENT: ocConfigContent }
        : {}),
    };
    return sanitizeOpencodeEnv(baseEnv, ocConfigEnv, this.env);
  }

  _spawn({ args, stdin = null, timeoutMs }) {
    this._ensureCwd();
    const child = spawnCli(this.id, which(this.bin) || this.bin, args, { cwd: this.cwd, env: this._childEnv(this.cwd), stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (stdin != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => terminate(child, 'timeout'), timeoutMs);
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async _spawnStream({ args, stdin, timeoutMs, signal, scratchDir = null, model = null }) {
    this._ensureCwd();
    let runCwd = this.cwd;
    let cleanupCwd = null;
    if (this._ownsOpencodeWorkspace) {
      if (scratchDir) {
        ensureScratchRoot(this.id, this.cwd);
        ensurePrivateScratchDir(this.id, scratchDir, { exclusive: false });
        runCwd = realpathSync(scratchDir);
        const active = (this._activeScratchRuns.get(runCwd) || 0) + 1;
        this._activeScratchRuns.set(runCwd, active);
        let cleaned = false;
        cleanupCwd = () => {
          if (cleaned) return;
          cleaned = true;
          const left = (this._activeScratchRuns.get(runCwd) || 1) - 1;
          if (left > 0) {
            this._activeScratchRuns.set(runCwd, left);
            return;
          }
          this._activeScratchRuns.delete(runCwd);
          try {
            rmSync(runCwd, { recursive: true, force: true });
          } catch {}
        };
      } else {
        runCwd = createExclusiveScratchDir(this.id, this.cwd, 'req');
        let cleaned = false;
        cleanupCwd = () => {
          if (cleaned) return;
          cleaned = true;
          try {
            rmSync(runCwd, { recursive: true, force: true });
          } catch {}
        };
      }
    }
    let child;
    try {
      const childEnv = this._childEnv(runCwd);
      if (this._ownsOpencodeWorkspace) {
        await preflightOpencodePermissions(this, { runCwd, childEnv, mode: 'text', argv: args, signal });
      }
      if (signal?.aborted) {
        throw new LlmError(`adapter "${this.id}": client disconnected`, { status: 499, provider: this.id });
      }
      child = spawnCli(this.id, which(this.bin) || this.bin, args, {
        cwd: runCwd,
        env: childEnv,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      cleanupCwd?.();
      throw e;
    }
    if (stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    let stderr = '';
    let killed = null;
    let abortError = null;
    const stop = (why, err = null) => {
      if (killed) return;
      killed = why;
      if (err) abortError = err;
      terminate(child, why);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 64_000) stderr = keepTail(stderr, 32_000);
      if (this._isOpencode && !killed && /can only be used from within OpenCode/i.test(stderr)) {
        stop("refused by upstream: OpenCode's free tier can only be used from within OpenCode", {
          status: 502,
          retriable: false,
          message: `${this.id}: OpenCode's free tier can only be used from within OpenCode (${truncate(stderr, 200)})`,
        });
      }
    });
    let sawFirstEvent = false;
    let timedOut = null; // keysmith's own clock stopped the run: why, as its error says it
    const applyFirstEventTimeout =
      !this._firstEventTimeoutScopedToFreeTier || !model || String(model).startsWith('opencode/');
    const firstEventMs =
      applyFirstEventTimeout && Number.isFinite(this.firstEventTimeoutMs) && this.firstEventTimeoutMs > 0
        ? this.firstEventTimeoutMs
        : null;
    const firstEventTimer =
      firstEventMs && firstEventMs < timeoutMs
        ? setTimeout(() => {
            if (!sawFirstEvent) {
              const why = `no first event after ${firstEventMs}ms (opencode produced no output — possible silent 429 / Retry-After sleep)`;
              if (!killed) timedOut = why;
              stop(why);
            }
          }, firstEventMs)
        : null;
    child.stdout.on('data', (c) => {
      if (!sawFirstEvent && String(c).trim()) {
        sawFirstEvent = true;
        if (firstEventTimer) clearTimeout(firstEventTimer);
      }
    });
    const timer = setTimeout(() => {
      if (!killed) timedOut = `timeout after ${timeoutMs}ms`;
      stop(`timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    const onAbort = () => stop('client disconnected');
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = new Promise((resolve) => {
      child.on('error', (e) => {
        clearTimeout(timer);
        if (firstEventTimer) clearTimeout(firstEventTimer);
        cleanupCwd?.();
        resolve({ code: -1, stderr: e.message, killed: true, abortError });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (firstEventTimer) clearTimeout(firstEventTimer);
        signal?.removeEventListener('abort', onAbort);
        cleanupCwd?.();
        resolve({ code: killed ? -1 : code, stderr: killed ? `${stderr}\n(${killed})`.trim() : stderr, killed: !!killed, abortError });
      });
    });
    return { stdout: child.stdout, done, stop, cwd: runCwd, timedOut: () => timedOut };
  }
}

/**
 * A parser's events, with `{ type: 'usage_unknown', reason }` in front of its `done` when none of
 * them was a usage report: a run that says nothing of its tokens is said to have said nothing, so
 * no face writes a 0 for it.
 */
export async function* noteUsageGap(events, reason) {
  let seen = false;
  for await (const evt of events) {
    if (evt.type === 'usage' && evt.usage) seen = true;
    if (evt.type === 'done' && !seen) {
      seen = true;
      yield { type: 'usage_unknown', reason: reason() };
    }
    yield evt;
  }
}

/**
 * An effort for an argv template that has no `{effort}`: a 400 that says how to get one — never
 * the run without it (an adapter whose argv takes no effort anywhere is handed none: effort.js).
 * `take`: the `--take` list that brings it (CliAdapter.takeFor); the bridge's argv is `bridge`.
 */
export function effortIn(adapterId, field, tpl, effort, take = [field === 'bridge.args' ? 'bridge' : field]) {
  if (effort && !takesEffort(tpl)) {
    throw new LlmError(`adapter "${adapterId}": its ${field} has no {effort}, so this run cannot take effort "${effort}" — keysmith upgrade ${adapterId} --take ${take.join(',')} --apply brings the profile's`, { status: 400, type: 'invalid_request_error', provider: adapterId });
  }
}

/** Whether an argv template holds this token, in an optional group or not. */
function hasToken(tpl, token) {
  return Array.isArray(tpl) && tpl.flat(Infinity).includes(token);
}

/**
 * The built-in profile an entry is of when that profile changed parser (FORMER_PARSERS), judged as
 * `keysmith set` judges it — the binary's name — and only on the parser the profile runs now or
 * one it ran before: `{ name, profile, parser, token, former }`, `token` the argv token that ended
 * the former parser, `former` whether the entry runs it. Null for any other entry.
 */
function parserLineage(bin, parser) {
  const base = path.basename(String(bin));
  for (const [name, formers] of Object.entries(FORMER_PARSERS)) {
    const profile = CLI_PROFILES[name];
    if (!profile || path.basename(String(profile.bin)) !== base) continue;
    if (Object.hasOwn(formers, parser)) return { name, profile, parser, token: formers[parser], former: true };
    const tokens = Object.values(formers);
    if ((profile.parser || 'raw') === parser && tokens.length === 1) return { name, profile, parser, token: tokens[0], former: false };
  }
  return null;
}

/**
 * An entry of such a profile whose text argv and parser disagree: the token under the former parser
 * (`exec --json` read as raw — every answer codex's event stream, 200 OK), or no token under the
 * profile's (plain `exec` read as codex-json-final — every answer empty). The error names the
 * `--take` list that brings the entry whole, as `take` too, so `keysmith upgrade` can add the
 * fields it was asked for.
 */
function checkLineage(id, lineage, templates) {
  if (!lineage) return;
  const { token, former, profile } = lineage;
  const odd = templates.filter(([, t]) => hasToken(t, token) === former).map(([k]) => k);
  if (!odd.length) return;
  const lacking = templates.filter(([, t]) => !hasToken(t, token)).map(([k]) => k);
  const take = [...lacking.filter((f) => Object.hasOwn(profile, f)), ...(former ? ['parser'] : [])];
  const own = lacking.filter((f) => !Object.hasOwn(profile, f));
  const what = former
    ? `its ${odd.join(', ')} run${odd.length > 1 ? '' : 's'} \`${token}\`, whose output parser ${lineage.parser} would hand back as the answer — every reply ${lineage.name}'s event stream`
    : `its ${odd.join(', ')} run${odd.length > 1 ? '' : 's'} without \`${token}\`, and parser ${lineage.parser} reads only what \`${token}\` prints — every answer would be empty`;
  const fix = take.length ? ` — keysmith upgrade ${id} --take ${take.join(',')} --apply brings the "${lineage.name}" profile's argv and parser together` : '';
  const rest = own.length ? `${take.length ? '; ' : ' — '}the profile has no ${own.join(', ')}: give ${own.length > 1 ? 'them' : 'it'} \`${token}\` or take ${own.length > 1 ? 'them' : 'it'} out` : '';
  throw Object.assign(new Error(`adapter "${id}": ${what}${fix}${rest}`), { take });
}

/** Below this much of `timeoutMs` left, a refused run is reported instead of retried. */
const MIN_RETRY_BUDGET_MS = 15_000;

/**
 * Return the keysmith-owned 0700 scratch root (`<workspaceCwd>/../.scratch`) for an adapter
 * workspace, creating it with a non-following `mkdirSync` if absent and refusing any pre-existing
 * path that is a symlink, not a directory, not owned by `getuid()`, or not mode 0700.
 */
export function ensureScratchRoot(adapterId, workspaceCwd, { getuid = process.getuid } = {}) {
  const parent = path.dirname(path.resolve(workspaceCwd));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = path.join(parent, '.scratch');
  ensurePrivateScratchDir(adapterId, root, { exclusive: false, getuid });
  return realpathSync(root);
}

/**
 * Create or validate a 0700 scratch directory at `dir` without following symlinks.
 * When `exclusive` is true, `dir` must not already exist (`mkdirSync` without `recursive`).
 * When `exclusive` is false, a pre-existing entry is accepted only if `lstatSync` shows a
 * real directory (not a symlink) owned by `getuid()` with mode 0700.
 */
export function ensurePrivateScratchDir(adapterId, dir, { exclusive = true, getuid = process.getuid } = {}) {
  let created = false;
  try {
    mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (e) {
    if (exclusive || e?.code !== 'EEXIST') {
      throw new LlmError(`adapter "${adapterId}": could not create scratch directory ${dir}: ${e.message}`, {
        status: 500,
        provider: adapterId,
      });
    }
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    throw new LlmError(`adapter "${adapterId}": could not stat scratch directory ${dir}: ${e.message}`, {
      status: 500,
      provider: adapterId,
    });
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new LlmError(`adapter "${adapterId}": refusing scratch directory ${dir}: not a regular directory`, {
      status: 500,
      provider: adapterId,
    });
  }
  const uid = typeof getuid === 'function' ? getuid.call(process) : null;
  if (uid != null && st.uid !== uid) {
    throw new LlmError(`adapter "${adapterId}": refusing scratch directory ${dir}: owned by uid ${st.uid}, expected ${uid}`, {
      status: 500,
      provider: adapterId,
    });
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    if (created) {
      chmodSync(dir, 0o700);
    } else {
      throw new LlmError(`adapter "${adapterId}": refusing pre-existing scratch directory ${dir}: mode is 0${mode.toString(8)}, expected 0700`, {
        status: 500,
        provider: adapterId,
      });
    }
  }
  return dir;
}

/**
 * Create a fresh, unique 0700 scratch directory under `<workspaceCwd>/../.scratch` using an
 * exclusive, non-following `mkdirSync` (never `os.tmpdir()`).
 */
export function createExclusiveScratchDir(adapterId, workspaceCwd, prefix = 'req', opts = {}) {
  const root = ensureScratchRoot(adapterId, workspaceCwd, opts);
  const rand = randomBytes(12).toString('hex');
  const dir = path.join(root, `${prefix}-${adapterId}-${rand}`);
  ensurePrivateScratchDir(adapterId, dir, { exclusive: true, ...opts });
  return realpathSync(dir);
}

/**
 * spawn() for an adapter's CLI (the text path, EMULATE, the MCP bridge's driver). spawn() refuses
 * an argv holding a NUL character (U+0000) with an error that quotes the argv — the prompt with
 * it — and that message would reach the client, the gateway log and the usage row, none of which
 * may hold a prompt (design §5). So a NUL in the argv is a 400 here, before anything starts, and
 * any other error spawn() throws at once is reported by its code (startFailure), never its text.
 */
export function spawnCli(adapterId, bin, argv, opts) {
  refuseNul(adapterId, argv);
  try {
    return spawn(bin, argv, opts);
  } catch (e) {
    throw new LlmError(`adapter "${adapterId}": could not start ${path.basename(String(bin))} (${startFailure(e)})`, { status: 502, provider: adapterId });
  }
}

/** A 400 for an argv a command line cannot carry: one with a NUL character in it (from the request: a prompt, a system prompt). */
export function refuseNul(adapterId, argv) {
  if (argv.some((a) => String(a).includes('\0'))) {
    throw new LlmError(`adapter "${adapterId}": the request holds a NUL character (U+0000), which a command line cannot carry — take it out, or send the request to an HTTP upstream`, {
      status: 400,
      type: 'invalid_request_error',
      provider: adapterId,
    });
  }
}

/**
 * An error from starting a process, as a log line may print it: an error's code (with the
 * syscall and path of an fs or spawn error), never its message — Node's argument errors quote the
 * value they refused. An error with no code (a bug) is its message, cut short.
 */
export function startFailure(e) {
  if (e && typeof e === 'object' && typeof e.code === 'string' && e.code) return [e.code, e.syscall, e.path].filter((x) => typeof x === 'string' && x).join(' ');
  return truncate(String(e?.message || e), 200);
}

/**
 * Switches that hand an agent permission to act without asking, as their CLIs spell them:
 * opencode `--auto`, Command Code / Gemini CLI `--yolo`, Claude Code
 * `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox` and
 * `--full-auto`, Kiro `--trust-all-tools`, Command Code `--tools-all` / `--accept-edits`.
 * Short forms (`-a`, `-y`) are left out: too many CLIs use those letters for something else.
 */
const AUTO_APPROVE_FLAGS = new Set([
  '--auto',
  '--yolo',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--trust-all-tools',
  '--tools-all',
  '--accept-edits',
  '--approve-for-me',
]);
/**
 * A mode switch whose value is the auto-approving one. agy's `--mode auto` and
 * `--mode accept-edits` (agy 1.4.2) run the agent's tool calls without asking.
 */
const AUTO_APPROVE_MODES = {
  '--permission-mode': ['yolo', 'bypassPermissions', 'bypass_permissions', 'acceptEdits', 'accept-edits'],
  '--approval-mode': ['yolo', 'auto_edit', 'auto-edit'],
  '--sandbox': ['danger-full-access'],
  '--mode': ['auto', 'accept-edits'],
};

/**
 * The first auto-approving switch in any argv template of an adapter — `args`, `resumeArgs`,
 * `emulateArgs`, `visionArgs`, the bridge's `args` — (`--auto`, `--permission-mode yolo`,
 * `--sandbox=danger-full-access`, `--mode auto`), or null.
 */
export function autoApproveFlag(cfg) {
  const bridge = cfg?.bridge && typeof cfg.bridge === 'object' && !Array.isArray(cfg.bridge) ? cfg.bridge : null;
  for (const tpl of [cfg?.args, cfg?.resumeArgs, cfg?.emulateArgs, cfg?.visionArgs, bridge?.args]) {
    if (!Array.isArray(tpl)) continue;
    const tokens = tpl.flat(Infinity).filter((t) => typeof t === 'string');
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const eq = t.startsWith('--') ? t.indexOf('=') : -1;
      const flag = eq > 0 ? t.slice(0, eq) : t;
      if (AUTO_APPROVE_FLAGS.has(flag)) return t;
      const value = eq > 0 ? t.slice(eq + 1) : tokens[i + 1];
      if (Object.hasOwn(AUTO_APPROVE_MODES, flag) && AUTO_APPROVE_MODES[flag].includes(value)) return eq > 0 ? t : `${flag} ${value}`;
    }
  }
  return null;
}

/**
 * A model listing printed as JSON — an array, or an object holding one under `models`, `data`,
 * or `agents` (Traycer CLI `agent list`) — as `[{id, name?, contextWindow?, efforts?, defaultEffort?}]`;
 * null when the text is not that, so the line-by-line reading takes over. The id is the first of
 * `model_id` (Kiro), `id` (oz, OpenAI-shaped, Traycer agents), `slug` (Codex), `model`, `value`
 * (Claude Code), `name`; an entry marked `visibility: "hide"` or `hidden: true` is a model the CLI
 * itself keeps out of its picker, so it stays out here too. `efforts`: the reasoning efforts the
 * CLI says the model takes — Codex's `supported_reasoning_levels`, Claude Code's `supportedEffortLevels` —
 * the only place a level is ever checked against (src/effort.js). Claude Code prints its listing as
 * the answer to an `initialize` control request (stream-json on stdin): that line's `models` are read.
 */
export function jsonModelList(text) {
  const s = String(text || '').trim();
  if (!/^[[{]/.test(s)) return null;
  let v;
  try {
    v = JSON.parse(s);
    if (v?.type === 'control_response') v = controlResponse(s);
  } catch {
    v = controlResponse(s);
  }
  if (!v) return null;
  const rows = Array.isArray(v)
    ? v
    : Array.isArray(v?.models)
      ? v.models
      : Array.isArray(v?.data)
        ? v.data
        : Array.isArray(v?.agents)
          ? v.agents
          : null;
  if (!rows) return null;
  const list = [];
  for (const r of rows) {
    if (typeof r === 'string') {
      if (r.trim()) list.push({ id: r.trim() });
      continue;
    }
    if (!r || typeof r !== 'object' || r.visibility === 'hide' || r.hidden === true) continue;
    const id = [r.model_id, r.id, r.slug, r.model, r.value, r.name].find((x) => typeof x === 'string' && x.trim());
    if (!id) continue;
    const name = [r.display_name, r.displayName, r.description, r.model_name, r.name].find((x) => typeof x === 'string' && x.trim() && x !== id);
    const ctx = [r.context_window_tokens, r.context_window, r.contextWindow].find((x) => typeof x === 'number' && x > 0);
    const efforts = effortLevels(r.supported_reasoning_levels ?? r.supportedEffortLevels);
    const resolved = typeof r.resolvedModel === 'string' && r.resolvedModel.trim() && r.resolvedModel !== id ? r.resolvedModel.trim() : null;
    const defaultEffort = typeof r.default_reasoning_level === 'string' && r.default_reasoning_level ? r.default_reasoning_level : null;
    list.push({ id: id.trim(), ...(name ? { name: name.trim() } : {}), ...(ctx ? { contextWindow: ctx } : {}), ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(resolved ? { resolved } : {}) });
  }
  return list;
}

/** A listing's effort levels — strings, or `{effort}` objects (Codex) — as a list of names; null when it has none. */
function effortLevels(v) {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => (typeof x === 'string' ? x : typeof x?.effort === 'string' ? x.effort : null)).filter((x) => x && /^[a-z0-9_-]{1,32}$/i.test(x));
  return out.length ? [...new Set(out)] : null;
}

/** The `response` of a stream-json control_response line among `text`'s lines (Claude Code's answer to `initialize`), or null. */
function controlResponse(text) {
  for (const line of text.split('\n')) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type === 'control_response' && d.response && typeof d.response === 'object') return d.response.response ?? d.response;
  }
  return null;
}

/** An argv template other than `args`: a list (of strings, and of groups), or absent. */
function checkTemplate(id, field, tpl) {
  if (tpl == null) return null;
  if (!Array.isArray(tpl) || tpl.some((t) => typeof t !== 'string' && !(Array.isArray(t) && t.every((g) => typeof g === 'string')))) {
    throw new Error(`adapter "${id}": ${field} must be an argv template — a list of strings and [flag, value] groups, like args`);
  }
  return tpl;
}

/** The bridge drivers there are (src/bridge/drivers.js), by the name `bridge.driver` takes. */
export const BRIDGE_DRIVERS = ['agy', 'opencode', 'codex', 'qoder', 'claude', 'gemini', 'kimi'];

/**
 * The MCP bridge's settings on a CLI entry (src/bridge): an object; its `driver` one of
 * BRIDGE_DRIVERS (absent: agy's, for an agy-stream-json entry); its `args` an argv template; its
 * limits positive numbers (`maxSessions` and `maxTurns` whole ones); `mcpCacheDir` a path.
 *
 * An approval setting in the bridge's argv may approve the session's own server and nothing else:
 * codex's `default_tools_approval_mode` only as `mcp_servers.{server}.…`, its `approval_policy`
 * only `"never"`. Whatever the bridge's server is offered goes to keysmith, which hands it to the
 * client; an approval wider than that would let the CLI run something of its own unasked.
 */
function checkBridge(id, bridge) {
  if (bridge == null) return null;
  if (typeof bridge !== 'object' || Array.isArray(bridge)) throw new Error(`adapter "${id}": bridge must be an object of the MCP bridge's settings`);
  if (bridge.driver != null && !BRIDGE_DRIVERS.includes(bridge.driver)) throw new Error(`adapter "${id}": bridge.driver must be one of ${BRIDGE_DRIVERS.join(', ')} — got ${JSON.stringify(bridge.driver)?.slice(0, 40)}`);
  checkTemplate(id, 'bridge.args', bridge.args);
  for (const t of (bridge.args || []).flat(Infinity)) {
    if (typeof t !== 'string') continue;
    if (/default_tools_approval_mode/.test(t) && !t.startsWith('mcp_servers.{server}.default_tools_approval_mode=')) {
      throw new Error(`adapter "${id}": bridge.args may approve the session's own MCP server only (mcp_servers.{server}.default_tools_approval_mode=…) — got ${JSON.stringify(t.slice(0, 80))}`);
    }
    if (/^approval_policy\s*=/.test(t) && !/^approval_policy\s*=\s*"never"$/.test(t)) {
      throw new Error(`adapter "${id}": bridge.args sets approval_policy to something other than "never" — the CLI could run its own tools unasked`);
    }
  }
  for (const k of ['maxSessions', 'maxTurns']) {
    if (bridge[k] != null && !(Number.isInteger(bridge[k]) && bridge[k] > 0)) throw new Error(`adapter "${id}": bridge.${k} must be a whole number above 0`);
  }
  for (const k of ['toolResultTimeoutMs', 'sessionMaxMs', 'readyTimeoutMs']) {
    if (bridge[k] != null && !(Number.isFinite(bridge[k]) && bridge[k] > 0)) throw new Error(`adapter "${id}": bridge.${k} must be a number of milliseconds above 0`);
  }
  if (bridge.mcpCacheDir != null && (typeof bridge.mcpCacheDir !== 'string' || !bridge.mcpCacheDir)) throw new Error(`adapter "${id}": bridge.mcpCacheDir must be a path`);
  return bridge;
}

function checkWorkspaceFiles(id, files, ownsCwd) {
  if (files == null) return null;
  if (typeof files !== 'object' || Array.isArray(files)) throw new Error(`adapter "${id}": workspaceFiles must map a relative path to its content`);
  if (!ownsCwd) throw new Error(`adapter "${id}": workspaceFiles needs a configured cwd — keysmith only writes into a workspace it owns`);
  for (const [rel, content] of Object.entries(files)) {
    const norm = path.normalize(rel);
    if (!rel || path.isAbsolute(rel) || norm === '..' || norm.startsWith(`..${path.sep}`)) {
      throw new Error(`adapter "${id}": workspaceFiles path "${rel}" must stay inside cwd`);
    }
    if (typeof content !== 'string') throw new Error(`adapter "${id}": workspaceFiles["${rel}"] must be a string`);
  }
  return files;
}

function addUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

/** Several usage reports from one run: the gateway's rule — per-field max, never a sum. */
function maxUsage(list) {
  let out = null;
  for (const u of list) {
    if (!u) continue;
    out = out || {};
    for (const [k, v] of Object.entries(u)) if (typeof v === 'number') out[k] = Math.max(out[k] || 0, v);
  }
  return out;
}

function terminate(child) {
  try {
    child.kill('SIGTERM');
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 5_000);
    killer.unref?.();
  } catch {}
}

const _whichCache = new Map();
const _versionCache = new Map();
const _versionInFlight = new Map();
const OPENCODE_VERSION_TTL_MS = 60_000;
const OPENCODE_NEGATIVE_VERSION_TTL_MS = 5_000;
const OPENCODE_ORG_CONFIG_TTL_MS = 15_000;
const OPENCODE_ORG_CONFIG_TIMEOUT_MS = 3_000;
const _opencodeOrgConfigCache = new Map();
const _opencodeOrgConfigInFlight = new Map();
const _opencodeOrgConfigStats = { fetches: 0, hits: 0 };

function getBinStatKey(binPath) {
  if (!binPath) return null;
  try {
    const realPath = realpathSync(binPath);
    const st = statSync(realPath, { bigint: true });
    if (!st.isFile()) return null;
    return `${realPath}|ino=${st.ino}:ctimeMs=${st.ctimeMs}:ctimeNs=${st.ctimeNs}:size=${st.size}:mtimeMs=${st.mtimeMs}:mtimeNs=${st.mtimeNs}`;
  } catch {
    return null;
  }
}

function readVersionCache(binPath, now = Date.now()) {
  const statKey = getBinStatKey(binPath);
  if (!statKey) return null;
  const entry = _versionCache.get(statKey);
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    _versionCache.delete(statKey);
    return null;
  }
  return { installed: entry.installed ?? null, statKey, expiresAt: entry.expiresAt };
}

function getCachedInstalledVersion(binPath, now = Date.now()) {
  const hit = readVersionCache(binPath, now);
  return hit ? hit.installed : null;
}

export function clearOpencodeVersionCache() {
  _versionCache.clear();
  _versionInFlight.clear();
}

/**
 * Explicit allow-list of `OPENCODE_*` environment variables that keysmith sets on a
 * keysmith-owned opencode run. Every inherited `OPENCODE_*` variable from the gateway's
 * environment (`OPENCODE_PERMISSION` included) is stripped before applying this allow-list.
 */
export const KEYSMITH_OPENCODE_ENV_ALLOWLIST = new Set([
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
]);

/**
 * Strip every `OPENCODE_*` variable from `env`, then apply `overrides` keeping only
 * non-`OPENCODE_*` variables and `OPENCODE_*` variables in `KEYSMITH_OPENCODE_ENV_ALLOWLIST`.
 */
export function sanitizeOpencodeEnv(env, ...overrides) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || k.startsWith('OPENCODE_')) continue;
    out[k] = v;
  }
  for (const layer of overrides) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue;
      if (k.startsWith('OPENCODE_') && !KEYSMITH_OPENCODE_ENV_ALLOWLIST.has(k)) continue;
      out[k] = v;
    }
  }
  return out;
}
export function which(bin) {
  if (!bin) return null;
  if (_whichCache.has(bin)) return _whichCache.get(bin);
  let found = null;
  const ok = (p) => {
    try {
      const st = statSync(p);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) found = ok(expand(bin)) ? expand(bin) : null;
  else for (const dir of (process.env.PATH || '').split(':')) if (dir && ok(`${dir}/${bin}`)) { found = `${dir}/${bin}`; break; }
  _whichCache.set(bin, found);
  return found;
}

const _opencodePreflightCache = new Map();
const _opencodePreflightStats = { runs: 0, hits: 0, misses: 0 };

const OPENCODE_REQUIRED_DENY_PERMISSIONS = [
  '*',
  'read',
  'external_directory',
  'edit',
  'write',
  'apply_patch',
  'bash',
  'glob',
  'grep',
  'list',
  'webfetch',
  'websearch',
  'codesearch',
  'task',
  'skill',
  'lsp',
  'todowrite',
  'todoread',
  'question',
  'plan_enter',
  'plan_exit',
  'doom_loop',
  'mcp',
];

const MANAGED_PLIST_META_KEYS = new Set([
  'PayloadDisplayName',
  'PayloadIdentifier',
  'PayloadType',
  'PayloadUUID',
  'PayloadVersion',
  '_manualProfile',
]);

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

function isTruthyOpencodeFlag(v) {
  if (typeof v !== 'string') return false;
  const low = v.toLowerCase();
  return low === '1' || low === 'true';
}

function formatKeyPath(parts) {
  let out = '';
  for (const p of parts) {
    const s = String(p);
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(s)) {
      out = out ? `${out}.${s}` : s;
    } else {
      out = `${out}[${JSON.stringify(s)}]`;
    }
  }
  return out;
}

function stripJsonc(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inStr) {
      res += ch;
      if (ch === '\\' && j + 1 < out.length) {
        res += out[++j];
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      res += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += ch;
  }
  return res;
}

function parseJsoncText(text, sourceLabel) {
  const stripped = stripJsonc(text).trim();
  if (!stripped) return {};
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const err = new Error(`${sourceLabel}: invalid JSON/JSONC (${e.message})`);
    err.source = sourceLabel;
    err.key = 'json';
    throw err;
  }
}

function substituteOpencodeConfigVars(text, { sourceLabel, baseDir, home, env, extraFiles }) {
  const withEnv = String(text).replace(/\{env:([^}]+)\}/g, (_, name) => String(env?.[name] ?? ''));
  const matches = Array.from(withEnv.matchAll(/\{file:[^}]+\}/g));
  if (!matches.length) return withEnv;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    const tok = m[0];
    const idx = m.index;
    out += withEnv.slice(cursor, idx);
    const lineStart = withEnv.lastIndexOf('\n', idx - 1) + 1;
    if (withEnv.slice(lineStart, idx).trimStart().startsWith('//')) {
      out += tok;
      cursor = idx + tok.length;
      continue;
    }
    let rel = tok.slice(6, -1);
    if (rel.startsWith('~/')) rel = path.join(home, rel.slice(2));
    const resolved = path.isAbsolute(rel) ? rel : path.resolve(baseDir, rel);
    extraFiles?.push(resolved);
    let fileText;
    try {
      fileText = readFileSync(resolved, 'utf8').trim();
    } catch (e) {
      const err = new Error(`${sourceLabel}: bad file reference "${tok}" (${e.message})`);
      err.source = sourceLabel;
      err.key = tok;
      throw err;
    }
    out += JSON.stringify(fileText).slice(1, -1);
    cursor = idx + tok.length;
  }
  out += withEnv.slice(cursor);
  return out;
}

function unquoteYamlScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function stripYamlInlineComment(raw) {
  let inQuote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === '\\' && inQuote === '"') {
        i++;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function parseMarkdownFrontmatter(text, sourceLabel) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!/^---(?:\r?\n|$)/.test(raw)) {
    return { data: {}, content: raw.trim() };
  }
  const emptyFence = raw.match(/^---\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (emptyFence) {
    return { data: {}, content: (emptyFence[1] || '').trim() };
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!m) {
    throw new Error(`${sourceLabel}: unclosed or malformed YAML frontmatter`);
  }
  const yamlBlock = m[1];
  const body = (m[2] || '').trim();
  const root = {};
  const stack = [{ indent: -1, childIndent: null, obj: root }];
  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const leadingWs = rawLine.match(/^\s*/)[0];
    if (/[^ ]/.test(leadingWs)) {
      throw new Error(`${sourceLabel}: non-space indentation in YAML frontmatter`);
    }
    if (!rawLine.trim()) continue;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('#')) continue;
    if (/^(?:---|\.\.\.|[-?&*!%@`|>])/.test(trimmed)) {
      throw new Error(`${sourceLabel}: unsupported YAML construct in frontmatter (${trimmed.slice(0, 24)})`);
    }
    let colonIdx = -1;
    let inQuote = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inQuote) {
        if (ch === '\\' && inQuote === '"') {
          i++;
          continue;
        }
        if (ch === inQuote) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        continue;
      }
      if (ch === ':' && (i + 1 === trimmed.length || /\s/.test(trimmed[i + 1]))) {
        colonIdx = i;
        break;
      }
    }
    if (inQuote !== null || colonIdx === -1) {
      throw new Error(`${sourceLabel}: unclassifiable YAML line in frontmatter (${trimmed.slice(0, 32)})`);
    }
    const keyRaw = trimmed.slice(0, colonIdx).trim();
    if (!keyRaw) {
      throw new Error(`${sourceLabel}: empty key in YAML frontmatter`);
    }
    const keyIsQuoted = (keyRaw.startsWith('"') && keyRaw.endsWith('"')) || (keyRaw.startsWith("'") && keyRaw.endsWith("'"));
    if (!keyIsQuoted && /[{}\[\],&*!|>%@`]/.test(keyRaw)) {
      throw new Error(`${sourceLabel}: unsupported flow/complex YAML key in frontmatter (${keyRaw})`);
    }
    const valRaw = stripYamlInlineComment(trimmed.slice(colonIdx + 1));
    const indent = leadingWs.length;
    const key = String(unquoteYamlScalar(keyRaw));
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parentFrame = stack[stack.length - 1];
    if (parentFrame.childIndent === null) {
      parentFrame.childIndent = indent;
    } else if (indent !== parentFrame.childIndent) {
      throw new Error(`${sourceLabel}: inconsistent YAML indentation in frontmatter`);
    }
    const parent = parentFrame.obj;
    if (!valRaw) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, childIndent: null, obj: child });
    } else if (/^[|>&*!%@`]/.test(valRaw)) {
      throw new Error(`${sourceLabel}: unsupported YAML scalar/tag in frontmatter (${valRaw.slice(0, 24)})`);
    } else if (valRaw.startsWith('{') || valRaw.startsWith('[')) {
      parent[key] = parseJsoncText(valRaw, sourceLabel);
    } else {
      const valIsQuoted = (valRaw.startsWith('"') && valRaw.endsWith('"')) || (valRaw.startsWith("'") && valRaw.endsWith("'"));
      if (!valIsQuoted && /(?:^|\s):(?:\s|$)/.test(valRaw)) {
        throw new Error(`${sourceLabel}: ambiguous unquoted YAML value in frontmatter (${valRaw.slice(0, 24)})`);
      }
      parent[key] = unquoteYamlScalar(valRaw);
    }
  }
  return { data: root, content: body };
}

function deleteOriginPrefix(originMap, prefix) {
  for (const k of Array.from(originMap.keys())) {
    if (k === prefix || k.startsWith(`${prefix}.`) || k.startsWith(`${prefix}[`)) {
      originMap.delete(k);
    }
  }
}

function mergeDeepWithProvenance(target, patch, sourceLabel, originMap, pathParts = []) {
  const out = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const curParts = [...pathParts, k];
    const keyPath = formatKeyPath(curParts);
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeDeepWithProvenance(out[k], v, sourceLabel, originMap, curParts);
      if (!originMap.has(keyPath)) originMap.set(keyPath, sourceLabel);
    } else if (isPlainObject(v)) {
      deleteOriginPrefix(originMap, keyPath);
      originMap.set(keyPath, sourceLabel);
      out[k] = mergeDeepWithProvenance({}, v, sourceLabel, originMap, curParts);
    } else {
      deleteOriginPrefix(originMap, keyPath);
      originMap.set(keyPath, sourceLabel);
      out[k] = v;
    }
  }
  return out;
}

function lowerOpencodeV2Compat(rawObj, sourceLabel, violations) {
  if (!isPlainObject(rawObj)) return {};
  if (Object.hasOwn(rawObj, 'permissions')) {
    violations.push({ source: sourceLabel, key: 'permissions', value: rawObj.permissions });
  }
  for (const sec of ['agents', 'agent', 'mode']) {
    if (!isPlainObject(rawObj[sec])) continue;
    for (const [name, entry] of Object.entries(rawObj[sec])) {
      if (isPlainObject(entry) && Object.hasOwn(entry, 'permissions')) {
        violations.push({ source: sourceLabel, key: formatKeyPath([sec, name, 'permissions']), value: entry.permissions });
      }
    }
  }
  const out = { ...rawObj };
  if (isPlainObject(out.agents)) {
    const agent = isPlainObject(out.agent) ? { ...out.agent } : {};
    for (const [name, entry] of Object.entries(out.agents)) {
      if (Object.hasOwn(agent, name) || !isPlainObject(entry)) continue;
      const lowered = {};
      for (const k of ['description', 'mode', 'hidden', 'color', 'steps', 'permission', 'tools']) {
        if (entry[k] !== undefined) lowered[k] = entry[k];
      }
      if (entry.system !== undefined) lowered.prompt = entry.system;
      if (entry.disabled !== undefined) lowered.disable = entry.disabled;
      agent[name] = lowered;
    }
    out.agent = agent;
  }
  if (isPlainObject(out.mcp) && isPlainObject(out.mcp.servers)) {
    const mcp = { ...out.mcp };
    const servers = mcp.servers;
    delete mcp.servers;
    for (const [name, entry] of Object.entries(servers)) {
      if (Object.hasOwn(mcp, name) || !isPlainObject(entry)) continue;
      mcp[name] = { ...entry, enabled: entry.enabled ?? entry.disabled !== true };
    }
    out.mcp = mcp;
  }
  return out;
}

function walkUpTargets(startDir, targets) {
  const found = [];
  let cur = path.resolve(startDir);
  while (true) {
    for (const t of targets) {
      const candidate = path.join(cur, t);
      try {
        statSync(candidate);
        found.push(candidate);
      } catch {}
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found.reverse();
}

function scanMarkdownFiles(baseDir, subdirs, recursive = true) {
  const results = [];
  const visit = (dir, allowRecurse) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir && allowRecurse) {
        visit(full, true);
      } else if (isFile && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  };
  for (const sub of subdirs) {
    visit(path.join(baseDir, sub), recursive);
  }
  return results.sort();
}

function expandOpencodeHomePattern(pattern, home) {
  const p = String(pattern);
  if (p.startsWith('~/')) return home + p.slice(1);
  if (p === '~') return home;
  if (p.startsWith('$HOME/')) return home + p.slice(5);
  if (p.startsWith('$HOME')) return home + p.slice(5);
  return p;
}

function wildcardMatchOpencode(str, pattern) {
  const e = str ? String(str).replaceAll('\\', '/') : '';
  const o = pattern ? String(pattern).replaceAll('\\', '/') : '';
  let l = o.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (l.endsWith(' .*')) l = `${l.slice(0, -3)}( .*)?`;
  return new RegExp(`^${l}$`, 's').test(e);
}

function permissionRulesFromConfig(permObj, home, prefixParts, originMap) {
  const rules = [];
  if (!isPlainObject(permObj)) return rules;
  for (const [perm, val] of Object.entries(permObj)) {
    const keyParts = [...prefixParts, perm];
    const keyPath = formatKeyPath(keyParts);
    if (typeof val === 'string') {
      rules.push({
        permission: perm,
        pattern: '*',
        rawPattern: '*',
        action: val,
        source: originMap.get(keyPath) || originMap.get(formatKeyPath(prefixParts)) || 'opencode config',
        keyPath,
      });
    } else if (isPlainObject(val)) {
      for (const [pat, action] of Object.entries(val)) {
        const patParts = [...keyParts, pat];
        const patKeyPath = formatKeyPath(patParts);
        rules.push({
          permission: perm,
          pattern: expandOpencodeHomePattern(pat, home),
          rawPattern: pat,
          action,
          source: originMap.get(patKeyPath) || originMap.get(keyPath) || originMap.get(formatKeyPath(prefixParts)) || 'opencode config',
          keyPath: patKeyPath,
        });
      }
    }
  }
  return rules;
}

function evaluateOpencodePermission(permission, pattern, ruleset) {
  for (let i = ruleset.length - 1; i >= 0; i--) {
    const r = ruleset[i];
    if (wildcardMatchOpencode(permission, r.permission) && wildcardMatchOpencode(pattern, r.pattern)) {
      return r;
    }
  }
  return { action: 'ask', permission, pattern: '*', source: 'opencode default (unmatched -> ask)', keyPath: `${permission}["*"]` };
}

function getOpencodeVersionInfo(adapter) {
  const binPath = which(adapter?.bin) || adapter?.bin || 'opencode';
  const cachedVer = readVersionCache(binPath);
  const binStat = cachedVer ? cachedVer.statKey : getBinStatKey(binPath);
  const installed = cachedVer ? cachedVer.installed : null;
  const expected =
    typeof adapter?.verifiedVersion === 'string' && adapter.verifiedVersion.trim()
      ? adapter.verifiedVersion.trim()
      : null;
  const allowUnverified = !!adapter?.allowUnverifiedVersion;
  const versionKey = `${installed || 'unprobed'}|${expected || 'unverified'}|${allowUnverified ? 'override' : 'strict'}|${binPath}|${binStat || 'nostat'}`;
  return { binPath, binStat, installed, expected, allowUnverified, versionKey };
}

function normalizeBridgeCacheContent(text) {
  return String(text || '')
    .replace(/\bks-b-[0-9a-f]{12}\b/g, 'ks-b-SESSION')
    .replace(/\bks[0-9a-f]{6}_agent\b/g, 'ks_SESSION_agent')
    .replace(/\bks[0-9a-f]{6}_\*/g, 'ks_SESSION_*')
    .replace(/\bks[0-9a-f]{6}\b/g, 'ks_SESSION')
    .replace(/"KEYSMITH_BRIDGE_TOKEN"\s*:\s*"[^"]*"/g, '"KEYSMITH_BRIDGE_TOKEN":"<redacted>"')
    .replace(/"KEYSMITH_BRIDGE_SOCK"\s*:\s*"[^"]*"/g, '"KEYSMITH_BRIDGE_SOCK":"<redacted>"')
    .replace(/"timeout"\s*:\s*\d+/g, '"timeout":0');
}

/**
 * Internal unit-test seam (non-global Symbol, impossible to set from JSON config or env)
 * that adds simulated system managed directories/plists so tests can verify that
 * `adapter.managedConfigDir`, `adapter.managedPlistPaths`, and `KEYSMITH_TEST_OPENCODE_MANAGED_DIR`
 * never replace or mask the real system managed paths.
 */
export const TEST_ONLY_SYSTEM_MANAGED_PATHS = Symbol('keysmith.testOnly.systemManagedPaths');

const _lazyRequire = createRequire(import.meta.url);

function loadDatabaseSync() {
  const mod = _lazyRequire('node:sqlite');
  if (typeof mod?.DatabaseSync !== 'function') {
    throw new Error('node:sqlite did not export DatabaseSync');
  }
  return mod.DatabaseSync;
}

// Verified against opencode 1.19.3 AccountRepo + embedded Drizzle migrations + live sqlite_master:
// `account` (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
// and `account_state` (id, active_account_id, active_org_id; active singleton row id = 1).
const OPENCODE_DB_ACCOUNT_STATE_COLUMNS = ['id', 'active_account_id', 'active_org_id'];
const OPENCODE_DB_ACCOUNT_COLUMNS = ['id', 'email', 'url', 'access_token', 'refresh_token', 'token_expiry'];
const OPENCODE_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function normalizeOpencodeAccountUrl(rawUrl) {
  const parsed = new URL(String(rawUrl));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported Console account URL protocol "${parsed.protocol}"`);
  }
  parsed.search = '';
  parsed.hash = '';
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return cleanPath.length === 0 ? parsed.origin : `${parsed.origin}${cleanPath}`;
}

function makeOrgConfigCacheKey({ accountId, orgId, tokenExpiry, configUrl, accessToken }) {
  const tokHash = createHash('sha256').update(String(accessToken || '')).digest('hex').slice(0, 16);
  return `${accountId}|${orgId}|${tokenExpiry}|${configUrl}|${tokHash}`;
}

function getCachedOrgConfig(cacheKey, now = Date.now()) {
  const entry = _opencodeOrgConfigCache.get(cacheKey);
  if (!entry) return null;
  if (now >= entry.expiresAt) {
    _opencodeOrgConfigCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function raceWithAbortSignal(promise, signal, adapterId) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new LlmError(`adapter "${adapterId}": client disconnected`, { status: 499, provider: adapterId }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new LlmError(`adapter "${adapterId}": client disconnected`, { status: 499, provider: adapterId }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function fetchActiveOrgConfigAsync({ url, accessToken, orgId, timeoutMs = OPENCODE_ORG_CONFIG_TIMEOUT_MS }) {
  const effectiveTimeout = Math.max(1, Number(timeoutMs) || OPENCODE_ORG_CONFIG_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'x-org-id': orgId,
      },
      signal: AbortSignal.timeout(effectiveTimeout),
    });
    text = await res.text();
  } catch (e) {
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed?\s*out/i.test(e?.message || '');
    if (isTimeout) {
      return { ok: false, error: `timed out fetching active Console org config from ${url}` };
    }
    return {
      ok: false,
      error: `failed to fetch active Console org config from ${url} (${e?.cause?.message || e?.message || String(e)})`,
    };
  }
  if (res.status === 404) {
    return { ok: true, config: {} };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `active Console org config ${url} returned HTTP ${res.status}` };
  }
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `failed to decode active Console org config from ${url} (${e.message})` };
  }
  if (!isPlainObject(decoded) || !isPlainObject(decoded.config)) {
    return { ok: false, error: `malformed active Console org config payload from ${url} (expected { config: {...} })` };
  }
  return { ok: true, config: decoded.config };
}

async function resolveActiveOrgConfig(adapter, orgState, { signal = null } = {}) {
  const adapterId = adapter?.id || 'oc';
  if (signal?.aborted) {
    throw new LlmError(`adapter "${adapterId}": client disconnected`, { status: 499, provider: adapterId });
  }
  const ttlMs = Number(adapter?.orgConfigCacheTtlMs ?? OPENCODE_ORG_CONFIG_TTL_MS);
  const timeoutMs = Number(adapter?.orgConfigFetchTimeoutMs ?? OPENCODE_ORG_CONFIG_TIMEOUT_MS);
  const cacheKey = makeOrgConfigCacheKey(orgState);
  if (ttlMs > 0) {
    const hit = getCachedOrgConfig(cacheKey);
    if (hit) {
      _opencodeOrgConfigStats.hits++;
      return hit;
    }
  }
  let inFlight = _opencodeOrgConfigInFlight.get(cacheKey);
  if (!inFlight) {
    _opencodeOrgConfigStats.fetches++;
    inFlight = (async () => {
      const fetched = await fetchActiveOrgConfigAsync({
        url: orgState.configUrl,
        accessToken: orgState.accessToken,
        orgId: orgState.orgId,
        timeoutMs,
      });
      if (!fetched.ok) {
        return {
          status: 'error',
          isTransientFetchError: true,
          source: orgState.sourceLabel,
          key: 'active_org_config',
          error: fetched.error,
          cacheToken: `err:fetch:${orgState.orgId}:${createHash('sha256').update(fetched.error).digest('hex').slice(0, 16)}`,
        };
      }
      const configJson = JSON.stringify(fetched.config);
      const configHash = createHash('sha256')
        .update(`${orgState.accountId}|${orgState.orgId}|${orgState.tokenExpiry}|${orgState.configUrl}|${configJson}`)
        .digest('hex');
      const resolved = {
        status: 'active_org',
        orgId: orgState.orgId,
        accountId: orgState.accountId,
        tokenExpiry: orgState.tokenExpiry,
        configUrl: orgState.configUrl,
        sourceLabel: orgState.sourceLabel,
        configJson,
        cacheToken: `${orgState.orgId}:${configHash}`,
      };
      const now = Date.now();
      const maxExpiry = orgState.tokenExpiry - OPENCODE_TOKEN_REFRESH_BUFFER_MS;
      const expiresAt = Math.min(now + Math.max(0, ttlMs), maxExpiry);
      if (ttlMs > 0 && expiresAt > now) {
        _opencodeOrgConfigCache.set(cacheKey, { expiresAt, value: resolved });
      }
      return resolved;
    })().finally(() => {
      _opencodeOrgConfigInFlight.delete(cacheKey);
    });
    _opencodeOrgConfigInFlight.set(cacheKey, inFlight);
  }
  return raceWithAbortSignal(inFlight, signal, adapterId);
}

function inspectOpencodeOrgDb(dbPath) {
  const resolved = path.resolve(dbPath);
  try {
    lstatSync(resolved);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { status: 'absent', cacheToken: null };
    }
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: `cannot stat opencode.db (${e?.code || e?.message || 'stat_error'})`,
      cacheToken: `err:lstat:${e?.code || 'ERR'}`,
    };
  }

  let st;
  try {
    st = statSync(resolved);
  } catch (e) {
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: `cannot stat opencode.db (${e?.code || e?.message || 'stat_error'})`,
      cacheToken: `err:stat:${e?.code || 'ERR'}`,
    };
  }
  if (!st.isFile()) {
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: 'opencode.db exists but is not a regular file',
      cacheToken: 'err:not_file',
    };
  }
  if ((st.mode & 0o444) === 0) {
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: 'opencode.db is not readable (EACCES: mode has no read bits)',
      cacheToken: 'err:mode_0',
    };
  }
  try {
    accessSync(resolved, fsConstants.R_OK);
  } catch (e) {
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: `opencode.db is not readable (${e?.code || e?.message || 'EACCES'})`,
      cacheToken: `err:access:${e?.code || 'EACCES'}`,
    };
  }

  let DatabaseSync;
  try {
    DatabaseSync = loadDatabaseSync();
  } catch (e) {
    return {
      status: 'error',
      source: resolved,
      key: 'node:sqlite',
      error: `opencode.db exists but node:sqlite is unavailable (${e?.code || e?.message || String(e)})`,
      cacheToken: `err:no_sqlite:${e?.code || 'UNAVAILABLE'}`,
    };
  }

  let rows;
  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true, timeout: 0 });
    const stateInfo = db.prepare("PRAGMA table_info('account_state')").all();
    if (!Array.isArray(stateInfo) || stateInfo.length === 0) {
      return {
        status: 'error',
        source: resolved,
        key: 'opencode.db.schema',
        error: 'opencode.db lacks expected 1.19.3 table "account_state"',
        cacheToken: 'err:missing_table:account_state',
      };
    }
    const stateCols = new Set(stateInfo.map((c) => c.name));
    const missingStateCols = OPENCODE_DB_ACCOUNT_STATE_COLUMNS.filter((c) => !stateCols.has(c));
    if (missingStateCols.length > 0) {
      return {
        status: 'error',
        source: resolved,
        key: 'opencode.db.schema',
        error: `opencode.db table "account_state" lacks expected 1.19.3 columns: ${missingStateCols.join(', ')}`,
        cacheToken: `err:missing_cols:account_state:${missingStateCols.join(',')}`,
      };
    }

    const accountInfo = db.prepare("PRAGMA table_info('account')").all();
    if (!Array.isArray(accountInfo) || accountInfo.length === 0) {
      return {
        status: 'error',
        source: resolved,
        key: 'opencode.db.schema',
        error: 'opencode.db lacks expected 1.19.3 table "account"',
        cacheToken: 'err:missing_table:account',
      };
    }
    const accountCols = new Set(accountInfo.map((c) => c.name));
    const missingAccountCols = OPENCODE_DB_ACCOUNT_COLUMNS.filter((c) => !accountCols.has(c));
    if (missingAccountCols.length > 0) {
      return {
        status: 'error',
        source: resolved,
        key: 'opencode.db.schema',
        error: `opencode.db table "account" lacks expected 1.19.3 columns: ${missingAccountCols.join(', ')}`,
        cacheToken: `err:missing_cols:account:${missingAccountCols.join(',')}`,
      };
    }

    rows = db
      .prepare(
        `SELECT s.id AS state_id,
                s.active_account_id,
                s.active_org_id,
                a.id AS account_id,
                a.url AS account_url,
                a.access_token,
                a.token_expiry
           FROM account_state s
           LEFT JOIN account a ON a.id = s.active_account_id
          WHERE s.id = 1 OR (s.active_org_id IS NOT NULL AND s.active_org_id != '')
          ORDER BY CASE WHEN s.id = 1 THEN 0 ELSE 1 END, s.id`,
      )
      .all();
  } catch (e) {
    return {
      status: 'error',
      source: resolved,
      key: 'opencode.db',
      error: `cannot read opencode.db (${e?.message || String(e)})`,
      cacheToken: `err:sqlite:${e?.code || e?.message || 'ERR'}`,
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }

  for (const r of rows) {
    if (r.state_id !== 1 && r.active_account_id && r.active_org_id) {
      return {
        status: 'error',
        source: resolved,
        key: 'account_state',
        error: `unexpected active org row id=${r.state_id} in opencode.db`,
        cacheToken: `err:unexpected_row:${r.state_id}`,
      };
    }
  }

  const row1 = rows.find((r) => r.state_id === 1);
  if (!row1 || !row1.active_account_id || !row1.active_org_id) {
    return {
      status: 'no_active_org',
      cacheToken: 'no_active_org',
    };
  }

  const orgId = String(row1.active_org_id);
  if (!row1.account_id) {
    return {
      status: 'error',
      source: resolved,
      key: 'account_state.active_account_id',
      error: `active_account_id "${row1.active_account_id}" (org "${orgId}") not found in account table`,
      cacheToken: `err:dangling_account:${row1.active_account_id}:${orgId}`,
    };
  }

  let baseUrl;
  try {
    baseUrl = normalizeOpencodeAccountUrl(row1.account_url);
  } catch (e) {
    return {
      status: 'error',
      source: resolved,
      key: 'account.url',
      error: `invalid Console account URL for org "${orgId}" (${e.message})`,
      cacheToken: `err:bad_url:${orgId}`,
    };
  }

  const tokenExpiry = Number(row1.token_expiry);
  if (
    typeof row1.access_token !== 'string' ||
    !row1.access_token ||
    row1.token_expiry == null ||
    !Number.isFinite(tokenExpiry) ||
    tokenExpiry <= Date.now() + OPENCODE_TOKEN_REFRESH_BUFFER_MS
  ) {
    return {
      status: 'error',
      source: resolved,
      key: 'account.token_expiry',
      error: `active Console org "${orgId}" access token is expired or requires refresh; cannot verify ${baseUrl}/api/config`,
      cacheToken: `err:expired_token:${orgId}`,
    };
  }

  const configUrl = `${baseUrl}/api/config`;
  const sourceLabel = `${configUrl} (org ${orgId})`;
  return {
    status: 'needs_org_fetch',
    accountId: String(row1.account_id),
    orgId,
    tokenExpiry,
    accessToken: row1.access_token,
    configUrl,
    sourceLabel,
  };
}

function inspectManagedPermissionMap(permObj, prefixParts, sourceLabel, violations, allowMcpPat) {
  if (permObj === undefined) return;
  const prefixKey = formatKeyPath(prefixParts);
  if (!isPlainObject(permObj)) {
    violations.push({ source: sourceLabel, key: prefixKey, value: permObj });
    return;
  }
  for (const [permKey, permVal] of Object.entries(permObj)) {
    if (allowMcpPat && permKey === allowMcpPat && permVal === 'allow') continue;
    const keyParts = [...prefixParts, permKey];
    const keyPath = formatKeyPath(keyParts);
    if (typeof permVal === 'string') {
      if (permVal !== 'deny') {
        violations.push({ source: sourceLabel, key: keyPath, value: permVal });
      }
    } else if (isPlainObject(permVal)) {
      for (const [pat, action] of Object.entries(permVal)) {
        if (action !== 'deny') {
          violations.push({ source: sourceLabel, key: formatKeyPath([...keyParts, pat]), value: action });
        }
      }
    } else {
      violations.push({ source: sourceLabel, key: keyPath, value: permVal });
    }
  }
}

function inspectManagedSourceViolations(
  lowered,
  sourceLabel,
  violations,
  { mode, allowedMcpServer, allowedMcpPattern, bridgeAgentName },
) {
  if (!isPlainObject(lowered)) {
    violations.push({ source: sourceLabel, key: 'config', value: lowered });
    return;
  }
  const allowMcpPat = mode === 'bridge' ? allowedMcpPattern : null;
  inspectManagedPermissionMap(lowered.permission, ['permission'], sourceLabel, violations, allowMcpPat);
  if (isPlainObject(lowered.tools)) {
    for (const [toolKey, enabled] of Object.entries(lowered.tools)) {
      if (enabled !== false) {
        violations.push({ source: sourceLabel, key: formatKeyPath(['tools', toolKey]), value: enabled });
      }
    }
  }
  if (isPlainObject(lowered.mcp)) {
    for (const [serverName, serverCfg] of Object.entries(lowered.mcp)) {
      if (mode === 'bridge' && serverName === allowedMcpServer) continue;
      if (isPlainObject(serverCfg) && serverCfg.enabled !== false) {
        violations.push({ source: sourceLabel, key: formatKeyPath(['mcp', serverName]), value: 'enabled' });
      }
    }
  }
  for (const sec of ['agent', 'mode']) {
    if (!isPlainObject(lowered[sec])) continue;
    for (const [entryName, entryCfg] of Object.entries(lowered[sec])) {
      if (!isPlainObject(entryCfg)) continue;
      inspectManagedPermissionMap(
        entryCfg.permission,
        [sec, entryName, 'permission'],
        sourceLabel,
        violations,
        allowMcpPat,
      );
      if (isPlainObject(entryCfg.tools)) {
        for (const [toolName, enabled] of Object.entries(entryCfg.tools)) {
          if (enabled !== false && toolName !== 'read' && toolName !== 'invalid') {
            violations.push({
              source: sourceLabel,
              key: formatKeyPath([sec, entryName, 'tools', toolName]),
              value: enabled,
            });
          }
        }
      }
      if (entryName === 'keysmith-text' || (bridgeAgentName && entryName === bridgeAgentName)) {
        if (entryCfg.disable === true) {
          violations.push({ source: sourceLabel, key: formatKeyPath([sec, entryName, 'disable']), value: true });
        }
        if (entryCfg.mode === 'subagent') {
          violations.push({ source: sourceLabel, key: formatKeyPath([sec, entryName, 'mode']), value: 'subagent' });
        }
      }
    }
  }
}

/**
 * Resolve opencode 1.19.3's effective configuration and agent permission ruleset for `(runCwd, childEnv)`,
 * tracking the exact config source and key path for every setting and computing the SHA-256 hash of every
 * config source read (and active Console org state/config via a narrow SQLite query on `opencode.db`).
 */
export function resolveOpencodeEffectiveConfig(
  adapter,
  { runCwd, childEnv = {}, mode = 'text', argv = null, preloadedOrgDb = null } = {},
) {
  const cwd = runCwd || adapter?.cwd || process.cwd();
  const home = childEnv.OPENCODE_TEST_HOME || childEnv.HOME || os.homedir();
  const xdgConfig = childEnv.XDG_CONFIG_HOME || path.join(home, '.config');
  const globalConfigDir = path.join(xdgConfig, 'opencode');
  const xdgData = childEnv.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const globalDataDir = path.join(xdgData, 'opencode');

  // Real system managed locations are ALWAYS checked; adapter.managedConfigDir,
  // KEYSMITH_TEST_OPENCODE_MANAGED_DIR, and OPENCODE_TEST_MANAGED_CONFIG_DIR may only ADD paths,
  // never replace or mask the real system paths.
  const testSysPaths = adapter?.[TEST_ONLY_SYSTEM_MANAGED_PATHS] || null;
  const systemManagedDirs = [
    ...(process.platform === 'darwin'
      ? ['/Library/Application Support/opencode', '/etc/opencode']
      : process.platform === 'win32'
        ? [path.join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')]
        : ['/etc/opencode']),
    ...(Array.isArray(testSysPaths?.dirs) ? testSysPaths.dirs : []),
  ];
  const extraManagedDirs = [
    ...(process.platform === 'win32' && childEnv.ProgramData ? [path.join(childEnv.ProgramData, 'opencode')] : []),
    ...(adapter?.managedConfigDir ? [adapter.managedConfigDir] : []),
    ...(childEnv.KEYSMITH_TEST_OPENCODE_MANAGED_DIR ? [childEnv.KEYSMITH_TEST_OPENCODE_MANAGED_DIR] : []),
    ...(childEnv.OPENCODE_TEST_MANAGED_CONFIG_DIR ? [childEnv.OPENCODE_TEST_MANAGED_CONFIG_DIR] : []),
  ];
  const managedConfigDirs = [...new Set([...extraManagedDirs, ...systemManagedDirs].map((d) => path.resolve(d)))];
  const managedConfigDir = systemManagedDirs[0];
  const disableProjectConfig = isTruthyOpencodeFlag(childEnv.OPENCODE_DISABLE_PROJECT_CONFIG);

  let bridgeAgentName = null;
  let allowedMcpServer = null;
  let allowedMcpPattern = null;
  if (mode === 'bridge') {
    const flatArgv = Array.isArray(argv) ? argv.flat(Infinity) : [];
    const agentIdx = flatArgv.indexOf('--agent');
    if (agentIdx !== -1 && typeof flatArgv[agentIdx + 1] === 'string') {
      bridgeAgentName = flatArgv[agentIdx + 1];
      const ridMatch = bridgeAgentName.match(/^ks-b-([0-9a-f]{6})[0-9a-f]{6}$/);
      if (ridMatch) {
        allowedMcpServer = `ks${ridMatch[1]}`;
        allowedMcpPattern = `${allowedMcpServer}_*`;
      } else if (bridgeAgentName.endsWith('_agent')) {
        allowedMcpServer = bridgeAgentName.slice(0, -6);
        allowedMcpPattern = `${allowedMcpServer}_*`;
      }
    }
  }

  const candidateFiles = [];
  const fileContents = new Map();
  const sourceHashes = [];

  const readCandidateFile = (filePath, { normalizeForBridge = false } = {}) => {
    const resolved = path.resolve(filePath);
    candidateFiles.push(resolved);
    try {
      const buf = readFileSync(resolved);
      const text = buf.toString('utf8');
      fileContents.set(resolved, text);
      const hashInput = normalizeForBridge ? Buffer.from(normalizeBridgeCacheContent(text), 'utf8') : buf;
      const digest = createHash('sha256').update(hashInput).digest('hex');
      sourceHashes.push([normalizeForBridge ? '<bridge:OPENCODE_CONFIG>' : resolved, digest]);
      return text;
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        sourceHashes.push([normalizeForBridge ? '<bridge:OPENCODE_CONFIG>' : resolved, null]);
        return null;
      }
      sourceHashes.push([normalizeForBridge ? '<bridge:OPENCODE_CONFIG>' : resolved, `error:${e?.code || 'ERR'}`]);
      fileContents.set(resolved, e);
      return e;
    }
  };

  // 1. Auth wellknown
  const authJsonPath = path.join(globalDataDir, 'auth.json');
  readCandidateFile(authJsonPath);

  // 2. Global config directory files
  const globalFiles = [
    path.join(globalConfigDir, 'config.json'),
    path.join(globalConfigDir, 'opencode.json'),
    path.join(globalConfigDir, 'opencode.jsonc'),
    path.join(globalConfigDir, 'config'),
  ];
  for (const gf of globalFiles) readCandidateFile(gf);

  // 3. OPENCODE_CONFIG
  const customConfigFile = childEnv.OPENCODE_CONFIG ? path.resolve(childEnv.OPENCODE_CONFIG) : null;
  if (customConfigFile) {
    readCandidateFile(customConfigFile, { normalizeForBridge: mode === 'bridge' });
  }

  // 4. Project config files (skipped when OPENCODE_DISABLE_PROJECT_CONFIG is truthy)
  const projectFiles = !disableProjectConfig ? walkUpTargets(cwd, ['opencode.jsonc', 'opencode.json']) : [];
  for (const pf of projectFiles) readCandidateFile(pf);

  // 5. ConfigPaths.directories
  const rawDirs = [
    globalConfigDir,
    ...(!disableProjectConfig ? walkUpTargets(cwd, ['.opencode']) : []),
    ...walkUpTargets(home, ['.opencode']).filter((d) => path.dirname(d) === path.resolve(home)),
    ...(childEnv.OPENCODE_CONFIG_DIR ? [path.resolve(childEnv.OPENCODE_CONFIG_DIR)] : []),
  ];
  const configDirs = [...new Set(rawDirs.map((d) => path.resolve(d)))];
  const dirSources = [];
  for (const d of configDirs) {
    const dirJsonFiles = [];
    if (d.endsWith('.opencode') || (childEnv.OPENCODE_CONFIG_DIR && d === path.resolve(childEnv.OPENCODE_CONFIG_DIR))) {
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        const jf = path.join(d, name);
        readCandidateFile(jf);
        dirJsonFiles.push(jf);
      }
    }
    const agentMdFiles = scanMarkdownFiles(d, ['agent', 'agents'], true);
    for (const mf of agentMdFiles) readCandidateFile(mf);
    const modeMdFiles = scanMarkdownFiles(d, ['mode', 'modes'], false);
    for (const mf of modeMdFiles) readCandidateFile(mf);
    dirSources.push({ dir: d, dirJsonFiles, agentMdFiles, modeMdFiles });
  }

  // 6. Active Console org DB (narrow read-only SQLite query; async /api/config fetch is resolved before spawn)
  const dbPath = path.join(globalDataDir, 'opencode.db');
  let orgDb = preloadedOrgDb || inspectOpencodeOrgDb(dbPath);
  if (orgDb.status === 'needs_org_fetch') {
    const ttlMs = Number(adapter?.orgConfigCacheTtlMs ?? OPENCODE_ORG_CONFIG_TTL_MS);
    const cachedOrg = ttlMs > 0 ? getCachedOrgConfig(makeOrgConfigCacheKey(orgDb)) : null;
    if (cachedOrg) {
      orgDb = cachedOrg;
    } else {
      orgDb = {
        status: 'error',
        isTransientFetchError: true,
        source: orgDb.sourceLabel,
        key: 'active_org_config',
        error: `active Console org "${orgDb.orgId}" requires async preflight fetch of ${orgDb.configUrl} before spawn`,
        cacheToken: `err:sync_unfetched:${orgDb.orgId}`,
      };
    }
  }
  sourceHashes.push([`opencode.db:${path.resolve(dbPath)}`, orgDb.cacheToken]);

  // 7. System managed config directories (real system locations + any added overrides)
  const managedFiles = [];
  for (const mDir of managedConfigDirs) {
    managedFiles.push(path.join(mDir, 'opencode.json'), path.join(mDir, 'opencode.jsonc'));
  }
  for (const mf of managedFiles) readCandidateFile(mf);

  // 8. System managed preferences plists (real system locations + any added overrides)
  const osUsername = (() => {
    try {
      return os.userInfo().username || 'user';
    } catch {
      return 'user';
    }
  })();
  const plistUsernames = [...new Set([osUsername, childEnv.USER, childEnv.LOGNAME].filter(Boolean))];
  const systemManagedPlists = [
    ...(process.platform === 'darwin'
      ? [
          ...plistUsernames.map((u) => path.join('/Library/Managed Preferences', u, 'ai.opencode.managed.plist')),
          '/Library/Managed Preferences/ai.opencode.managed.plist',
        ]
      : []),
    ...(Array.isArray(testSysPaths?.plists) ? testSysPaths.plists : []),
  ];
  const extraManagedPlists = Array.isArray(adapter?.managedPlistPaths) ? adapter.managedPlistPaths : [];
  const managedPlistCandidates = [
    ...new Set([...extraManagedPlists, ...systemManagedPlists].map((pf) => path.resolve(pf))),
  ];
  for (const pf of managedPlistCandidates) readCandidateFile(pf);

  // Relevant env snapshot for cache key
  const relevantEnv = {};
  const envKeys = [
    'HOME',
    'OPENCODE_TEST_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'OPENCODE_TEST_MANAGED_CONFIG_DIR',
    'KEYSMITH_TEST_OPENCODE_MANAGED_DIR',
    'ProgramData',
    'USER',
    'LOGNAME',
  ];
  for (const k of envKeys) {
    if (childEnv[k] !== undefined) relevantEnv[k] = childEnv[k];
  }
  for (const [k, v] of Object.entries(childEnv).sort(([a], [b]) => a.localeCompare(b))) {
    if (!k.startsWith('OPENCODE_') || v === undefined) continue;
    if (mode === 'bridge' && k === 'OPENCODE_CONFIG') {
      relevantEnv[k] = '<bridge:OPENCODE_CONFIG>';
    } else if (mode === 'bridge' && k === 'OPENCODE_CONFIG_CONTENT') {
      relevantEnv[k] = normalizeBridgeCacheContent(v);
    } else {
      relevantEnv[k] = v;
    }
  }
  if (adapter?.managedConfigDir) {
    relevantEnv._adapterManagedConfigDir = adapter.managedConfigDir;
  }
  if (Array.isArray(adapter?.managedPlistPaths) && adapter.managedPlistPaths.length > 0) {
    relevantEnv._adapterManagedPlistPaths = adapter.managedPlistPaths;
  }
  if (adapter?.allowUnverifiedVersion) {
    relevantEnv._allowUnverifiedVersion = true;
  }

  const versionInfo = getOpencodeVersionInfo(adapter);
  const versionKey = versionInfo.versionKey;

  return {
    cwd,
    home,
    globalConfigDir,
    globalDataDir,
    managedConfigDir,
    managedConfigDirs,
    disableProjectConfig,
    mode,
    bridgeAgentName,
    allowedMcpServer,
    allowedMcpPattern,
    authJsonPath,
    globalFiles,
    customConfigFile,
    projectFiles,
    dirSources,
    dbPath,
    orgDb,
    managedFiles,
    managedPlistCandidates,
    fileContents,
    sourceHashes,
    relevantEnv,
    versionInfo,
    versionKey,
    readCandidateFile,
  };
}

function evaluateOpencodeSources(adapter, ctx, childEnv) {
  const {
    cwd,
    home,
    globalDataDir,
    mode,
    bridgeAgentName,
    allowedMcpServer,
    allowedMcpPattern,
    authJsonPath,
    globalFiles,
    customConfigFile,
    projectFiles,
    dirSources,
    dbPath,
    orgDb,
    managedFiles,
    managedPlistCandidates,
    fileContents,
    versionInfo,
    readCandidateFile,
  } = ctx;

  const violations = [];
  const originMap = new Map();
  let effectiveConfig = {};
  const extraReferencedFiles = [];

  // 0. Installed opencode version must be probed and match verifiedVersion unless owner explicitly overrides
  if (versionInfo && !versionInfo.allowUnverified) {
    if (!versionInfo.expected) {
      violations.push({
        source: versionInfo.binPath,
        key: 'version',
        value: `verifiedVersion is unset (installed: ${versionInfo.installed || 'unprobed'}; set allowUnverifiedVersion: true to override)`,
      });
    } else if (!versionInfo.installed) {
      violations.push({
        source: versionInfo.binPath,
        key: 'version',
        value: `unprobed/unknown !== verifiedVersion ${versionInfo.expected} (set allowUnverifiedVersion: true to override)`,
      });
    } else if (versionInfo.installed !== versionInfo.expected) {
      violations.push({
        source: versionInfo.binPath,
        key: 'version',
        value: `${versionInfo.installed} !== verifiedVersion ${versionInfo.expected} (set allowUnverifiedVersion: true to override)`,
      });
    }
  }

  const mergeJsonSource = (rawText, sourceLabel, baseDir, { inspectAsManaged = false } = {}) => {
    try {
      const substituted = substituteOpencodeConfigVars(rawText, {
        sourceLabel,
        baseDir,
        home,
        env: childEnv,
        extraFiles: extraReferencedFiles,
      });
      const parsed = parseJsoncText(substituted, sourceLabel);
      const lowered = lowerOpencodeV2Compat(parsed, sourceLabel, violations);
      if (inspectAsManaged) {
        inspectManagedSourceViolations(lowered, sourceLabel, violations, {
          mode,
          allowedMcpServer,
          allowedMcpPattern,
          bridgeAgentName,
        });
      }
      effectiveConfig = mergeDeepWithProvenance(effectiveConfig, lowered, sourceLabel, originMap);
    } catch (e) {
      violations.push({
        source: e.source || sourceLabel,
        key: e.key || 'config',
        value: e.message || String(e),
      });
    }
  };

  const mergeFileIfPresent = (filePath, { inspectAsManaged = false } = {}) => {
    const resolved = path.resolve(filePath);
    const content = fileContents.get(resolved);
    if (content === undefined || content === null) return;
    if (content instanceof Error) {
      violations.push({ source: resolved, key: 'read', value: content.code || content.message });
      return;
    }
    mergeJsonSource(content, resolved, path.dirname(resolved), { inspectAsManaged });
  };

  // 1. Auth wellknown
  let authData = null;
  let authSource = authJsonPath;
  if (childEnv.OPENCODE_AUTH_CONTENT) {
    authSource = 'OPENCODE_AUTH_CONTENT';
    try {
      authData = JSON.parse(childEnv.OPENCODE_AUTH_CONTENT);
    } catch (e) {
      violations.push({ source: 'OPENCODE_AUTH_CONTENT', key: 'json', value: e.message });
    }
  } else {
    const resolvedAuth = path.resolve(authJsonPath);
    const rawAuth = fileContents.get(resolvedAuth);
    if (rawAuth instanceof Error) {
      violations.push({ source: resolvedAuth, key: 'read', value: rawAuth.code || rawAuth.message });
    } else if (typeof rawAuth === 'string' && rawAuth.trim()) {
      try {
        authData = JSON.parse(rawAuth);
      } catch (e) {
        violations.push({ source: resolvedAuth, key: 'json', value: e.message });
      }
    }
  }
  if (isPlainObject(authData)) {
    for (const [k, entry] of Object.entries(authData)) {
      if (isPlainObject(entry) && entry.type === 'wellknown') {
        if (isPlainObject(entry.config)) {
          const lowered = lowerOpencodeV2Compat(entry.config, `${authSource} (${k})`, violations);
          effectiveConfig = mergeDeepWithProvenance(effectiveConfig, lowered, `${authSource} (${k})`, originMap);
        } else {
          violations.push({ source: authSource, key: formatKeyPath(['wellknown', k]), value: 'remote_wellknown_config' });
        }
      }
    }
  }

  // 2. Global config files
  for (const gf of globalFiles) {
    if (gf.endsWith(`${path.sep}config`)) {
      const resolvedGf = path.resolve(gf);
      const content = fileContents.get(resolvedGf);
      if (content instanceof Error) {
        violations.push({ source: resolvedGf, key: 'read', value: content.code || content.message });
      } else if (typeof content === 'string' && content.trim()) {
        violations.push({ source: resolvedGf, key: 'legacy_toml_config', value: 'present' });
      }
      continue;
    }
    mergeFileIfPresent(gf);
  }

  // 3. OPENCODE_CONFIG
  if (customConfigFile) mergeFileIfPresent(customConfigFile);

  // 4. Project config files
  for (const pf of projectFiles) mergeFileIfPresent(pf);

  // 5. ConfigPaths.directories
  for (const ds of dirSources) {
    for (const jf of ds.dirJsonFiles) mergeFileIfPresent(jf);
    for (const mf of ds.agentMdFiles) {
      const resolved = path.resolve(mf);
      const content = fileContents.get(resolved);
      if (content === undefined || content === null) continue;
      if (content instanceof Error) {
        violations.push({ source: resolved, key: 'read', value: content.code || content.message });
        continue;
      }
      try {
        const parsed = parseMarkdownFrontmatter(content, resolved);
        const rel = path.relative(ds.dir, resolved).replaceAll('\\', '/');
        const stripped = rel.startsWith('agent/') ? rel.slice(6) : rel.startsWith('agents/') ? rel.slice(7) : path.basename(rel);
        const name = stripped.endsWith('.md') ? stripped.slice(0, -3) : stripped;
        const agentObj = { name, ...parsed.data, prompt: parsed.content };
        effectiveConfig = mergeDeepWithProvenance(effectiveConfig, { agent: { [name]: agentObj } }, resolved, originMap);
      } catch (e) {
        violations.push({ source: resolved, key: 'frontmatter', value: e.message });
      }
    }
    for (const mf of ds.modeMdFiles) {
      const resolved = path.resolve(mf);
      const content = fileContents.get(resolved);
      if (content === undefined || content === null) continue;
      if (content instanceof Error) {
        violations.push({ source: resolved, key: 'read', value: content.code || content.message });
        continue;
      }
      try {
        const parsed = parseMarkdownFrontmatter(content, resolved);
        const base = path.basename(resolved, '.md');
        const modeObj = { name: base, ...parsed.data, prompt: parsed.content, mode: 'primary' };
        effectiveConfig = mergeDeepWithProvenance(effectiveConfig, { agent: { [base]: modeObj } }, resolved, originMap);
      } catch (e) {
        violations.push({ source: resolved, key: 'frontmatter', value: e.message });
      }
    }
  }

  // 6. OPENCODE_CONFIG_CONTENT
  if (childEnv.OPENCODE_CONFIG_CONTENT) {
    mergeJsonSource(childEnv.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT', cwd);
  }

  // 7. Active Console org config (fail-closed SQLite opencode.db + /api/config check)
  const resolvedDbPath = path.resolve(dbPath);
  if (orgDb?.status === 'error') {
    violations.push({
      source: orgDb.source || resolvedDbPath,
      key: orgDb.key || 'opencode.db',
      value: orgDb.error,
    });
  } else if (orgDb?.status === 'active_org') {
    mergeJsonSource(orgDb.configJson, orgDb.sourceLabel, globalDataDir);
  }

  // 8. System managed config directories (every candidate checked directly and merged; real system paths last)
  for (const mf of managedFiles) mergeFileIfPresent(mf, { inspectAsManaged: true });

  // 9. System managed preferences plists (macOS)
  for (const pf of managedPlistCandidates) {
    const resolved = path.resolve(pf);
    const content = fileContents.get(resolved);
    if (content === undefined || content === null) continue;
    if (content instanceof Error) {
      violations.push({ source: resolved, key: 'read', value: content.code || content.message });
      continue;
    }
    try {
      let jsonText = String(content);
      if (!jsonText.trim().startsWith('{')) {
        jsonText = execFileSync('plutil', ['-convert', 'json', '-o', '-', resolved], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5_000,
          encoding: 'utf8',
        });
      }
      const parsed = JSON.parse(jsonText);
      for (const k of Object.keys(parsed)) {
        if (MANAGED_PLIST_META_KEYS.has(k)) delete parsed[k];
      }
      mergeJsonSource(JSON.stringify(parsed), `mobileconfig:${resolved}`, path.dirname(resolved), {
        inspectAsManaged: true,
      });
    } catch (e) {
      violations.push({ source: `mobileconfig:${resolved}`, key: 'plist', value: e.message });
    }
  }

  // 10. Mode-to-agent lowering
  if (isPlainObject(effectiveConfig.mode)) {
    for (const [modeName, modeCfg] of Object.entries(effectiveConfig.mode)) {
      if (!isPlainObject(modeCfg)) continue;
      const modeSource = originMap.get(formatKeyPath(['mode', modeName])) || 'opencode config';
      effectiveConfig = mergeDeepWithProvenance(
        effectiveConfig,
        { agent: { [modeName]: { ...modeCfg, mode: 'primary' } } },
        modeSource,
        originMap,
      );
    }
  }

  // 11. OPENCODE_PERMISSION
  if (childEnv.OPENCODE_PERMISSION) {
    try {
      const parsedPerm = JSON.parse(childEnv.OPENCODE_PERMISSION);
      effectiveConfig = mergeDeepWithProvenance(
        effectiveConfig,
        { permission: parsedPerm },
        'OPENCODE_PERMISSION',
        originMap,
      );
    } catch (e) {
      violations.push({ source: 'OPENCODE_PERMISSION', key: 'OPENCODE_PERMISSION', value: e.message });
    }
  }

  // 12. Deprecated config.tools lowering
  if (isPlainObject(effectiveConfig.tools)) {
    for (const [toolKey, enabled] of Object.entries(effectiveConfig.tools)) {
      const permKey = toolKey === 'write' || toolKey === 'edit' || toolKey === 'patch' ? 'edit' : toolKey;
      const action = enabled ? 'allow' : 'deny';
      const toolSource = originMap.get(formatKeyPath(['tools', toolKey])) || originMap.get('tools') || 'opencode config';
      if (enabled) {
        violations.push({
          source: toolSource,
          key: formatKeyPath(['tools', toolKey]),
          value: enabled,
        });
      }
      if (!isPlainObject(effectiveConfig.permission) || !(permKey in effectiveConfig.permission)) {
        effectiveConfig = mergeDeepWithProvenance(
          { permission: { [permKey]: action } },
          effectiveConfig,
          toolSource,
          originMap,
        );
      }
    }
  }

  // Hash any extra {file:...} referenced files into sourceHashes
  for (const ef of extraReferencedFiles) {
    readCandidateFile(ef);
  }

  // Verify top-level permission object
  const checkPermissionBlock = (permBlock, prefixParts, allowMcpPat) => {
    const prefixKey = formatKeyPath(prefixParts);
    if (!isPlainObject(permBlock)) {
      violations.push({
        source: originMap.get(prefixKey) || 'opencode config',
        key: prefixKey,
        value: permBlock ?? 'missing',
      });
      return;
    }
    if (permBlock['*'] !== 'deny') {
      const starKey = formatKeyPath([...prefixParts, '*']);
      violations.push({
        source: originMap.get(starKey) || originMap.get(prefixKey) || 'opencode config',
        key: starKey,
        value: permBlock['*'] ?? 'missing',
      });
    }
    for (const reqKey of ['read', 'external_directory']) {
      if (!(reqKey in permBlock)) {
        violations.push({
          source: originMap.get(prefixKey) || 'opencode config',
          key: formatKeyPath([...prefixParts, reqKey]),
          value: 'missing',
        });
      }
    }
    for (const [permKey, permVal] of Object.entries(permBlock)) {
      if (allowMcpPat && permKey === allowMcpPat && permVal === 'allow') continue;
      const keyParts = [...prefixParts, permKey];
      const keyPath = formatKeyPath(keyParts);
      if (typeof permVal === 'string') {
        if (permVal !== 'deny') {
          violations.push({
            source: originMap.get(keyPath) || originMap.get(prefixKey) || 'opencode config',
            key: keyPath,
            value: permVal,
          });
        }
      } else if (isPlainObject(permVal)) {
        for (const [pat, action] of Object.entries(permVal)) {
          const patKeyPath = formatKeyPath([...keyParts, pat]);
          if (action !== 'deny') {
            violations.push({
              source: originMap.get(patKeyPath) || originMap.get(keyPath) || originMap.get(prefixKey) || 'opencode config',
              key: patKeyPath,
              value: action,
            });
          }
        }
        if (permVal['*'] !== 'deny') {
          const starPatKey = formatKeyPath([...keyParts, '*']);
          violations.push({
            source: originMap.get(starPatKey) || originMap.get(keyPath) || originMap.get(prefixKey) || 'opencode config',
            key: starPatKey,
            value: permVal['*'] ?? 'missing',
          });
        }
      } else {
        violations.push({
          source: originMap.get(keyPath) || originMap.get(prefixKey) || 'opencode config',
          key: keyPath,
          value: permVal,
        });
      }
    }
  };

  checkPermissionBlock(effectiveConfig.permission, ['permission'], mode === 'bridge' ? allowedMcpPattern : null);

  // Check MCP servers
  if (isPlainObject(effectiveConfig.mcp)) {
    for (const [serverName, serverCfg] of Object.entries(effectiveConfig.mcp)) {
      if (mode === 'bridge' && serverName === allowedMcpServer) continue;
      if (isPlainObject(serverCfg) && serverCfg.enabled !== false) {
        const mcpKey = formatKeyPath(['mcp', serverName]);
        violations.push({
          source: originMap.get(mcpKey) || originMap.get('mcp') || 'opencode config',
          key: mcpKey,
          value: 'enabled',
        });
      }
    }
  }

  // Check target agents
  const targetAgents =
    mode === 'bridge' && bridgeAgentName
      ? [
          { name: bridgeAgentName, allowMcpPat: allowedMcpPattern },
          ...(isPlainObject(effectiveConfig.agent?.['keysmith-text'])
            ? [{ name: 'keysmith-text', allowMcpPat: allowedMcpPattern }]
            : []),
        ]
      : [{ name: 'keysmith-text', allowMcpPat: null }];

  const truncateGlob = path.join(globalDataDir, 'tool-output', '*');
  const tmpGlob = path.join(os.tmpdir(), 'opencode', '*');
  const agentRulesets = {};

  for (const { name: agentName, allowMcpPat } of targetAgents) {
    const agentCfg = effectiveConfig.agent?.[agentName];
    const agentKey = formatKeyPath(['agent', agentName]);
    if (!isPlainObject(agentCfg)) {
      violations.push({
        source: originMap.get('agent') || 'opencode config',
        key: agentKey,
        value: 'missing',
      });
      continue;
    }
    if (agentCfg.disable === true) {
      const disKey = formatKeyPath(['agent', agentName, 'disable']);
      violations.push({
        source: originMap.get(disKey) || originMap.get(agentKey) || 'opencode config',
        key: disKey,
        value: true,
      });
    }
    if (agentCfg.mode === 'subagent') {
      const modeKey = formatKeyPath(['agent', agentName, 'mode']);
      violations.push({
        source: originMap.get(modeKey) || originMap.get(agentKey) || 'opencode config',
        key: modeKey,
        value: 'subagent',
      });
    }
    if (isPlainObject(agentCfg.tools)) {
      for (const [toolName, enabled] of Object.entries(agentCfg.tools)) {
        if (enabled !== false && toolName !== 'read' && toolName !== 'invalid') {
          const toolKey = formatKeyPath(['agent', agentName, 'tools', toolName]);
          violations.push({
            source: originMap.get(toolKey) || originMap.get(agentKey) || 'opencode config',
            key: toolKey,
            value: enabled,
          });
        }
      }
    }

    checkPermissionBlock(agentCfg.permission, ['agent', agentName, 'permission'], allowMcpPat);

    // Construct Agent.state effective permission ruleset
    const defaultOrigin = new Map([['defaults', 'Agent.state defaults']]);
    const baseRules = permissionRulesFromConfig(
      {
        '*': 'allow',
        doom_loop: 'ask',
        external_directory: {
          '*': 'ask',
          [truncateGlob]: 'allow',
          [tmpGlob]: 'allow',
        },
        question: 'deny',
        plan_enter: 'deny',
        plan_exit: 'deny',
        read: {
          '*': 'allow',
          '*.env': 'ask',
          '*.env.*': 'ask',
          '*.env.example': 'allow',
        },
      },
      home,
      ['defaults'],
      defaultOrigin,
    );
    const configRules = permissionRulesFromConfig(effectiveConfig.permission, home, ['permission'], originMap);
    const agentRules = permissionRulesFromConfig(agentCfg.permission, home, ['agent', agentName, 'permission'], originMap);
    const ruleset = [...baseRules, ...configRules, ...agentRules];
    if (
      !ruleset.some(
        (r) => r.permission === 'external_directory' && r.action === 'deny' && r.pattern === truncateGlob,
      )
    ) {
      ruleset.push({
        permission: 'external_directory',
        pattern: truncateGlob,
        rawPattern: truncateGlob,
        action: 'allow',
        source: 'Agent.state (Truncate.GLOB)',
        keyPath: formatKeyPath(['agent', agentName, 'permission', 'external_directory', truncateGlob]),
      });
    }
    agentRulesets[agentName] = ruleset;

    // Every rule after baseRules must be 'deny' (except allowMcpPat on the bridge agent)
    for (const r of ruleset.slice(baseRules.length)) {
      if (allowMcpPat && r.permission === allowMcpPat && r.action === 'allow') continue;
      if (r.action !== 'deny') {
        violations.push({
          source: r.source,
          key: r.keyPath,
          value: r.action,
        });
      }
    }

    // Evaluate all permissions across all patterns in the ruleset + sample probe targets
    const allPerms = new Set([
      ...OPENCODE_REQUIRED_DENY_PERMISSIONS,
      ...Object.keys(effectiveConfig.permission || {}),
      ...Object.keys(agentCfg.permission || {}),
      ...Object.keys(effectiveConfig.tools || {}),
      ...Object.keys(agentCfg.tools || {}),
      ...Object.keys(effectiveConfig.mcp || {}),
      ...ruleset.map((r) => r.permission),
    ]);
    const allPatterns = new Set([
      '*',
      '',
      '/etc/hosts',
      './inside.txt',
      truncateGlob,
      tmpGlob,
      ...ruleset.map((r) => r.pattern),
      ...ruleset.map((r) => r.rawPattern).filter(Boolean),
    ]);
    for (const perm of allPerms) {
      if (allowMcpPat && (perm === allowMcpPat || perm === allowedMcpServer)) continue;
      for (const pat of allPatterns) {
        const matched = evaluateOpencodePermission(perm, pat, ruleset);
        if (matched.action !== 'deny') {
          violations.push({
            source: matched.source || 'opencode config',
            key: matched.keyPath || formatKeyPath(['agent', agentName, 'permission', perm, pat]),
            value: matched.action,
          });
        }
      }
    }
  }

  // Deduplicate violations by source + key
  const uniqueViolations = [];
  const seen = new Set();
  for (const v of violations) {
    const id = `${v.source}::${v.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueViolations.push(v);
  }

  return {
    effectiveConfig,
    agentRulesets,
    originMap,
    violations: uniqueViolations,
  };
}

function createOpencodePreflightError(adapterId, violations, agentName = 'keysmith-text') {
  const details = violations
    .slice(0, 4)
    .map((v) => `${v.source} sets ${v.key} = ${JSON.stringify(v.value)}`)
    .join('; ');
  const err = new LlmError(
    `adapter "${adapterId}": opencode effective permission preflight failed — ${details} (every tool permission for ${agentName} must resolve to "deny" for all patterns)`,
    {
      status: 502,
      provider: adapterId,
    },
  );
  err.preflightViolations = violations;
  err.noFallback = true;
  return err;
}

/**
 * Preflight check on opencode's effective permissions and verified CLI version before spawning `opencode`.
 * Asynchronously probes `opencode --version` (unless cached or `probeVersion: false`) and fetches any active
 * Console org `/api/config` (briefly cached by `(account, org, tokenExpiry)` without blocking the event loop),
 * then computes opencode's effective config and agent permission ruleset as the run will see it
 * (`runCwd`, `childEnv`), caches the result keyed by `(opencode version, hashes of all config sources read +
 * active-org config, env)`, and refuses the run with a 502 `LlmError` naming the offending source and key.
 */
export async function preflightOpencodePermissions(
  adapter,
  { runCwd, childEnv = {}, mode = 'text', argv = null, signal = null, probeVersion = true } = {},
) {
  const adapterId = adapter?.id || 'oc';
  if (signal?.aborted) {
    throw new LlmError(`adapter "${adapterId}": client disconnected`, { status: 499, provider: adapterId });
  }
  let probedVersionThisCall = false;
  if (probeVersion && typeof adapter?._probeInstalledVersion === 'function') {
    const binPath = which(adapter.bin);
    if (binPath && !readVersionCache(binPath)) {
      probedVersionThisCall = true;
      await raceWithAbortSignal(adapter._probeInstalledVersion(), signal, adapterId);
    }
  }

  const home = childEnv.OPENCODE_TEST_HOME || childEnv.HOME || os.homedir();
  const xdgData = childEnv.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dbPath = path.join(xdgData, 'opencode', 'opencode.db');
  let preloadedOrgDb = inspectOpencodeOrgDb(dbPath);
  if (preloadedOrgDb.status === 'needs_org_fetch') {
    preloadedOrgDb = await resolveActiveOrgConfig(adapter, preloadedOrgDb, { signal });
  }

  const computePreflightKey = (c) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          version: c.versionKey,
          mode: c.mode,
          sources: c.sourceHashes,
          env: c.relevantEnv,
        }),
      )
      .digest('hex');

  let ctx = resolveOpencodeEffectiveConfig(adapter, { runCwd, childEnv, mode, argv, preloadedOrgDb });
  let preCacheKey = computePreflightKey(ctx);

  if (_opencodePreflightCache.has(preCacheKey)) {
    const cached = _opencodePreflightCache.get(preCacheKey);
    // Verify any extra {file:...} referenced files haven't changed either
    let extraChanged = false;
    if (cached.extraFiles?.length) {
      for (const [efPath, oldHash] of cached.extraFiles) {
        let curHash = null;
        try {
          curHash = createHash('sha256').update(readFileSync(efPath)).digest('hex');
        } catch (e) {
          curHash = e?.code === 'ENOENT' ? null : `error:${e?.code || 'ERR'}`;
        }
        if (curHash !== oldHash) {
          extraChanged = true;
          break;
        }
      }
    }
    if (!extraChanged) {
      _opencodePreflightStats.hits++;
      if (adapter) adapter._preflightHits = (adapter._preflightHits || 0) + 1;
      if (!cached.ok) {
        throw createOpencodePreflightError(adapterId, cached.violations, cached.agentName);
      }
      return cached;
    }
  }

  // Re-probe `--version` whenever the preflight cache misses and we used a cached positive version
  // (respecting any fresh negative-version cache entry so failed/unrecognised probes are not respawned per request).
  if (probeVersion && !probedVersionThisCall && typeof adapter?._probeInstalledVersion === 'function') {
    const binPath = which(adapter.bin);
    const cachedVer = binPath ? readVersionCache(binPath) : null;
    if (binPath && (!cachedVer || cachedVer.installed !== null)) {
      const prevInstalled = ctx.versionInfo?.installed ?? null;
      const prevStat = ctx.versionInfo?.binStat ?? null;
      const freshInstalled = await raceWithAbortSignal(
        adapter._probeInstalledVersion({ force: true }),
        signal,
        adapterId,
      );
      const freshStat = getBinStatKey(binPath);
      if (freshInstalled !== prevInstalled || freshStat !== prevStat) {
        ctx = resolveOpencodeEffectiveConfig(adapter, { runCwd, childEnv, mode, argv, preloadedOrgDb });
        preCacheKey = computePreflightKey(ctx);
      }
    }
  }

  _opencodePreflightStats.misses++;
  _opencodePreflightStats.runs++;
  if (adapter) adapter._preflightRuns = (adapter._preflightRuns || 0) + 1;

  const baseSourceCount = ctx.sourceHashes.length;
  const evaluated = evaluateOpencodeSources(adapter, ctx, childEnv);
  const extraFiles = ctx.sourceHashes.slice(baseSourceCount);
  const agentName = mode === 'bridge' && ctx.bridgeAgentName ? ctx.bridgeAgentName : 'keysmith-text';
  const entry = {
    ok: evaluated.violations.length === 0,
    violations: evaluated.violations,
    agentName,
    effectiveConfig: evaluated.effectiveConfig,
    agentRulesets: evaluated.agentRulesets,
    cacheKey: preCacheKey,
    extraFiles,
  };
  if (ctx.versionInfo?.binStat && !ctx.orgDb?.isTransientFetchError) {
    _opencodePreflightCache.set(preCacheKey, entry);
  }

  if (!entry.ok) {
    throw createOpencodePreflightError(adapterId, entry.violations, agentName);
  }
  return entry;
}

export function getOpencodePreflightStats() {
  return { ..._opencodePreflightStats, cacheSize: _opencodePreflightCache.size };
}

export function getOpencodeOrgConfigStats() {
  return { ..._opencodeOrgConfigStats, cacheSize: _opencodeOrgConfigCache.size };
}

export function clearOpencodePreflightCache() {
  _opencodePreflightCache.clear();
  _opencodePreflightStats.runs = 0;
  _opencodePreflightStats.hits = 0;
  _opencodePreflightStats.misses = 0;
  _opencodeOrgConfigCache.clear();
  _opencodeOrgConfigInFlight.clear();
  _opencodeOrgConfigStats.fetches = 0;
  _opencodeOrgConfigStats.hits = 0;
}
