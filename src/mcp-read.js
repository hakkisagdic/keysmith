/**
 * keysmith MCP read-only tools (slice 2 of 5):
 *   - keysmith_status
 *   - keysmith_sources
 *   - keysmith_source_models
 *   - keysmith_test
 *   - keysmith_usage
 *   - keysmith_approved
 *
 * Wraps existing keysmith modules without modifying config, touching the real
 * Keychain in tests, or exposing secret values, reference interiors, account
 * identifiers, workspaceFiles contents, or HTTP bodies.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { catalogueSettings, discoveredPath, readDiscovered } from './catalogue.js';
import { which } from './cli-adapter.js';
import { DEFAULTS, jsonErrorWithoutText, loadConfig, resolveSecret } from './config.js';
import { checkAdapter, kindOf } from './gateway.js';
import { computePendingFreeChanges } from './mcp-reload.js';
import { registerTool } from './mcp.js';
import { SOURCE_FACTS } from './profiles.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { isLoaded, labels, launchdPid } from './service.js';
import { sourceNames } from './source.js';
import { isPlainObject } from './tools/model.js';
import { UsageLog, credentialAccount } from './usage.js';

const ANY_REF_RE = /^\{([a-z][a-z0-9_-]*):([\s\S]*)\}$/i;
const KEY_REF_RE = /^\{(exec|json|file|dotenv|env):([\s\S]*)\}$/i;
const EXEC_REF_RE = /^\{exec:([\s\S]*)\}$/i;
const SHELL_META_RE = /[;|&$`\n<>]/;
const CF_ACCOUNT_SEG_RE = /(\/accounts\/)(?!\{account\})(?!\[redacted\])[^/?#]+/gi;

/* ---------------------------------------------------------- safety & scoping */

async function withScopedEnv(ctx, fn) {
  const prevConfig = process.env.KEYSMITH_CONFIG;
  const prevData = process.env.KEYSMITH_DATA;
  const prevHome = process.env.HOME;
  if (ctx?.configFile) process.env.KEYSMITH_CONFIG = ctx.configFile;
  if (ctx?.dataDir) process.env.KEYSMITH_DATA = ctx.dataDir;
  if (ctx?.homeDir !== undefined) process.env.HOME = ctx.homeDir;
  try {
    return await fn();
  } finally {
    if (prevConfig === undefined) delete process.env.KEYSMITH_CONFIG;
    else process.env.KEYSMITH_CONFIG = prevConfig;
    if (prevData === undefined) delete process.env.KEYSMITH_DATA;
    else process.env.KEYSMITH_DATA = prevData;
    if (ctx?.homeDir !== undefined) {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  }
}

function scrubString(value, extraLiterals = []) {
  let s = String(value ?? '');
  for (const lit of extraLiterals) {
    if (typeof lit === 'string' && lit.length >= 4 && s.includes(lit)) {
      s = s.split(lit).join('[redacted]');
    }
  }
  s = s.replace(CF_ACCOUNT_SEG_RE, '$1[redacted]');
  return redactSecrets(s);
}

function scrubOutput(value, extraLiterals = []) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value, extraLiterals);
  if (Array.isArray(value)) return value.map((item) => scrubOutput(item, extraLiterals));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubOutput(v, extraLiterals);
    }
    return out;
  }
  return scrubString(String(value), extraLiterals);
}

