import fs from 'node:fs';
import path from 'node:path';
import { getParser, toLines } from '../parsers.js';
import { agentCleanEnv, keepTail } from '../util.js';
import { spawnCli, which } from '../cli-adapter.js';
import { redactSecrets } from '../redact.js';

/**
 * What every bridge driver shares (agy.js, clis.js): one CLI run as a process group of its own,
 * the session's files written 0600 into a directory keysmith owns, and their removal.
 *
 * A bridge session's CLI is spawned detached, so it leads a process group, and the MCP server it
 * starts (the shim) is in that group: stopping a session is SIGTERM to the group, then SIGKILL to
 * whatever of it is left `killGraceMs` later — and once the leader is gone, at once.
 */

/** After SIGTERM to the process group, SIGKILL this much later if anything of it is left. */
export const KILL_GRACE_MS = 5_000;

/**
 * Start `argv` of `adapter` as a process group in its workspace: `env` the child's environment,
 * `stdinText` piped in when the adapter takes its prompt on stdin, `parser` (a parsers.js name)
 * with `parserOpts` reading its stdout. Returns `{ pid, events, stop(why), done }` — the parser's
 * events, a stop switch, and the outcome `{ code, signal, stderr, killed }`. Throws what spawnCli
 * throws (a 502 naming the error by its code, never the argv).
 */
export function spawnGroup(adapter, { argv, env, stdinText = null, parser, parserOpts = {}, killGraceMs = KILL_GRACE_MS }) {
  const stdin = stdinText != null;
  const child = spawnCli(adapter.id, which(adapter.bin) || adapter.bin, argv, { cwd: adapter.cwd, env, detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText);
  }
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    stderr += c;
    if (stderr.length > 64_000) stderr = keepTail(stderr, 32_000);
  });
  let stopped = null;
  let exited = false;
  const group = (sig) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        if (!exited) child.kill(sig);
      } catch {}
    }
  };
  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      exited = true;
      resolve({ code: -1, stderr: redactSecrets(e.message), killed: !!stopped });
    });
    child.on('close', (code, signal) => {
      exited = true;
      resolve({ code: code ?? -1, signal: signal || null, stderr: redactSecrets(stderr.trim()), killed: !!stopped });
    });
  });
  const stop = (why = 'stopped') => {
    if (!stopped) {
      stopped = why;
      group('SIGTERM');
      const t = setTimeout(() => group('SIGKILL'), killGraceMs);
      t.unref?.();
      done.then(() => {
        // The leader is gone; whatever of its group is left (a shim) gets the same end now.
        clearTimeout(t);
        group('SIGKILL');
      });
    }
    return done;
  };
  const parse = getParser(parser);
  const events = (async function* () {
    try {
      yield* parse(toLines(child.stdout), parserOpts);
    } finally {
      // A parser may stop at the CLI's last line; what comes after it is read and dropped, so
      // the CLI never blocks on a full pipe.
      child.stdout.resume();
    }
  })();
  return { pid: child.pid, events, stop, done };
}

/**
 * The child environment of a bridge run: the adapter's own (agentCleanEnv, `PWD` its workspace,
 * its configured `env`), without the inherited variables `drop` matches, with `set` on top.
 */
export function bridgeEnv(adapter, { drop = null, set = {} } = {}) {
  const base = agentCleanEnv();
  if (drop) for (const k of Object.keys(base)) if (drop.test(k)) delete base[k];
  return { ...base, PWD: adapter.cwd, ...(adapter.env || {}), ...set };
}

/** Write `content` to `file` 0600, through a temporary file, in a directory made 0700. */
export function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** Remove a file (or a directory with `dir`); true when nothing is left of it. */
export function rm(p, dir = false) {
  try {
    fs.rmSync(p, { recursive: dir, force: true });
    return true;
  } catch {
    return false;
  }
}

export function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Was `p` last changed more than `olderThanMs` before `now`? */
export function older(p, now, olderThanMs) {
  try {
    return now - fs.statSync(p).mtimeMs > olderThanMs;
  } catch {
    return false;
  }
}
