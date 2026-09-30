import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
 *   "{exec:security find-generic-password -s x -w}"       -> stdout of a command
 *   "sk-live-..."                             -> literal (works, but discouraged)
 *
 * The `{json:...}` form is what lets keysmith reuse a credential an agent already
 * keeps in its own store instead of asking you to paste the key twice.
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
      let v = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const seg of (dotted || '').split('.').filter(Boolean)) v = v?.[seg];
      return typeof v === 'string' ? v : null;
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

export function newApiKey() {
  return 'ks_' + crypto.randomBytes(24).toString('base64url');
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

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return structuredClone(DEFAULTS);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p}: invalid JSON (${e.message})`);
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), raw);
  cfg._path = p;
  // A gateway that listens on a tunnel must not be keyless; refuse silently-defaulting.
  if (cfg.auth.enabled && (!cfg.auth.keys || cfg.auth.keys.length === 0)) {
    cfg.auth.keys = [newApiKey()];
    saveConfig(cfg);
    process.stderr.write(`keysmith: no API keys configured — generated ${cfg.auth.keys[0]} and wrote it to ${p}\n`);
  }
  return cfg;
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