function toolError(message, extra = {}, extraLiterals = []) {
  const payload = scrubOutput({ ok: false, error: String(message), ...extra }, extraLiterals);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function readConfigSafe(cfgFile) {
  if (!cfgFile || !fs.existsSync(cfgFile)) {
    return { exists: false, doc: null, error: null };
  }
  let text;
  try {
    text = fs.readFileSync(cfgFile, 'utf8');
  } catch (e) {
    return { exists: true, doc: null, error: `cannot read config (${e.code || 'read_error'})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { exists: true, doc: null, error: jsonErrorWithoutText(e) };
  }
  if (!isPlainObject(doc)) {
    return { exists: true, doc: null, error: 'config root must be a JSON object' };
  }

  const literalKeys = [];
  if (Array.isArray(doc.auth?.keys)) registerSecrets(doc.auth.keys);
  if (isPlainObject(doc.adapters)) {
    for (const raw of Object.values(doc.adapters)) {
      if (!isPlainObject(raw)) continue;
      for (const field of ['apiKey', 'key']) {
        const val = raw[field];
        if (typeof val === 'string' && val && !ANY_REF_RE.test(val)) {
          literalKeys.push(val);
        }
      }
    }
  }
  if (literalKeys.length) registerSecrets(literalKeys);
  return { exists: true, doc, error: null };
}

function extraSecretsForAdapter(raw) {
  const out = [];
  if (!isPlainObject(raw)) return out;
  for (const k of ['accountId', 'account_id']) {
    if (typeof raw[k] === 'string' && raw[k].trim()) out.push(raw[k].trim());
  }
  for (const field of ['apiKey', 'key']) {
    if (typeof raw[field] === 'string' && raw[field].trim() && !ANY_REF_RE.test(raw[field])) {
      out.push(raw[field].trim());
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/* --------------------------------------------------- key refs & sanitizers */

export function classifyKeyRef(raw) {
  if (!isPlainObject(raw)) return 'none';
  const ref = raw.apiKey ?? raw.key ?? null;
  if (Object.hasOwn(raw, 'exec') || (isPlainObject(ref) && Object.hasOwn(ref, 'exec')) || Array.isArray(ref)) {
    return 'exec';
  }
  if (typeof ref === 'string' && ref.trim()) {
    const m = KEY_REF_RE.exec(ref.trim());
    if (m) return m[1].toLowerCase();
    return 'literal';
  }
  if (typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()) {
    return 'env';
  }
  return 'none';
}

function stripQuotes(token) {
  if (token.length >= 2) {
    const q = token[0];
    if ((q === '"' || q === "'") && token[token.length - 1] === q) {
      return token.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return token;
}

function parseSecurityTokens(tokens) {
  let service = null;
  let account = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '-s' && i + 1 < tokens.length) {
      service = tokens[++i];
    } else if (tok.startsWith('-s') && tok.length > 2) {
      service = tok.slice(2);
    } else if (tok === '-a' && i + 1 < tokens.length) {
      account = tokens[++i];
    } else if (tok.startsWith('-a') && tok.length > 2) {
      account = tok.slice(2);
    }
  }
  if (!service) return null;
  return { service, account: account || null };
}

export function parseKeychainExec(rawRef) {
  if (Array.isArray(rawRef)) {
    const bin = typeof rawRef[0] === 'string' ? path.basename(rawRef[0]) : '';
    if (bin !== 'security' || rawRef[1] !== 'find-generic-password') return null;
    return parseSecurityTokens(rawRef.slice(2).filter((t) => typeof t === 'string'));
  }
  if (typeof rawRef !== 'string') return null;
  const m = EXEC_REF_RE.exec(rawRef.trim());
  if (!m) return null;
  const cmd = m[1].trim();
  if (!cmd || SHELL_META_RE.test(cmd)) return null;
  const head = /^(?:\/usr\/bin\/)?security\s+find-generic-password(?:\s+([\s\S]*))?$/.exec(cmd);
  if (!head) return null;
  const rest = head[1] || '';
  const tokens = [];
  for (const tokMatch of rest.matchAll(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g)) {
    tokens.push(stripQuotes(tokMatch[0]));
  }
  return parseSecurityTokens(tokens);
}

function rawExecRef(raw) {
  if (!isPlainObject(raw)) return null;
  const ref = raw.apiKey ?? raw.key ?? null;
  if (isPlainObject(ref) && Object.hasOwn(ref, 'exec')) return ref.exec;
  if (Object.hasOwn(raw, 'exec')) return raw.exec;
  return ref;
}

async function checkKeychainExists(raw, ctx) {
  const parsed = parseKeychainExec(rawExecRef(raw));
  if (!parsed) return 'no';
  if (typeof ctx?.keychainHas === 'function') {
    return (await ctx.keychainHas(parsed.service, parsed.account)) ? 'yes' : 'no';
  }
  const bin = process.env.KEYSMITH_SECURITY_BIN || '/usr/bin/security';
  const args = ['find-generic-password', '-s', parsed.service, ...(parsed.account ? ['-a', parsed.account] : [])];
  try {
    const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0 ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

export function sanitizeBaseUrl(rawUrl, rawAdapter = null) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let cleaned = rawUrl.trim().replace(/\/+$/, '');
  try {
    const u = new URL(cleaned);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    cleaned = u.toString().replace(/\/+$/, '');
  } catch {
    // Keep non-URL strings sanitized below.
  }
  return scrubString(cleaned, extraSecretsForAdapter(rawAdapter));
}

export function extractDeclaredModelIds(rawModels) {
  if (Array.isArray(rawModels)) {
    return rawModels
      .map((m) => (typeof m === 'string' ? m : isPlainObject(m) ? m.id : null))
      .filter((id) => typeof id === 'string' && id.length > 0);
  }
  if (isPlainObject(rawModels)) {
    return Object.keys(rawModels).filter((id) => typeof id === 'string' && id.length > 0);
  }
  return [];
}

/* ----------------------------------------------------------- status helpers */

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidRecord(dataDirPath) {
  if (!dataDirPath) return null;
  const file = path.join(dataDirPath, 'keysmith.pid');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readLaunchdState(ctx) {
  if (typeof ctx?.launchd === 'function') {
    return await ctx.launchd();
  }
  if (isPlainObject(ctx?.launchd)) {
    const l = ctx.launchd;
    const loaded = Boolean(l.loaded);
    const pid = Number.isInteger(l.pid) && l.pid > 0 ? l.pid : null;
    return {
      label: typeof l.label === 'string' && l.label ? l.label : labels.gateway,
      state: typeof l.state === 'string' && l.state ? l.state : loaded ? (pid ? 'running' : 'loaded') : 'not_loaded',
      loaded,
      pid,
      tunnel: isPlainObject(l.tunnel)
        ? {
            label: typeof l.tunnel.label === 'string' && l.tunnel.label ? l.tunnel.label : labels.tunnel,
            loaded: Boolean(l.tunnel.loaded),
            pid: Number.isInteger(l.tunnel.pid) && l.tunnel.pid > 0 ? l.tunnel.pid : null,
          }
        : { label: labels.tunnel, loaded: false, pid: null },
    };
  }
  if (process.platform === 'darwin' || typeof ctx?.launchctl === 'function') {
    const run = typeof ctx?.launchctl === 'function' ? ctx.launchctl : undefined;
    const gatewayLoaded = isLoaded(labels.gateway, run);
    const gatewayPid = gatewayLoaded ? launchdPid(labels.gateway, run) : null;
    const tunnelLoaded = isLoaded(labels.tunnel, run);
    const tunnelPid = tunnelLoaded ? launchdPid(labels.tunnel, run) : null;
    return {
      label: labels.gateway,
      state: gatewayLoaded ? (gatewayPid ? 'running' : 'loaded') : 'not_loaded',
      loaded: gatewayLoaded,
      pid: gatewayPid,
      tunnel: {
        label: labels.tunnel,
        loaded: tunnelLoaded,
        pid: tunnelPid,
      },
    };
  }
  return {
    label: labels.gateway,
    state: 'unsupported',
    loaded: false,
    pid: null,
    tunnel: { label: labels.tunnel, loaded: false, pid: null },
  };
}

async function probeHealthz(baseUrl, ctx) {
  const fetchFn = typeof ctx?.fetch === 'function' ? ctx.fetch : globalThis.fetch;
  const timeoutMs = Number.isFinite(ctx?.healthzTimeoutMs) ? ctx.healthzTimeoutMs : 3000;
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/healthz`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return {
      ok: Boolean(res.ok && parsed?.ok !== false),
      reachable: true,
      httpStatus: res.status,
      ...(typeof parsed?.uptime_s === 'number' ? { uptimeSeconds: parsed.uptime_s } : {}),
      ...(typeof parsed?.adapters === 'number' ? { adapters: parsed.adapters } : {}),
      ...(typeof parsed?.failed_to_load === 'number' ? { failedToLoad: parsed.failed_to_load } : {}),
      ...(typeof parsed?.alias_warnings === 'number' ? { aliasWarnings: parsed.alias_warnings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      httpStatus: null,
      error: scrubString(err?.message || String(err)),
    };
  }
}

/* ------------------------------------------------------------- tool handlers */

async function handleStatus(_args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const cfgRes = readConfigSafe(ctx.configFile);
    const doc = cfgRes.doc;
    const adapters = isPlainObject(doc?.adapters) ? doc.adapters : {};
    const totalSources = Object.keys(adapters).length;
    const enabledSources = Object.values(adapters).filter((a) => isPlainObject(a) && !a.disabled).length;
    const disabledSources = totalSources - enabledSources;
    const configuredPort = Number.isInteger(doc?.port) ? doc.port : DEFAULTS.port;

    const launchd = await readLaunchdState(ctx);
    const rec = readPidRecord(ctx.dataDir);
    const isAlive = typeof ctx?.isPidAlive === 'function' ? ctx.isPidAlive : defaultPidAlive;

    let running = false;
    let pid = null;
    let port = configuredPort;

    if (Number.isInteger(rec?.pid) && rec.pid > 0 && isAlive(rec.pid)) {
      running = true;
      pid = rec.pid;
      if (Number.isInteger(rec.port)) port = rec.port;
    } else if (Number.isInteger(launchd?.pid) && launchd.pid > 0 && isAlive(launchd.pid)) {
      running = true;
      pid = launchd.pid;
      if (Number.isInteger(rec?.port)) port = rec.port;
    }

    const shouldProbe = running || (typeof ctx?.gatewayUrl === 'string' && ctx.gatewayUrl.length > 0);
    const healthz = shouldProbe
      ? await probeHealthz(ctx?.gatewayUrl || `http://127.0.0.1:${port}`, ctx)
      : { ok: false, reachable: false, httpStatus: null, reason: 'not_running' };

    return scrubOutput({
      ok: !cfgRes.error,
      configLoaded: cfgRes.exists && !cfgRes.error,
      ...(cfgRes.error ? { configError: cfgRes.error } : {}),
      running,
      pid,
      port,
      enabledSources,
      disabledSources,
      totalSources,
      launchd,
      healthz,
    });
  });
}

async function handleSources(args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const cfgRes = readConfigSafe(ctx.configFile);
    if (cfgRes.error) return toolError(cfgRes.error);
    const doc = cfgRes.doc || {};
    const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
    const includeDisabled = args?.includeDisabled !== false;

    const sources = [];
    for (const [id, raw] of Object.entries(adapters)) {
      if (!isPlainObject(raw)) continue;
      const disabled = Boolean(raw.disabled);
      if (!includeDisabled && disabled) continue;
      const kind = kindOf(raw);
      sources.push({
        id,
        kind,
        wire: kind === 'http' ? String(raw.wire || 'openai') : null,
        baseUrl: kind === 'http' ? sanitizeBaseUrl(raw.baseUrl, raw) : null,
        disabled,
        explicitOnly: Boolean(raw.explicitOnly || raw.unsafeTools),
        modelsOnly: raw.modelsOnly === true,
        freeOnly: raw.freeOnly === true,
        modelCount: extractDeclaredModelIds(raw.models).length,
        keyRefType: classifyKeyRef(raw),
        keychainExists: await checkKeychainExists(raw, ctx),
      });
    }

    const profiles = sourceNames().map((name) => {
      const facts = SOURCE_FACTS[name] || {};
      return {
        id: name,
        attached: Object.hasOwn(adapters, name),
        freeOnly: Boolean(facts.freeOnly),
        ...(facts.note ? { note: facts.note } : {}),
      };
    });

    return scrubOutput({
      ok: true,
      configLoaded: cfgRes.exists,
      sources,
      profiles,
    });
  });
}

