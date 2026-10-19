import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fingerprint, redactKey, registerSecrets } from './redact.js';

/**
 * Config & data locations.
 *
 *   $KEYSMITH_CONFIG   -> config file (default: ~/.config/keysmith/config.json)
 *   $KEYSMITH_DATA     -> data dir    (default: ~/.local/share/keysmith)
 *
 * The config file is the only state the gateway needs; it is plain JSON, safe to
 * keep in a dotfile repo *as long as* secrets stay references (see resolveSecret).
 */

export function configPath() {
  return (
    process.env.KEYSMITH_CONFIG ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'keysmith', 'config.json')
  );
}

export function dataDir() {
  return process.env.KEYSMITH_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'keysmith');
}

export function expand(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Secrets are stored as *references*, never as raw material, so the config file can
 * be read, diffed and committed without leaking a key.
 *
 *   "{env:OPENAI_API_KEY}"                    -> environment variable
 *   "{file:~/.config/x/token}"                -> trimmed file contents
 *   "{json:~/.local/share/opencode/auth.json#evren.key}"  -> dot-path into a JSON file
 *   "{dotenv:~/project/.env#GOOGLE_API_KEY}"              -> one variable of a .env file
 *   "{exec:security find-generic-password -s x -w}"       -> stdout of a command
 *   "sk-live-..."                             -> literal (works, but discouraged)
 *
 * The `{json:...}` and `{dotenv:...}` forms are what let keysmith reuse a credential an
 * agent or a project already keeps instead of asking you to paste the key twice.
 */
export function resolveSecret(ref, env = process.env) {
  if (ref == null || ref === false) return null;
  if (typeof ref !== 'string') throw new Error('secret must be a string reference');
  const m = ref.match(/^\{(\w+):([\s\S]*)\}$/);
  if (!m) return ref; // literal
  const [, kind, arg] = m;
  switch (kind) {
    case 'env':
      return env[arg] || null;
    case 'file':
      return fs.existsSync(expand(arg)) ? fs.readFileSync(expand(arg), 'utf8').trim() : null;
    case 'json': {
      const [file, dotted] = arg.split('#');
      const p = expand(file);
      if (!fs.existsSync(p)) return null;
      let v;
      try {
        v = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        // The file is somebody's credential store: V8's error quotes the text around the
        // break, and that text is the secret. The message ends up on /status and /routes.
        throw new Error(`${file}: ${jsonErrorWithoutText(e)}`);
      }
      for (const seg of (dotted || '').split('.').filter(Boolean)) v = v?.[seg];
      return typeof v === 'string' ? v : null;
    }
    case 'dotenv': {
      const at = arg.lastIndexOf('#');
      const name = at < 0 ? '' : arg.slice(at + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('{dotenv:…} names one variable after a #, e.g. {dotenv:~/project/.env#GOOGLE_API_KEY}');
      const p = expand(arg.slice(0, at));
      if (!fs.existsSync(p)) return null;
      return dotenvValue(fs.readFileSync(p, 'utf8'), name);
    }
    case 'exec': {
      try {
        const r = spawnSync(arg, { shell: true, encoding: 'utf8', timeout: 10_000 });
        return r.status === 0 && r.stdout ? r.stdout.trim() : null;
      } catch {
        return null;
      }
    }
    default:
      throw new Error(`unknown secret reference kind: ${kind}`);
  }
}

/**
 * One variable out of a `.env` file, read the way `set -a; . ./.env` and python-dotenv
 * agree on: `NAME=value` or `export NAME=value`, one per line, `#` comments, the last
 * assignment wins. A value is unquoted (an inline ` #comment` and surrounding blanks are
 * dropped), 'single-quoted' (taken as written) or "double-quoted" (`\n`, `\"`, `\\`
 * unescaped); a quoted value ends on its own line. Nothing is expanded and nothing is
 * executed, and the file's text never goes into an error: it is somebody's secrets.
 */
export function dotenvValue(text, name) {
  let found = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    const rest = m[2];
    let value;
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end < 0 ? null : rest.slice(1, end);
    } else if (rest.startsWith('"')) {
      const close = rest.slice(1).match(/^((?:[^"\\]|\\.)*)"/);
      value = close ? close[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c)) : null;
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    found = value;
  }
  return found || null;
}

export function newApiKey() {
  return 'ks_' + crypto.randomBytes(24).toString('base64url');
}

/**
 * A new key whose fingerprint no key in `existing` has: `key scope` and `key revoke` find a key
 * by that fingerprint, so two keys sharing one would make both ambiguous.
 */
export function newUniqueApiKey(existingFingerprints) {
  const taken = new Set(existingFingerprints);
  for (;;) {
    const key = newApiKey();
    if (!taken.has(fingerprint(key))) return key;
  }
}

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  auth: { enabled: true, keys: [] },
  log: { usage: true, body: false },
  limits: { maxConcurrent: 4, timeoutMs: 300_000 },
  tunnel: { provider: 'cloudflared', name: null, hostname: null, configFile: null },
  adapters: {},
  aliases: {},
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (isObj(base) && isObj(extra)) {
    const out = { ...base };
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
    return out;
  }
  return extra === undefined ? base : extra;
}
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function configExists() {
  return fs.existsSync(configPath());
}

/**
 * `mint: false` is for commands that only read (`key list`, `key who-can`): they say there
 * is no key rather than writing one into the config.
 */
export function loadConfig({ mint = true } = {}) {
  const p = configPath();
  if (!fs.existsSync(p)) return structuredClone(DEFAULTS);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p}: ${jsonErrorWithoutText(e)}`);
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), raw);
  cfg._path = p;
  // A key with a scope is an object ({ key, label, allow, deny }); registerSecrets takes both forms.
  registerSecrets(cfg.auth?.keys);
  // A gateway that listens on a tunnel must not be keyless; refuse silently-defaulting.
  if (mint && cfg.auth.enabled && (!cfg.auth.keys || cfg.auth.keys.length === 0)) {
    cfg.auth.keys = [newApiKey()];
    registerSecrets(cfg.auth.keys);
    saveConfig(cfg);
    // This runs inside `serve`, whose stderr is launchd's log file: name the key, never print it.
    process.stderr.write(`keysmith: no API keys configured — generated ${redactKey(cfg.auth.keys[0])} and wrote it to ${p} (\`keysmith key list --reveal\`, in a terminal, shows it)\n`);
  }
  return cfg;
}

/**
 * V8 quotes the text around a JSON syntax error (`Unexpected token 'k', ...[ks_Q3x"... is not
 * valid JSON`), and this file holds the gateway key. Keep where it broke, drop what it says.
 */
export function jsonErrorWithoutText(e) {
  const where = String(e?.message || '').match(/at position \d+(?: \(line \d+ column \d+\))?/);
  return `invalid JSON${where ? ` ${where[0]}` : ''} — the text around it is not shown, this file holds keys`;
}

export function saveConfig(cfg) {
  const p = cfg._path || configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const out = { ...cfg };
  delete out._path;
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
  return p;
}
