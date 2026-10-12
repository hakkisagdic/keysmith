import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config.js';
import { scrubBuffer } from './redact.js';

/**
 * The files keysmith writes log lines into, and the modes they live under.
 *
 *   <data>/keysmith.log            `keysmith start` — serve's stdout + stderr
 *   <data>/usage.jsonl             one line per request
 *   <logDir>/launchd-gateway.log   launchd — serve's stdout + stderr
 *   <logDir>/launchd-tunnel.log    launchd — cloudflared's output
 *
 * Every one is created 0600 inside a 0700 directory. launchd creates a missing
 * StandardOutPath itself, with the job's umask — 077 since the plists set `Umask`, 022
 * (0644) for an agent installed before that — and a file from an older keysmith keeps the
 * mode it was born with, so `serve`, `start` and `install-service` tighten what exists.
 */

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** Where launchd writes the agents' output. Not `$KEYSMITH_DATA`: a LaunchAgent's env is only PATH. */
export function logDir() {
  return path.join(os.homedir(), '.local', 'share', 'keysmith');
}

export function logFiles() {
  return unique([
    path.join(dataDir(), 'keysmith.log'),
    path.join(dataDir(), 'usage.jsonl'),
    path.join(logDir(), 'launchd-gateway.log'),
    path.join(logDir(), 'launchd-tunnel.log'),
  ]);
}

export function logDirs() {
  return unique([dataDir(), logDir()]);
}

const COMPRESSED = /\.(gz|bz2|xz|zst|zip|lz4)$/i;

/**
 * Older copies of those logs next to them — `launchd-gateway.log.0` from newsyslog,
 * `usage.jsonl.1`, `keysmith.log.old` — which hold whatever the log held when it was moved.
 * Compressed ones cannot be rewritten in place and are listed apart.
 */
export function rotatedLogFiles(files = logFiles()) {
  const plain = [];
  const compressed = [];
  for (const f of files) {
    const dir = path.dirname(f);
    const base = path.basename(f);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (!n.startsWith(`${base}.`) || n.length === base.length + 1) continue;
      const p = path.join(dir, n);
      try {
        if (!fs.statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      (COMPRESSED.test(n) ? compressed : plain).push(p);
    }
  }
  return { files: unique(plain), compressed: unique(compressed) };
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  tighten(dir);
  return dir;
}

/** An append fd on a log file that is 0600 whether it is new or was already there. */
export function openPrivateLog(file) {
  ensurePrivateDir(path.dirname(file));
  const fd = fs.openSync(file, 'a', FILE_MODE);
  fs.fchmodSync(fd, FILE_MODE);
  return fd;
}

/** Create (empty) or tighten each file, so whoever opens it next — launchd — finds it 0600. */
export function precreatePrivateLogs(files) {
  for (const f of files) fs.closeSync(openPrivateLog(f));
  return files;
}

/**
 * Drop group/other bits from existing log files and their directories. Never widens, and
 * never throws: a log that cannot be chmod-ed must not keep the gateway from starting.
 */
export function secureLogFiles({ dirs = logDirs(), files = logFiles() } = {}) {
  const changed = [];
  const failed = [];
  for (const p of [...dirs, ...files]) {
    try {
      if (fs.existsSync(p) && tighten(p)) changed.push(p);
    } catch (e) {
      failed.push(`${p}: ${e.code || e.message}`);
    }
  }
  return { changed, failed };
}

/**
 * Replace every key in a log file with its redacted form, on the same inode: launchd holds
 * the gateway log open for append, and a rename would leave it writing to a deleted file.
 *
 * Each replacement is padded with spaces to the length of what it replaces, so the bytes
 * that were read are overwritten one for one and the file is never truncated. A line the
 * gateway appends while this runs lands past the end of what was read, and stays: a
 * shorter rewrite would need an ftruncate, and that would cut it off.
 * Returns the counts only — the file's contents never leave this function.
 */
export function scrubLogFile(file, keys) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r+');
  try {
    const before = fs.readFileSync(fd);
    const { buf, configured, shaped } = scrubBuffer(before, keys, { sameLength: true });
    if (buf.length !== before.length) throw new Error(`${file}: scrub changed the length — not written`);
    if (configured + shaped) fs.writeSync(fd, buf, 0, buf.length, 0);
    return { file, configured, shaped, bytes: { before: before.length, after: buf.length } };
  } finally {
    fs.closeSync(fd);
  }
}

/** chmod to the owner bits alone when group or other have any. True if it changed. */
function tighten(p) {
  const mode = fs.statSync(p).mode & 0o777;
  if (!(mode & 0o077)) return false;
  fs.chmodSync(p, mode & 0o700);
  return true;
}

function unique(list) {
  return [...new Set(list)];
}