async function handleSourceModels(args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const source = typeof args?.source === 'string' ? args.source.trim() : '';
    if (!source) return toolError('source is required');

    const cfgRes = readConfigSafe(ctx.configFile);
    if (cfgRes.error) return toolError(cfgRes.error);
    const doc = cfgRes.doc || {};
    const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
    if (!Object.hasOwn(adapters, source) || !isPlainObject(adapters[source])) {
      return toolError(`unknown source "${source}"`, { source });
    }

    const raw = adapters[source];
    const extraLiterals = extraSecretsForAdapter(raw);
    const declaredIds = extractDeclaredModelIds(raw.models);
    const declaredSet = new Set(declaredIds);
    const kind = kindOf(raw);
    const enforced = kind === 'http';
    const modelsOnly = enforced && raw.modelsOnly === true;
    const freeOnly = enforced && raw.freeOnly === true;

    const settings = catalogueSettings(doc);
    const discSet = enforced ? readDiscovered(discoveredPath(ctx.dataDir, source)) : null;

    let discoveryAvailable = false;
    let discoveryMessage = null;
    let discoveredFree = [];
    let onlyInDiscovered = [];
    let onlyInModels = [];

    if (discSet !== null) {
      discoveryAvailable = true;
      discoveredFree = [...discSet];
      onlyInDiscovered = discoveredFree.filter((m) => !declaredSet.has(m));
      onlyInModels = declaredIds.filter((m) => !discSet.has(m));
    } else if (kind === 'cli') {
      discoveryMessage = 'model discovery is not used for CLI sources';
    } else if (!settings.discovery.enabled) {
      discoveryMessage = 'discovery is disabled in config (discovery.enabled is false); run keysmith discover after enabling';
    } else {
      discoveryMessage = `no discovered free list cached for "${source}" yet (run keysmith discover)`;
    }

    const allIds = discoveryAvailable ? [...declaredIds, ...onlyInDiscovered] : declaredIds;
    const models = allIds.map((id) => {
      const configured = declaredSet.has(id);
      const approved = enforced && modelsOnly && configured;
      return {
        id,
        approved,
        status: approved ? 'approved' : 'unapproved',
        configured,
        discoveredFree: discoveryAvailable ? discSet.has(id) : null,
      };
    });

    return scrubOutput(
      {
        ok: true,
        source,
        kind,
        enforced,
        modelsOnly,
        freeOnly,
        configuredModels: declaredIds,
        models,
        discovery: {
          available: discoveryAvailable,
          message: discoveryMessage,
          discoveredFree,
          diff: {
            onlyInDiscovered,
            onlyInModels,
          },
        },
      },
      extraLiterals,
    );
  });
}

