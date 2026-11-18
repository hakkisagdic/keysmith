/**
 * keysmith MCP server (stdio JSON-RPC 2.0) and client registration.
 *
 * Exposes a central tool registry so read, write, and reload slices can plug in
 * without duplicating protocol framing, confirmation gating, backup semantics, or
 * output redaction.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { INJECTED_ARGS, LATEST_PROTOCOL, PROTOCOL_VERSIONS } from './bridge/mcp.js';
import { backupFile, readRaw, writeJsonAtomic } from './config-edit.js';
import { configPath, dataDir, jsonErrorWithoutText } from './config.js';
import { redactKey, redactSecrets, registerSecrets } from './redact.js';
import { stablePath } from './service.js';
import { isPlainObject } from './tools/model.js';

export { backupFile, writeJsonAtomic };

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const CLI_ENTRY = fileURLToPath(new URL('./cli.js', import.meta.url));
const SERVER_INFO = { name: 'keysmith', version: PKG.version };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const TOOL_NAME_RE = /^keysmith_[a-z][a-z0-9_]*$/;
const SECRET_REF_RE = /^\{(exec|json|file|dotenv):([\s\S]*)\}$/i;
const SAFE_ENV_REF_RE = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const AUTH_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-auth-token|cookie|set-cookie)$/i;
const ENV_SECRET_RE = /(key|token|secret|password|auth|credential)/i;
const ADAPTER_SECRET_FIELDS = new Set([
  'apiKey',
  'key',
  'token',
  'secret',
  'password',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'privateKey',
]);
const BODY_FIELDS = new Set(['requestBody', 'responseBody', 'reqBody', 'resBody', 'rawBody']);
const SLICE_MODULES = ['./mcp-read.js', './mcp-write.js', './mcp-reload.js'];

/* ------------------------------------------------------------------ registry */

export function createToolRegistry() {
  const tools = new Map();
  return {
    register(def) {
      tools.set(def.name, def);
      return def;
    },
    unregister(name) {
      return tools.delete(name);
    },
    get(name) {
      return tools.get(name) || null;
    },
    list() {
      return [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      }));
    },
    clear() {
      tools.clear();
    },
  };
}

export const defaultRegistry = createToolRegistry();

export function registerTool(
  { name, description = '', inputSchema = { type: 'object', properties: {} }, annotations = {}, write = false, destructive = false, handler },
  registry = defaultRegistry,
) {
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
    throw new Error(`invalid MCP tool name "${name}": must match ${TOOL_NAME_RE}`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`MCP tool "${name}" requires a handler function`);
  }
  const isWrite = Boolean(write);
  const rawProps = isPlainObject(inputSchema?.properties) ? { ...inputSchema.properties } : {};
  if (isWrite && !Object.hasOwn(rawProps, 'confirm')) {
    rawProps.confirm = {
      type: 'boolean',
      description: 'Set to true only after asking the user and receiving explicit confirmation.',
    };
  }
  const normalizedSchema = {
    type: 'object',
    ...(isPlainObject(inputSchema) ? inputSchema : {}),
    properties: rawProps,
    additionalProperties: inputSchema?.additionalProperties ?? false,
  };
  const normalizedAnnotations = {
    ...(isPlainObject(annotations) ? annotations : {}),
    readOnlyHint: !isWrite,
    destructiveHint: isWrite ? Boolean(annotations?.destructiveHint ?? destructive) : false,
  };
  return registry.register({
    name,
    description: String(description || ''),
    inputSchema: normalizedSchema,
    annotations: normalizedAnnotations,
    write: isWrite,
    handler,
  });
}

export function unregisterTool(name, registry = defaultRegistry) {
  return registry.unregister(name);
}

export function listRegisteredTools(registry = defaultRegistry) {
  return registry.list();
}

/**
 * Backup-first atomic config writer shared across writing MCP tools.
 * Only writes and creates a backup when `mutate(draft)` changes the serialized config.
 */
