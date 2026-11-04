import { statSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getParser, toLines } from './parsers.js';
import { expand } from './config.js';
import { LlmError, flattenMessages, joinArgs, Semaphore, truncate, keepTail, agentCleanEnv } from './util.js';
import { checkToolMode } from './tools/router.js';
import { checkMedia, hasMedia, mediaPrompt } from './media.js';
import { takesEffort } from './effort.js';
import { CLI_PROFILES, FORMER_PARSERS } from './profiles.js';

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
    // One more attempt, with this instruction in front of the prompt, when a run ends in a
    // refused tool call and no text (a parser `error` event with code 'tool_denied').
    this.toolDenialRetry = typeof cfg.toolDenialRetry === 'string' && cfg.toolDenialRetry.trim() ? cfg.toolDenialRetry.trim() : null;
    // For a CLI run as a text model: once the answer has text, the first tool call ends it.
    // A harness can keep a tool of its own that no agent definition removes (agy:
    // `manage_task`), and a model that calls it after answering answers again, and again.
    // `'always'` ends the run at a tool call before any text too, and fails the request: for
    // a CLI whose tools could not be taken away (Warp), a tool call is never the way to an answer.
    this.stopAtToolCall = cfg.stopAtToolCall === 'always' ? 'always' : !!cfg.stopAtToolCall;
    // What `{noSession}` renders as when the run is not resumed. CLIs disagree on the spelling:
    // Command Code takes `--no-session`, Claude Code and Qoder refuse it and take
    // `--no-session-persistence`.
    this.noSessionFlag = typeof cfg.noSessionFlag === 'string' ? cfg.noSessionFlag : '--no-session';
    // A CLI whose tools keysmith could not take away: it can run commands and edit files.
    // Never an alias leg, never probed by `doctor --probe-models` (see Gateway.resolve).
    this.unsafeTools = !!cfg.unsafeTools;
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
    this.priority = cfg.priority ?? 200;
    this.disabled = !!cfg.disabled;
    this.stripSystemPrompt = !!cfg.stripSystemPrompt;
    this.systemFlag = cfg.systemFlag || null;
    this.maxPromptChars = cfg.maxPromptChars ?? 200_000;
    this.modelsFrom = cfg.modelsFrom || null;
    this.declaredModels = cfg.models || null;
    this.defaultModel = cfg.defaultModel || null;
    this.note = cfg.note || null;
    this._sem = new Semaphore(cfg.maxConcurrent ?? 1);
    this._modelCache = null;
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
  emulateRun({ text, model, effort = null, timeoutMs, signal }) {
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
    const run = this._spawnStream({ args: argv, stdin: this.promptVia === 'stdin' ? text : null, timeoutMs, signal });
    return { events: getParser(this.parser)(toLines(run.stdout)), stop: run.stop, done: run.done };
  }

  /**
   * One completion. `rendered` ({ system, prompt }) is a prompt a tool engine wrote itself in
   * place of the flattened `messages` (router.js, tool_choice none); such a run is never resumed.
   */
  async *complete({ model, messages, session, signal, maxTokens, effort = null, rendered = null }) {
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
        const run = this._spawnStream({
          args: argvFor(text),
          stdin: stdinFor(text),
          timeoutMs: Math.max(1_000, deadline - Date.now()),
          signal,
        });
        let emitted = false;
        // While a run may still be retried, everything but text is held back: a refused run's
        // session, usage and error must not reach the client if a second run replaces it.
        // The first text delta proves there is an answer, so the held events go out in order.
        const held = [];
        let carriedSent = false;
        let cut = null; // the tool call the answer was ended at
        let blocked = null; // a tool call before any text, stopped (`stopAtToolCall: 'always'`)
        for await (let evt of noteUsageGap(parse(toLines(run.stdout)), () => this.usageGap())) {
          if (evt.type === 'tool') {
            // Before any text the call may be how the model gets to its answer, so the run
            // goes on. After text, the answer exists: stop the process instead of letting
            // it loop until its own timeout, and keep whatever it says next out of the reply.
            if (this.stopAtToolCall && emitted && !cut) {
              cut = evt.name || 'a tool';
              run.stop(`answer complete, stopped at a call to ${cut}`);
              yield { type: 'cut', reason: 'tool_call', tool: cut };
            } else if (this.stopAtToolCall === 'always' && !emitted && !cut) {
              // A CLI that kept its tools: a call is stopped wherever it comes. The harness
              // may have started it already — this is a limit on the damage, not a sandbox.
              cut = blocked = evt.name || 'a tool';
              run.stop(`stopped at a call to ${cut}: this adapter may not run tools`);
            }
            continue;
          }
          if (cut && (evt.type === 'delta' || evt.type === 'error')) continue;
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
        if (blocked && !emitted) {
          throw new LlmError(`adapter "${this.id}": the agent started a tool call (${blocked}) before answering, and keysmith stopped the run — this adapter may not run tools`, {
            status: 502,
            provider: this.id,
          });
        }
        if (outcome.code !== 0 && !emitted) {
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

  /**
   * The child's environment. `PWD` is set to the workspace: spawn() changes the directory but
   * leaves the parent's PWD, and opencode takes PWD as its project directory — with the
   * gateway's (or the shell's that started it) it fails ("Unexpected server error"), or reads
   * that directory's config instead of the tool-less one in its workspace.
   */
  _childEnv() {
    return { ...agentCleanEnv(), PWD: this.cwd, ...this.env };
  }

  _spawn({ args, stdin = null, timeoutMs }) {
    this._ensureCwd();
    const child = spawnCli(this.id, which(this.bin) || this.bin, args, { cwd: this.cwd, env: this._childEnv(), stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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

  _spawnStream({ args, stdin, timeoutMs, signal }) {
    this._ensureCwd();
    const child = spawnCli(this.id, which(this.bin) || this.bin, args, {
      cwd: this.cwd,
      env: this._childEnv(),
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 64_000) stderr = keepTail(stderr, 32_000);
    });
    let killed = null;
    const stop = (why) => {
      if (killed) return;
      killed = why;
      terminate(child, why);
    };
    const timer = setTimeout(() => stop(`timeout after ${timeoutMs}ms`), timeoutMs);
    const onAbort = () => stop('client disconnected');
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = new Promise((resolve) => {
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stderr: e.message, killed: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code: killed ? -1 : code, stderr: killed ? `${stderr}\n(${killed})`.trim() : stderr, killed: !!killed });
      });
    });
    return { stdout: child.stdout, done, stop };
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
 * A model listing printed as JSON — an array, or an object holding one under `models` or
 * `data` — as `[{id, name?, contextWindow?, efforts?, defaultEffort?}]`; null when the text is
 * not that, so the line-by-line reading takes over. The id is the first of `model_id` (Kiro), `id`
 * (oz, OpenAI-shaped), `slug` (Codex), `model`, `value` (Claude Code), `name`; an entry marked
 * `visibility: "hide"` or `hidden: true` is a model the CLI itself keeps out of its picker, so it
 * stays out here too. `efforts`: the reasoning efforts the CLI says the model takes — Codex's
 * `supported_reasoning_levels`, Claude Code's `supportedEffortLevels` — the only place a level is
 * ever checked against (src/effort.js). Claude Code prints its listing as the answer to an
 * `initialize` control request (stream-json on stdin): that line's `models` are read.
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
  const rows = Array.isArray(v) ? v : Array.isArray(v?.models) ? v.models : Array.isArray(v?.data) ? v.data : null;
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
    const name = [r.display_name, r.displayName, r.description, r.model_name].find((x) => typeof x === 'string' && x.trim() && x !== id);
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