async function resolveHttpProbeKey(raw, ctx) {
  const keyRefType = classifyKeyRef(raw);
  const kc = parseKeychainExec(rawExecRef(raw));

  if (kc) {
    const exists = await checkKeychainExists(raw, ctx);
    if (exists !== 'yes') {
      return { ok: false, status: 'missing_credentials', key: null };
    }
    if (typeof ctx?.keychainRead === 'function') {
      const val = await ctx.keychainRead(kc.service, kc.account);
      return val ? { ok: true, key: String(val).trim() } : { ok: false, status: 'missing_credentials', key: null };
    }
    if (typeof ctx?.keychainHas === 'function') {
      // Tests injecting keychainHas without keychainRead must never invoke /usr/bin/security.
      return { ok: true, key: 'ks_test_kc_placeholder' };
    }
    const bin = process.env.KEYSMITH_SECURITY_BIN || '/usr/bin/security';
    const args = ['find-generic-password', '-s', kc.service, ...(kc.account ? ['-a', kc.account] : []), '-w'];
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
    const val = r.status === 0 ? String(r.stdout || '').trim() : '';
    return val ? { ok: true, key: val } : { ok: false, status: 'missing_credentials', key: null };
  }

  if (keyRefType === 'exec') {
    let val = null;
    try {
      val =
        typeof ctx?.resolveSecret === 'function'
          ? await ctx.resolveSecret(raw.apiKey ?? raw.key ?? null)
          : resolveSecret(raw.apiKey ?? raw.key ?? null, ctx?.env || process.env);
    } catch {
      return { ok: false, status: 'invalid_credentials', error: 'secret reference could not be read', key: null };
    }
    return val ? { ok: true, key: String(val) } : { ok: false, status: 'missing_credentials', key: null };
  }

  let resolved = null;
  try {
    resolved =
      typeof ctx?.resolveSecret === 'function'
        ? await ctx.resolveSecret(raw.apiKey ?? raw.key ?? null)
        : resolveSecret(raw.apiKey ?? raw.key ?? null, ctx?.env || process.env);
  } catch {
    return { ok: false, status: 'invalid_credentials', error: 'secret reference could not be read', key: null };
  }

  if (!resolved && typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()) {
    const envObj = ctx?.env || process.env;
    resolved = envObj[raw.apiKeyEnv.trim()] || null;
  }

  if (keyRefType !== 'none' && !resolved) {
    return { ok: false, status: 'missing_credentials', key: null };
  }
  return { ok: true, key: resolved || null };
}