export async function writeConfigWithBackup(cfgFile, mutate, { tag = 'mcp' } = {}) {
  const existed = fs.existsSync(cfgFile);
  const doc = existed ? readRaw(cfgFile) : {};
  const draft = structuredClone(doc);
  const extra = await mutate(draft);
  const changed = JSON.stringify(doc) !== JSON.stringify(draft);
  if (!changed) {
    return { changed: false, backup: null, ...(isPlainObject(extra) ? extra : {}) };
  }
  const backup = existed ? backupFile(cfgFile, tag) : null;
  writeJsonAtomic(cfgFile, draft);
  return { changed: true, backup, ...(isPlainObject(extra) ? extra : {}) };
}

export async function loadBuiltInTools(registry = defaultRegistry) {
  const registerFn = (def) => registerTool(def, registry);
  for (const relPath of SLICE_MODULES) {
    const url = new URL(relPath, import.meta.url);
    if (!fs.existsSync(fileURLToPath(url))) continue;
    const mod = await import(url.href);
    if (typeof mod.registerTools === 'function') {
      await mod.registerTools(registerFn);
    }
  }
}

/* ----------------------------------------------------------------- redaction */

const jsonEscaped = (t) => JSON.stringify(t).slice(1, -1);

function addVerbatim(set, value) {
  if (typeof value !== 'string') return;
  if (value.length >= 4) set.add(value);
}

function addRefParts(set, kind, arg) {
  addVerbatim(set, arg);
  if (kind === 'json' || kind === 'dotenv') {
    const sep = kind === 'json' ? arg.indexOf('#') : arg.lastIndexOf('#');
    if (sep > 0) {
      const filePart = arg.slice(0, sep);
      const keyPart = arg.slice(sep + 1);
      addVerbatim(set, filePart);
      addVerbatim(set, keyPart);
      if (filePart.startsWith('~/') || filePart.startsWith('~\\')) {
        addVerbatim(set, path.join(os.homedir(), filePart.slice(2)));
      }
    }
    return;
  }
  if (kind === 'exec') {
    for (const m of arg.matchAll(/(?:^|\s)-(?:s|a)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
      const val = m[1] ?? m[2] ?? m[3];
      if (val && val !== 'keysmith') addVerbatim(set, val);
    }
  }
}

function scanDocSecrets(node, keys, verbatim, adapterIds) {
  if (typeof node === 'string') {
    const ref = SECRET_REF_RE.exec(node);
    if (ref) {
      addRefParts(verbatim, ref[1].toLowerCase(), ref[2]);
    }
    const cf = /\/accounts\/([0-9a-fA-F]{32})(?=\/|$)/.exec(node);
    if (cf) {
      verbatim.add(cf[1]);
      verbatim.add(cf[1].toLowerCase());
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) scanDocSecrets(item, keys, verbatim, adapterIds);
    return;
  }
  if (!isPlainObject(node)) return;

  for (const [k, v] of Object.entries(node)) {
    if ((k === 'accountId' || k === 'account_id') && typeof v === 'string' && v.trim()) {
      addVerbatim(verbatim, v.trim());
    } else if (k === 'workspaceFiles' && isPlainObject(v)) {
      for (const content of Object.values(v)) {
        if (typeof content === 'string') addVerbatim(verbatim, content);
      }
    } else if (k === 'headers' || k === 'mediaHeaders') {
      if (isPlainObject(v)) {
        for (const [hk, hv] of Object.entries(v)) {
          if (typeof hv !== 'string') continue;
          const bearer = /^Bearer\s+(.+)$/i.exec(hv);
          if (bearer) keys.push(bearer[1]);
          if (AUTH_HEADER_RE.test(hk)) keys.push(hv);
        }
      }
    } else if (k === 'env' && isPlainObject(v)) {
      for (const [ek, ev] of Object.entries(v)) {
        if (typeof ev !== 'string') continue;
        if (SECRET_REF_RE.test(ev)) {
          scanDocSecrets(ev, keys, verbatim, adapterIds);
        } else if (ENV_SECRET_RE.test(ek) && !SAFE_ENV_REF_RE.test(ev)) {
          keys.push(ev);
        }
      }
    } else if (ADAPTER_SECRET_FIELDS.has(k) && typeof v === 'string') {
      if (SECRET_REF_RE.test(v)) {
        scanDocSecrets(v, keys, verbatim, adapterIds);
      } else if (!SAFE_ENV_REF_RE.test(v)) {
        keys.push(v);
      }
    } else if (BODY_FIELDS.has(k) && typeof v === 'string') {
      addVerbatim(verbatim, v);
    } else {
      scanDocSecrets(v, keys, verbatim, adapterIds);
    }
  }
  for (const id of adapterIds) verbatim.delete(id);
}

/**
 * Inspect the raw config file on disk (never resolving references or running `{exec:...}`)
 * and register configured secrets with `redact.js` while collecting non-key sensitive strings.
 */
export function collectConfigSecrets(cfgFile) {
  const keys = [];
  const verbatim = new Set();
  if (cfgFile && fs.existsSync(cfgFile)) {
    try {
      const doc = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (isPlainObject(doc)) {
        const adapterIds = isPlainObject(doc.adapters) ? Object.keys(doc.adapters) : [];
        for (const entry of Array.isArray(doc.auth?.keys) ? doc.auth.keys : []) {
          const k = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.key : null;
          if (typeof k === 'string' && k) keys.push(k);
        }
        scanDocSecrets(doc, keys, verbatim, adapterIds);
      }
    } catch {
      // Unreadable or malformed config is reported without leaking its contents.
    }
  }
  if (keys.length) registerSecrets(keys);
  return { keys, verbatim };
}

export function mergeSecretContexts(a, b) {
  const keys = [...new Set([...(a?.keys || []), ...(b?.keys || [])])];
  const verbatim = new Set([...(a?.verbatim || []), ...(b?.verbatim || [])]);
  if (keys.length) registerSecrets(keys);
  return { keys, verbatim };
}

function findBalancedEnd(s, start, openCh, closeCh) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

function findQuotedEnd(s, start, quoteCh) {
  let esc = false;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') esc = true;
    else if (ch === quoteCh) return i + 1;
    else if (ch === '\n') return i;
  }
  return s.length;
}

