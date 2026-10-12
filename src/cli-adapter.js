import { statSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getParser, toLines } from './parsers.js';
import { expand } from './config.js';
import { LlmError, flattenMessages, joinArgs, Semaphore, truncate, keepTail, agentCleanEnv } from './util.js';

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
 *  - A CLI is an agent: uncapped, it will start calling tools and editing files.
 *    Profiles pass a turn cap (`--max-turns 1`) so the call stays a completion.
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
    this.stopAtToolCall = !!cfg.stopAtToolCall;
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
    if (!which(this.bin)) throw new LlmError(`${this.bin} is not on PATH`, { status: 503, provider: this.id });
    const spec = this.modelsFrom;
    const out = await this._spawn({ args: spec.args || ['--list-models'], timeoutMs: spec.timeoutMs ?? 30_000 });
    if (out.code !== 0) throw new LlmError(`${this.bin} ${spec.args?.join(' ')} exited ${out.code}: ${truncate(out.stderr, 160)}`, { status: 502, provider: this.id });
    // CLIs print their picker verbatim: section headers ("Open Source"), counts, and
    // one model per line with an optional description after two or more spaces or a
    // tab (`agy models` prints `id<TAB>Display Name`).
    // A row only counts as a model if its first token is id-shaped and carries a
    // slash, digit or dot — that is what separates `gpt-5.4` from `Google`.
    const MODELISH = /^[a-z0-9][a-z0-9._+\-/]*$/i;
    const list = [];
    for (const line of (out.stdout || out.stderr).split('\n')) {
      const m = line.trim().match(/^(\S+)(?:(?:\t|\s{2,})\s*(.+))?$/);
      if (!m) continue;
      const id = m[1];
      if (!MODELISH.test(id) || !/[\/\d.]/.test(id)) continue;
      if (spec.drop?.some((d) => id.startsWith(d))) continue;
      list.push({ id, ...(m[2] ? { name: m[2].trim() } : {}) });
    }
    this._modelCache = { at: Date.now(), list };
    return list;
  }

  async *complete({ model, messages, session, signal, maxTokens }) {
    if (this.disabled) throw new LlmError(`adapter "${this.id}" is disabled`, { status: 503, provider: this.id });
    if (!which(this.bin)) throw new LlmError(`adapter "${this.id}": "${this.bin}" is not on PATH`, { status: 503, provider: this.id });

    const { system, prompt } = flattenMessages(messages);
    if (!prompt && !system) throw new LlmError('nothing to send: the message list is empty after flattening', { status: 400, provider: this.id });
    if (prompt.length > this.maxPromptChars) {
      throw new LlmError(
        `adapter "${this.id}": prompt is ${prompt.length} chars, over maxPromptChars=${this.maxPromptChars}. Trim history, or raise the cap on this adapter.`,
        { status: 400, provider: this.id },
      );
    }
    const keepSystem = !this.stripSystemPrompt;
    const body = keepSystem && system && !this.systemFlag ? `<system>\n${system}\n</system>\n\n${prompt}` : prompt;
    const useResume = !!(session && this.resumable);
    const argvFor = (text) => {
      const argv = joinArgs(useResume ? this.resumeArgs : this.args, {
        model: model || '',
        prompt: this.promptVia === 'stdin' ? '' : text,
        system: keepSystem ? system || '' : '',
        session: useResume ? session : '',
        noSession: this.persistSessions || useResume ? '' : '--no-session',
        maxTokens: maxTokens || '',
      });
      if (this.systemFlag && keepSystem && system) argv.push(...this.systemFlag.split(/\s+/), system);
      return argv;
    };

    const release = await this._sem.acquire();
    // A request can wait here longer than its client does (a curl --speed-time guard, a
    // closed tab). Its abort already fired, and an AbortSignal does not re-fire for a late
    // listener — spawning now would run a whole agent for nobody while holding the slot.
    if (signal?.aborted) {
      release();
      throw new LlmError(`adapter "${this.id}": client disconnected while queued for a free process`, { status: 499, provider: this.id });
    }
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
          stdin: this.promptVia === 'stdin' ? text : null,
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
        for await (let evt of parse(toLines(run.stdout))) {
          if (evt.type === 'tool') {
            // Before any text the call may be how the model gets to its answer, so the run
            // goes on. After text, the answer exists: stop the process instead of letting
            // it loop until its own timeout, and keep whatever it says next out of the reply.
            if (this.stopAtToolCall && emitted && !cut) {
              cut = evt.name || 'a tool';
              run.stop(`answer complete, stopped at a call to ${cut}`);
              yield { type: 'cut', reason: 'tool_call', tool: cut };
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

  _spawn({ args, timeoutMs }) {
    this._ensureCwd();
    return new Promise((resolve) => {
      const child = spawn(which(this.bin) || this.bin, args, { cwd: this.cwd, env: { ...agentCleanEnv(), ...this.env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const child = spawn(which(this.bin) || this.bin, args, {
      cwd: this.cwd,
      env: { ...agentCleanEnv(), ...this.env },
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

/** Below this much of `timeoutMs` left, a refused run is reported instead of retried. */
const MIN_RETRY_BUDGET_MS = 15_000;

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