async function handleTest(args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const source = typeof args?.source === 'string' ? args.source.trim() : '';
    if (!source) return toolError('source is required');

    const cfgRes = readConfigSafe(ctx.configFile);
    if (cfgRes.error) return toolError(cfgRes.error);
    const doc = cfgRes.doc || {};
    const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
    if (!Object.hasOwn(adapters, source) || !isPlainObject(adapters[source])) {
      return toolError(`unknown source "${source}"`, { source });
    }

    const raw = adapters[source];
    const extraLiterals = extraSecretsForAdapter(raw);
    const t0 = performance.now();
    const latency = () => Math.max(0, Math.round(performance.now() - t0));

    let adapter;
    try {
      adapter = checkAdapter(source, raw);
    } catch (e) {
      return scrubOutput(
        {
          ok: false,
          source,
          kind: kindOf(raw),
          status: 'invalid_config',
          httpStatus: null,
          latencyMs: latency(),
          error: scrubString(e?.message || String(e), extraLiterals),
        },
        extraLiterals,
      );
    }

    if (adapter.disabled) {
      return scrubOutput(
        {
          ok: false,
          source,
          kind: adapter.kind,
          disabled: true,
          status: 'disabled',
          httpStatus: null,
          latencyMs: latency(),
        },
        extraLiterals,
      );
    }

    if (adapter.kind === 'cli') {
      const whichFn = typeof ctx?.which === 'function' ? ctx.which : which;
      const found = Boolean(whichFn(adapter.bin));
      return scrubOutput(
        {
          ok: found,
          source,
          kind: 'cli',
          status: found ? 'ok' : 'binary_missing',
          httpStatus: null,
          latencyMs: latency(),
        },
        extraLiterals,
      );
    }

    const cred = await resolveHttpProbeKey(raw, ctx);
    if (!cred.ok) {
      return scrubOutput(
        {
          ok: false,
          source,
          kind: 'http',
          status: cred.status,
          httpStatus: null,
          latencyMs: latency(),
          ...(cred.error ? { error: cred.error } : {}),
        },
        extraLiterals,
      );
    }

    if (cred.key) {
      registerSecrets([cred.key]);
      extraLiterals.push(cred.key);
    }

    adapter._apiKey = cred.key;
    const modelsPath = adapter.wire === 'traycer' ? '/api/traycer/models' : '/models';
    const url = adapter.route(modelsPath);
    const headers = { accept: 'application/json', ...adapter.authHeaders(), ...adapter.headers };
    const fetchFn = typeof ctx?.fetch === 'function' ? ctx.fetch : globalThis.fetch;
    const timeoutMs = Number.isFinite(ctx?.testTimeoutMs) ? ctx.testTimeoutMs : 10_000;

    let res;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return scrubOutput(
        {
          ok: false,
          source,
          kind: 'http',
          status: 'unreachable',
          httpStatus: null,
          latencyMs: latency(),
          error: scrubString(e?.message || String(e), extraLiterals),
        },
        extraLiterals,
      );
    }

    // Never read or return HTTP response bodies.
    try {
      await res.body?.cancel?.();
    } catch {}

    let status;
    if (res.ok) status = 'ok';
    else if (res.status === 401 || res.status === 403) status = 'unauthorized';
    else if (res.status === 404 || res.status === 405) status = 'no_models_endpoint';
    else if (res.status === 429) status = 'rate_limited';
    else status = 'http_error';

    return scrubOutput(
      {
        ok: Boolean(res.ok),
        source,
        kind: 'http',
        status,
        httpStatus: res.status,
        latencyMs: latency(),
      },
      extraLiterals,
    );
  });
}

