import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getParser, toLines } from './parsers.js';
import { expand } from './config.js';
import { LlmError, flattenMessages, joinArgs, Semaphore, truncate, agentCleanEnv } from './util.js';

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
    // one model per line with an optional description after two or more spaces.
    // A row only counts as a model if its first token is id-shaped and carries a
    // slash, digit or dot — that is what separates `gpt-5.4` from `Google`.
    const MODELISH = /^[a-z0-9][a-z0-9._+\-/]*$/i;
    const list = [];
    for (const line of (out.stdout || out.stderr).split('\n')) {
      const m = line.trim().match(/^(\S+)(?:\s{2,}(.+))?$/);
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
    const argv = joinArgs(useResume ? this.resumeArgs : this.args, {
      model: model || '',
      prompt: this.promptVia === 'stdin' ? '' : body,
      system: keepSystem ? system || '' : '',
      session: useResume ? session : '',
      noSession: this.persistSessions || useResume ? '' : '--no-session',
      maxTokens: maxTokens || '',
    });
    if (this.systemFlag && keepSystem && system) argv.push(...this.systemFlag.split(/\s+/), system);

    const release = await this._sem.acquire();
    try {
      const run = this._spawnStream({ args: argv, stdin: this.promptVia === 'stdin' ? body : null, timeoutMs: this.timeoutMs, signal });
      const parse = getParser(this.parser);
      let emitted = false;
      for await (const evt of parse(toLines(run.stdout))) {
        if (evt.type === 'delta' && evt.text) emitted = true;
        yield evt;
      }
      const outcome = await run.done;
      if (outcome.code !== 0 && !emitted) {
        throw new LlmError(
          `${this.id} exited ${outcome.code}${outcome.killed ? ' (killed)' : ''}: ${truncate(outcome.stderr || outcome.error || 'no output', 300)}`,
          { status: outcome.killed ? 504 : 502, provider: this.id, retriable: !!outcome.killed },
        );
      }
    } finally {
      release();
    }
  }

  _spawn({ args, timeoutMs }) {
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
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
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
    return { stdout: child.stdout, done };
  }
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