function scrubBodyLiterals(s) {
  const re = /(?:^|[^A-Za-z0-9_.])((?:request|response|req|res|raw)Body|body)"?\s*([:=])\s*/gi;
  let out = '';
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) break;
    const key = m[1];
    const sep = m[2];
    const valStart = m.index + m[0].length;
    if (valStart >= s.length) break;
    const ch = s[valStart];
    let valEnd = -1;
    let repl = '[redacted]';
    if (ch === '{' || ch === '[') {
      valEnd = findBalancedEnd(s, valStart, ch, ch === '{' ? '}' : ']');
      repl = sep === ':' ? '"[redacted]"' : '[redacted]';
    } else if (ch === '"' || ch === "'") {
      valEnd = findQuotedEnd(s, valStart, ch);
      repl = ch === '"' ? '"[redacted]"' : "'[redacted]'";
    } else if (key.toLowerCase() !== 'body') {
      const rest = s.slice(valStart);
      const token = /^[^\s,}\]]+/.exec(rest)?.[0] || '';
      if (token && !/^(?:null|true|false|undefined|\[redacted\])$/i.test(token)) {
        valEnd = valStart + token.length;
        repl = '[redacted]';
      }
    }
    if (valEnd > valStart) {
      out += s.slice(at, valStart) + repl;
      at = valEnd;
    } else {
      out += s.slice(at, valStart);
      at = valStart;
    }
  }
  return out + s.slice(at);
}