function formatSpendCap(cap) {
  return {
    scope: cap.kind,
    capUsd: cap.cap,
    spentUsd: cap.spent,
    remainingUsd: cap.remaining,
    exceeded: Boolean(cap.exceeded),
    ...(cap.month ? { month: cap.month } : {}),
    ...(cap.resetAt ? { resetAt: cap.resetAt } : {}),
    ...(cap.window ? { window: cap.window, windowStatus: cap.windowStatus } : {}),
    ...(cap.error ? { error: cap.error } : {}),
  };
}

async function handleUsage(args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const cfgRes = readConfigSafe(ctx.configFile);
    if (cfgRes.error) return toolError(cfgRes.error);

    let cfg;
    try {
      cfg = cfgRes.exists ? loadConfig({ path: ctx.configFile, mint: false }) : structuredClone(DEFAULTS);
    } catch (e) {
      return toolError(scrubString(e?.message || String(e)));
    }

    const filterSource = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : null;
    let hours = null;
    if (args?.hours !== undefined && args?.hours !== null) {
      hours = Number(args.hours);
      if (!Number.isFinite(hours) || hours < 0) {
        return toolError('hours must be a non-negative number');
      }
    }

    const usageFile = path.join(ctx.dataDir, 'usage.jsonl');
    const usage = new UsageLog(usageFile, {
      pricing: cfg?.pricing,
      now: typeof ctx?.now === 'function' ? ctx.now : null,
    });
    const readErrors = usage.checkReadable();

    let stats;
    try {
      stats = usage.query({
        by: ['adapter'],
        since: args?.since ?? null,
        until: args?.until ?? null,
        hours,
        filter: filterSource ? (e) => e?.adapter === filterSource : null,
      });
    } catch (e) {
      return toolError(scrubString(e?.message || String(e)));
    }

    const spendCaps = usage.spendSummary(cfg?.limits?.spend, { adapters: cfg?.adapters });
    const configuredAdapters = isPlainObject(cfg?.adapters) ? cfg.adapters : {};
    const groupByAdapter = new Map();
    for (const g of stats.groups || []) {
      if (typeof g.adapter === 'string' && g.adapter) {
        groupByAdapter.set(g.adapter, g);
      }
    }

    const allIds = new Set(Object.keys(configuredAdapters));
    for (const id of groupByAdapter.keys()) allIds.add(id);
    for (const c of spendCaps) {
      if (c.kind === 'adapter' && typeof c.target === 'string' && c.target) allIds.add(c.target);
    }

    const sourceIds = filterSource ? (allIds.has(filterSource) ? [filterSource] : []) : [...allIds];
    const sources = sourceIds.map((id) => {
      const bucket = groupByAdapter.get(id) || null;
      const raw = configuredAdapters[id];
      const acct = raw ? credentialAccount(raw, { dataDir: ctx.dataDir }) : null;
      const matchingCaps = spendCaps.filter(
        (c) => (c.kind === 'adapter' && c.target === id) || (c.kind === 'account' && acct && c.target === acct),
      );
      let remainingHeadroomUsd = null;
      let spendCap = null;
      if (matchingCaps.length) {
        const sorted = [...matchingCaps].sort((a, b) => Number(a.remaining ?? 0) - Number(b.remaining ?? 0));
        remainingHeadroomUsd = Number(sorted[0].remaining ?? 0);
        spendCap = formatSpendCap(sorted[0]);
      }

      const tokens = bucket
        ? bucket.tokens
          ? {
              input: bucket.input,
              output: bucket.output,
              cacheRead: bucket.cacheRead,
              cacheWrite: bucket.cacheWrite,
              total: (bucket.input || 0) + (bucket.output || 0),
            }
          : null
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

      return {
        id,
        requests: bucket ? bucket.requests : 0,
        failures: bucket ? bucket.failures : 0,
        refused: bucket ? bucket.refused : 0,
        tokens,
        spendUsd: bucket ? bucket.meteredUsd : 0,
        listUsd: bucket ? bucket.listUsd : 0,
        remainingHeadroomUsd,
        spendCap,
      };
    });

    const totalTokens = stats.tokens
      ? {
          input: stats.input,
          output: stats.output,
          cacheRead: stats.cacheRead,
          cacheWrite: stats.cacheWrite,
          total: (stats.input || 0) + (stats.output || 0),
        }
      : null;

    return scrubOutput({
      ok: true,
      since: stats.since,
      until: stats.until,
      totals: {
        requests: stats.requests,
        failures: stats.failures,
        refused: stats.refused,
        tokens: totalTokens,
        spendUsd: stats.meteredUsd,
        listUsd: stats.listUsd,
      },
      sources,
      ...(readErrors.length ? { readErrors } : {}),
    });
  });
}

async function handleApproved(args, ctx) {
  return await withScopedEnv(ctx, async () => {
    const cfgRes = readConfigSafe(ctx.configFile);
    if (cfgRes.error) return toolError(cfgRes.error);
    const doc = cfgRes.doc || {};
    const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
    const filterSource = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : null;

    const approved = {};
    for (const [id, raw] of Object.entries(adapters)) {
      if (filterSource && id !== filterSource) continue;
      if (isPlainObject(raw) && kindOf(raw) === 'http' && raw.modelsOnly === true) {
        approved[id] = extractDeclaredModelIds(raw.models);
      }
    }

    return scrubOutput({
      ok: true,
      configLoaded: cfgRes.exists,
      approved,
      pending: computePendingFreeChanges(doc, {
        dataDir: ctx.dataDir,
        filterSource,
        previousCatalogue: ctx?.previousCatalogue,
      }),
    });
  });
}

/* -------------------------------------------------------------- registration */

const READ_TOOLS = [
  {
    name: 'keysmith_status',
    description: 'Report gateway launchd state, PID, port, /healthz check, and enabled/disabled source counts.',
    inputSchema: { type: 'object', properties: {} },
    handler: handleStatus,
  },
  {
    name: 'keysmith_sources',
    description: 'List configured sources with non-secret metadata, key reference type, and Keychain existence.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: {
          type: 'boolean',
          description: 'Include disabled sources (default: true).',
        },
      },
    },
    handler: handleSources,
  },
  {
    name: 'keysmith_source_models',
    description: "Inspect a source's configured models, approved/unapproved status, and diff against cached free discovery.",
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Configured source (adapter) id.',
        },
      },
      required: ['source'],
    },
    handler: handleSourceModels,
  },
  {
    name: 'keysmith_test',
    description: 'Run a non-destructive health check on one configured source and report status and latency without response bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Configured source (adapter) id to health-test.',
        },
      },
      required: ['source'],
    },
    handler: handleTest,
  },
  {
    name: 'keysmith_usage',
    description: 'Report per-source requests, token counts, spend, and remaining headroom to configured limits.spend caps.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Optional source (adapter) id filter.' },
        since: { type: 'string', description: 'Optional ISO timestamp or YYYY-MM-DD start bound.' },
        until: { type: 'string', description: 'Optional ISO timestamp or YYYY-MM-DD end bound.' },
        hours: { type: 'number', description: 'Optional lookback window in hours.' },
      },
    },
    handler: handleUsage,
  },
  {
    name: 'keysmith_approved',
    description: 'Return the approved model lists (modelsOnly sources) and pending free-flag review entries.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Optional source (adapter) id filter.' },
      },
    },
    handler: handleApproved,
  },
];

export function registerTools(register = registerTool) {
  for (const def of READ_TOOLS) {
    register({
      ...def,
      write: false,
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  }
}