export function redactMcpText(text, secretCtx = null) {
  let s = String(text ?? '');
  if (!s) return s;

  // Mask full and truncated secret references while leaving {env:VAR} intact.
  s = s.replace(/\{(exec|json|file|dotenv):((?:[^{}\n]|\{[^{}\n]*\})*)\}/gi, (_, kind) => `{${kind.toLowerCase()}:[redacted]}`);
  s = s.replace(/\{(exec|json|file|dotenv):(?!\[redacted\]\})([^\n"'}\]]+)/gi, (_, kind) => `{${kind.toLowerCase()}:[redacted]}`);

  // Mask Keychain commands and diagnostic phrases.
  s = s.replace(/(find-generic-password|add-generic-password)(?:\s+[^\n`"'}]*)*/g, '$1 [redacted]');
  s = s.replace(/Keychain\s+"[^"]*"/g, 'Keychain "[redacted]"');
  s = s.replace(/no Keychain item\s+"[^"]*"\s+for account\s+"[^"]*"/g, 'no Keychain item "[redacted]" for account "[redacted]"');

  // Mask Cloudflare account IDs in API URLs.
  s = s.replace(/(\/client\/v4\/accounts\/)[0-9a-fA-F]{32}(?=\/|$|["'\s])/gi, '$1[redacted]');
  s = s.replace(/(cloudflare\.com[^\s"']*?\/accounts\/)[0-9a-fA-F]{32}(?=\/|$|["'\s])/gi, '$1[redacted]');

  // Replace known sensitive strings collected from config (longest first).
  if (secretCtx?.verbatim?.size) {
    const needles = [...secretCtx.verbatim].filter((v) => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
    for (const needle of needles) {
      if (s.includes(needle)) s = s.split(needle).join('[redacted]');
      const escaped = jsonEscaped(needle);
      if (escaped !== needle && s.includes(escaped)) s = s.split(escaped).join('[redacted]');
    }
  }

  // Mask request/response body fragments in raw text or error strings.
  s = scrubBodyLiterals(s);

  // Mask inline Bearer tokens and common upstream API key shapes.
  s = s.replace(/\b(Bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  s = s.replace(/\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,})/g, (m) =>
    redactKey(m),
  );

  return redactSecrets(s);
}

function redactSecretField(v, secretCtx) {
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (SAFE_ENV_REF_RE.test(v)) return v;
    if (SECRET_REF_RE.test(v)) return redactMcpText(v, secretCtx);
    return redactKey(v);
  }
  return '[redacted]';
}

export function redactMcpValue(value, secretCtx = null, parentHint = '') {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactMcpText(value, secretCtx);
  if (Array.isArray(value)) {
    if (parentHint === 'auth.keys') {
      return value.map((item) => {
        if (typeof item === 'string') return redactKey(item);
        if (isPlainObject(item)) {
          const out = {};
          for (const [k, v] of Object.entries(item)) {
            out[k] = k === 'key' ? redactSecretField(v, secretCtx) : redactMcpValue(v, secretCtx);
          }
          return out;
        }
        return redactMcpValue(item, secretCtx);
      });
    }
    return value.map((item) => redactMcpValue(item, secretCtx));
  }
  if (!isPlainObject(value)) return redactMcpText(String(value), secretCtx);

  const isAdapterObj = Object.hasOwn(value, 'kind') || Object.hasOwn(value, 'baseUrl') || Object.hasOwn(value, 'bin');
  const isAuthKeyObj =
    Object.hasOwn(value, 'allow') ||
    Object.hasOwn(value, 'deny') ||
    Object.hasOwn(value, 'perDay') ||
    Object.hasOwn(value, 'keyHash') ||
    (Object.hasOwn(value, 'key') && Object.keys(value).every((k) => k === 'key' || k === 'label'));
  const isAuthSection = Object.hasOwn(value, 'keys') && Array.isArray(value.keys) && (Object.hasOwn(value, 'enabled') || parentHint === 'auth');

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'workspaceFiles') {
      if (isPlainObject(v)) {
        const files = {};
        for (const fk of Object.keys(v)) files[redactMcpText(fk, secretCtx)] = '[redacted]';
        out[k] = files;
      } else {
        out[k] = '[redacted]';
      }
      continue;
    }
    if (BODY_FIELDS.has(k) || (k === 'body' && v != null && typeof v !== 'boolean')) {
      out[k] = '[redacted]';
      continue;
    }
    if (k === 'accountId' || k === 'account_id') {
      out[k] = '[redacted]';
      continue;
    }
    if (k === 'apiKey' || k === 'secret' || k === 'password' || k === 'clientSecret' || k === 'accessToken' || k === 'refreshToken' || k === 'privateKey') {
      out[k] = redactSecretField(v, secretCtx);
      continue;
    }
    if (k === 'key' && (isAdapterObj || isAuthKeyObj)) {
      out[k] = redactSecretField(v, secretCtx);
      continue;
    }
    if ((k === 'headers' || k === 'mediaHeaders') && isPlainObject(v)) {
      const hdrs = {};
      for (const [hk, hv] of Object.entries(v)) {
        hdrs[hk] = AUTH_HEADER_RE.test(hk) ? '[redacted]' : redactMcpValue(hv, secretCtx);
      }
      out[k] = hdrs;
      continue;
    }
    if (k === 'env' && isPlainObject(v)) {
      const envOut = {};
      for (const [ek, ev] of Object.entries(v)) {
        if (ENV_SECRET_RE.test(ek)) {
          if (typeof ev === 'string' && SAFE_ENV_REF_RE.test(ev)) envOut[ek] = ev;
          else if (typeof ev === 'string' && SECRET_REF_RE.test(ev)) envOut[ek] = redactMcpText(ev, secretCtx);
          else envOut[ek] = '[redacted]';
        } else {
          envOut[ek] = redactMcpValue(ev, secretCtx);
        }
      }
      out[k] = envOut;
      continue;
    }
    if (k === 'auth' && isPlainObject(v)) {
      out[k] = redactMcpValue(v, secretCtx, 'auth');
      continue;
    }
    if (k === 'keys' && isAuthSection && Array.isArray(v)) {
      out[k] = redactMcpValue(v, secretCtx, 'auth.keys');
      continue;
    }
    out[k] = redactMcpValue(v, secretCtx);
  }
  return out;
}

function scrubTextContent(rawText, secretCtx) {
  const s = String(rawText ?? '');
  const trimmed = s.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const scrubbed = redactMcpValue(parsed, secretCtx);
        return redactMcpText(JSON.stringify(scrubbed, null, 2), secretCtx);
      }
    } catch {
      // Not valid JSON; fall back to text redaction.
    }
  }
  return redactMcpText(s, secretCtx);
}

export function formatToolResult(rawResult, secretCtx = null) {
  if (isPlainObject(rawResult) && Array.isArray(rawResult.content)) {
    const content = rawResult.content.map((block) => {
      if (isPlainObject(block) && block.type === 'text') {
        return { ...block, text: scrubTextContent(block.text, secretCtx) };
      }
      return redactMcpValue(block, secretCtx);
    });
    const out = { content };
    if (rawResult.structuredContent !== undefined) {
      const scrubbed = redactMcpValue(rawResult.structuredContent, secretCtx);
      out.structuredContent = isPlainObject(scrubbed) ? scrubbed : { result: scrubbed };
    }
    if (rawResult.isError) out.isError = true;
    return out;
  }

  if (isPlainObject(rawResult)) {
    const structuredContent = redactMcpValue(rawResult, secretCtx);
    const text = redactMcpText(JSON.stringify(structuredContent, null, 2), secretCtx);
    return {
      content: [{ type: 'text', text }],
      structuredContent,
      ...(rawResult.isError ? { isError: true } : {}),
    };
  }

  if (typeof rawResult === 'string') {
    const text = scrubTextContent(rawResult, secretCtx);
    return {
      content: [{ type: 'text', text }],
      structuredContent: { result: text },
    };
  }

  const scrubbed = redactMcpValue(rawResult ?? null, secretCtx);
  const structuredContent = { result: scrubbed };
  return {
    content: [{ type: 'text', text: redactMcpText(JSON.stringify(scrubbed, null, 2), secretCtx) }],
    structuredContent,
  };
}

/* ------------------------------------------------------------------- server */

function isId(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function cleanInjectedArgs(tool, args) {
  const props = isPlainObject(tool.inputSchema?.properties) ? tool.inputSchema.properties : {};
  const drop = INJECTED_ARGS.filter((k) => Object.hasOwn(args, k) && !Object.hasOwn(props, k));
  if (!drop.length) return args;
  const out = { ...args };
  for (const k of drop) delete out[k];
  return out;
}

export function readMcpEnvOverrides(env = process.env) {
  const out = {};
  const launchctlBin = typeof env?.KEYSMITH_MCP_LAUNCHCTL === 'string' ? env.KEYSMITH_MCP_LAUNCHCTL.trim() : '';
  if (launchctlBin) {
    out.launchctl = (args) =>
      execFileSync(launchctlBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const gatewayUrl = typeof env?.KEYSMITH_MCP_GATEWAY_URL === 'string' ? env.KEYSMITH_MCP_GATEWAY_URL.trim() : '';
  if (gatewayUrl) {
    out.gatewayUrl = gatewayUrl;
  }
  const plistFile = typeof env?.KEYSMITH_MCP_PLIST === 'string' ? env.KEYSMITH_MCP_PLIST.trim() : '';
  if (plistFile) {
    out.plistFile = plistFile;
  }
  return out;
}

export function createMcpServer({
  registry = defaultRegistry,
  configFile = null,
  dataDir: customDataDir = null,
  serverInfo = SERVER_INFO,
  send = () => {},
  context = {},
} = {}) {
  const startupContext = { ...readMcpEnvOverrides(process.env), ...context };
  let version = null;
  let initialized = false;

  const sendError = (id, code, message) => {
    send({ jsonrpc: '2.0', id, error: { code, message: String(message) } });
  };

  const sendResult = (id, result) => {
    send({ jsonrpc: '2.0', id, result });
  };

  const handle = async (msg) => {
    if (!isPlainObject(msg)) {
      sendError(null, INVALID_REQUEST, 'invalid JSON-RPC request');
      return;
    }
    const hasIdProp = Object.hasOwn(msg, 'id') && msg.id !== undefined;
    if (hasIdProp && !isId(msg.id)) {
      sendError(null, INVALID_REQUEST, 'invalid JSON-RPC request id');
      return;
    }
    const isRequest = hasIdProp && isId(msg.id);
    if (typeof msg.method !== 'string' || !msg.method) {
      if (isRequest) sendError(msg.id, INVALID_REQUEST, 'invalid JSON-RPC request: missing method');
      return;
    }

    // Notifications carry no id and must never receive a response.
    if (!isRequest) {
      if (msg.method === 'notifications/initialized') initialized = true;
      return;
    }

    if (msg.params !== undefined && !isPlainObject(msg.params)) {
      sendError(msg.id, INVALID_PARAMS, 'params must be a JSON object');
      return;
    }
    const params = isPlainObject(msg.params) ? msg.params : {};

    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        version = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
        sendResult(msg.id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
        return;
      }
      case 'ping':
        sendResult(msg.id, {});
        return;
      case 'tools/list':
        sendResult(msg.id, { tools: registry.list() });
        return;
      case 'tools/call':
        await handleToolCall(msg.id, params);
        return;
      default:
        sendError(msg.id, METHOD_NOT_FOUND, `method not found: ${String(msg.method).slice(0, 64)}`);
    }
  };

  const handleToolCall = async (id, params) => {
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) {
      sendError(id, INVALID_PARAMS, 'tools/call requires params.name');
      return;
    }
    const tool = registry.get(name);
    if (!tool) {
      sendError(id, INVALID_PARAMS, `unknown tool: ${name}`);
      return;
    }
    const rawArgs = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    if (!isPlainObject(rawArgs)) {
      sendError(id, INVALID_PARAMS, 'tools/call params.arguments must be an object');
      return;
    }

    const args = cleanInjectedArgs(tool, rawArgs);
    const resolvedConfigFile = configFile || configPath();
    const resolvedDataDir = customDataDir || dataDir();
    const beforeSecrets = collectConfigSecrets(resolvedConfigFile);

    // Central confirmation gate: writing tools never execute unless confirm === true.
    if (tool.write && args.confirm !== true) {
      const message = `Write tool "${tool.name}" requires confirm: true. Ask the user for confirmation before calling this tool with confirm: true.`;
      const refused = formatToolResult(
        {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            ok: false,
            error: 'confirmation_required',
            tool: tool.name,
            message,
          },
          isError: true,
        },
        beforeSecrets,
      );
      sendResult(id, refused);
      return;
    }

    const toolCtx = {
      ...startupContext,
      configFile: resolvedConfigFile,
      dataDir: resolvedDataDir,
      backupFile,
      writeJsonAtomic,
      writeConfigWithBackup: (mutate, opts) => writeConfigWithBackup(resolvedConfigFile, mutate, opts),
    };

    try {
      const raw = await tool.handler(args, toolCtx);
      const afterSecrets = collectConfigSecrets(resolvedConfigFile);
      const mergedSecrets = mergeSecretContexts(beforeSecrets, afterSecrets);
      sendResult(id, formatToolResult(raw, mergedSecrets));
    } catch (err) {
      const afterSecrets = collectConfigSecrets(resolvedConfigFile);
      const mergedSecrets = mergeSecretContexts(beforeSecrets, afterSecrets);
      const message = redactMcpText(err?.message || String(err), mergedSecrets);
      sendResult(id, {
        content: [{ type: 'text', text: message }],
        structuredContent: { ok: false, error: message },
        isError: true,
      });
    }
  };

  const handleLine = async (line) => {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendError(null, PARSE_ERROR, 'invalid JSON');
      return;
    }
    await handle(parsed);
  };

  return {
    handle,
    handleLine,
    state: () => ({ version, initialized }),
  };
}

export async function startMcpServer({
  input = process.stdin,
  output = process.stdout,
  registry = defaultRegistry,
  loadSlices = true,
  configFile = null,
  dataDir: customDataDir = null,
  serverInfo = SERVER_INFO,
  context = {},
} = {}) {
  if (loadSlices && registry === defaultRegistry) {
    await loadBuiltInTools(registry);
  }
  const server = createMcpServer({
    registry,
    configFile,
    dataDir: customDataDir,
    serverInfo,
    context,
    send: (msg) => {
      output.write(JSON.stringify(msg) + '\n');
    },
  });

  let queue = Promise.resolve();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    queue = queue.then(() => server.handleLine(line)).catch((err) => {
      const message = redactMcpText(err?.message || String(err));
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INTERNAL_ERROR, message } }) + '\n');
    });
  });

  await new Promise((resolve) => rl.once('close', resolve));
  await queue;
  return server;
}

/* ------------------------------------------------------- client registration */

function writeTextAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function upsertCodexToml(existing, serverName, command, args) {
  const header = `[mcp_servers.${serverName}]`;
  const blockLines = [
    header,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ];
  const lines = String(existing || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (m) {
      const section = m[1].trim();
      if (section === `mcp_servers.${serverName}` || section.startsWith(`mcp_servers.${serverName}.`)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (out.length) out.push('');
  out.push(...blockLines);
  return out.join('\n') + '\n';
}

function applyJsonServerEntry(doc, sectionKey, serverName, entry) {
  const next = isPlainObject(doc) ? structuredClone(doc) : {};
  const prev = next[sectionKey]?.[serverName];
  if (JSON.stringify(prev) === JSON.stringify(entry)) return { doc: next, changed: false };
  next[sectionKey] = isPlainObject(next[sectionKey]) ? next[sectionKey] : {};
  next[sectionKey][serverName] = entry;
  return { doc: next, changed: true };
}

function clientTargets(homeDir, platform) {
  const claudeDesktopDir =
    platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support', 'Claude')
      : path.join(homeDir, '.config', 'Claude');
  const fileOrDirExists = (file) => fs.existsSync(file) || fs.existsSync(path.dirname(file));
  const standard = (client, file, present = fileOrDirExists) => ({
    client,
    file,
    kind: 'json',
    present,
    apply: (doc, serverName, command, args) => applyJsonServerEntry(doc, 'mcpServers', serverName, { command, args }),
  });

  return [
    standard('claude-code', path.join(homeDir, '.claude.json'), (file) => fs.existsSync(file) || fs.existsSync(path.join(homeDir, '.claude'))),
    standard('claude-desktop', path.join(claudeDesktopDir, 'claude_desktop_config.json')),
    standard('cursor', path.join(homeDir, '.cursor', 'mcp.json')),
    standard('gemini-cli', path.join(homeDir, '.gemini', 'settings.json')),
    {
      client: 'opencode',
      file: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
      kind: 'json',
      present: fileOrDirExists,
      apply: (doc, serverName, command, args) =>
        applyJsonServerEntry(doc, 'mcp', serverName, { type: 'local', command: [command, ...args], enabled: true }),
    },
    {
      client: 'codex-cli',
      file: path.join(homeDir, '.codex', 'config.toml'),
      kind: 'toml',
      present: fileOrDirExists,
    },
  ];
}

export function registerMcpClients({
  homeDir = os.homedir(),
  platform = process.platform,
  nodeBin = process.execPath,
  entry = CLI_ENTRY,
  dryRun = false,
  serverName = 'keysmith',
} = {}) {
  const command = stablePath(nodeBin);
  const args = [entry, 'mcp'];
  const results = [];
  const lines = [];

  for (const target of clientTargets(homeDir, platform)) {
    if (!target.present(target.file)) continue;
    const existed = fs.existsSync(target.file);
    let changed = false;
    let commitWrite;

    if (target.kind === 'json') {
      let current = {};
      if (existed) {
        try {
          const parsed = JSON.parse(fs.readFileSync(target.file, 'utf8'));
          if (!isPlainObject(parsed)) throw new Error('expected JSON object');
          current = parsed;
        } catch (e) {
          const reason = e instanceof SyntaxError ? jsonErrorWithoutText(e) : e.message;
          results.push({ client: target.client, file: target.file, status: 'skipped', reason });
          lines.push(`! ${target.client} (${target.file}): skipped — ${reason}`);
          continue;
        }
      }
      const next = target.apply(current, serverName, command, args);
      changed = next.changed;
      commitWrite = () => writeJsonAtomic(target.file, next.doc);
    } else {
      const prevText = existed ? fs.readFileSync(target.file, 'utf8') : '';
      const nextText = upsertCodexToml(prevText, serverName, command, args);
      changed = prevText !== nextText;
      commitWrite = () => writeTextAtomic(target.file, nextText);
    }

    if (!changed) {
      results.push({ client: target.client, file: target.file, status: 'unchanged', backup: null });
      lines.push(`= ${target.client} (${target.file}): already registered`);
      continue;
    }
    if (dryRun) {
      results.push({ client: target.client, file: target.file, status: 'would-write', backup: null });
      lines.push(`+ ${target.client} (${target.file}): would register "${serverName}" (dry run)`);
      continue;
    }
    const backup = existed ? backupFile(target.file, 'mcp') : null;
    commitWrite();
    results.push({ client: target.client, file: target.file, status: existed ? 'updated' : 'created', backup });
    lines.push(`+ ${target.client} (${target.file}): registered "${serverName}"${backup ? ` (backup ${backup})` : ''}`);
  }

  if (!results.length) {
    lines.push('no supported MCP client config found; add manually:');
    lines.push(JSON.stringify({ mcpServers: { [serverName]: { command, args } } }, null, 2));
  }

  return { command, args, serverName, results, lines };
}

export async function runMcpCli(flags = {}, deps = {}) {
  if (flags._?.length) {
    throw new Error('usage: keysmith mcp [--register] [--dry-run]');
  }
  if (flags.register || flags.setup) {
    const outStream = deps.stdout || process.stdout;
    const res = registerMcpClients({
      dryRun: Boolean(flags.dryRun),
      ...deps,
    });
    for (const line of res.lines) {
      outStream.write(redactSecrets(line) + '\n');
    }
    return res;
  }
  return await startMcpServer(deps);
}
