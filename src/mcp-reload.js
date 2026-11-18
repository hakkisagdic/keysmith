/**
 * keysmith MCP reload tool & catalogue pending-review diff (slice 4 of 5):
 *   - keysmith_reload
 *   - computePendingFreeChanges (wired into keysmith_approved in src/mcp-read.js)
 *
 * Wraps src/service.js (`reloadAgent`, `launchdPid`, `isLoaded`, `launchAgentsDir`)
 * and src/catalogue.js (`loadCatalogue`, `catalogueSettings`, `readDiscovered`,
 * `discoveredPath`), requires `confirm: true` (enforced centrally in src/mcp.js),
 * warns when requests are in flight, waits for `/healthz`, and scrubs secrets
 * and directory paths from all outputs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { catalogueSettings, discoveredPath, loadCatalogue, readDiscovered } from './catalogue.js';
import { DEFAULTS, expand, jsonErrorWithoutText } from './config.js';
import { kindOf } from './gateway.js';
import { registerTool } from './mcp.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { isLoaded, labels, launchAgentsDir, launchdPid, reloadAgent } from './service.js';
import { isPlainObject } from './tools/model.js';

const ANY_REF_RE = /^\{([a-z][a-z0-9_-]*):([\s\S]*)\}$/i;
const CF_ACCOUNT_SEG_RE = /(\/accounts\/)(?!\{account\})(?!\[redacted\])[^/?#]+/gi;

let reloadQueue = Promise.resolve();

function withReloadLock(fn) {
  const next = reloadQueue.then(fn, fn);
  reloadQueue = next.catch(() => {});
  return next;
}

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

/* ---------------------------------------------------------- safety & scrubbing */

function collectExtraLiterals(cfgFile, seed = []) {
  const literals = [];
  for (const item of seed) {
    if (typeof item === 'string' && item.trim().length >= 4) {
      literals.push(item.trim());
    }
  }
  if (cfgFile && fs.existsSync(cfgFile)) {
    try {
      const doc = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (isPlainObject(doc)) {
        if (Array.isArray(doc.auth?.keys)) registerSecrets(doc.auth.keys);
        const literalKeys = [];
        if (isPlainObject(doc.adapters)) {
          for (const raw of Object.values(doc.adapters)) {
            if (!isPlainObject(raw)) continue;
            for (const k of ['accountId', 'account_id']) {
              if (typeof raw[k] === 'string' && raw[k].trim()) literals.push(raw[k].trim());
            }
            for (const field of ['apiKey', 'key']) {
              const val = raw[field];
              if (typeof val === 'string' && val.trim() && !ANY_REF_RE.test(val.trim())) {
                literalKeys.push(val.trim());
                literals.push(val.trim());
              }
            }
          }
        }
        if (literalKeys.length) registerSecrets(literalKeys);
      }
    } catch {
      // Unreadable or malformed config is handled by readConfigSafe.
    }
  }
  return [...new Set(literals)].sort((a, b) => b.length - a.length);
}

function pathReplacements(ctx) {
  const pairs = [];
  const cfgFile = typeof ctx?.configFile === 'string' ? ctx.configFile : '';
  const dataDir = typeof ctx?.dataDir === 'string' ? ctx.dataDir : '';
  const cfgDir = cfgFile ? path.dirname(cfgFile) : '';
  const home = typeof ctx?.homeDir === 'string' && ctx.homeDir ? ctx.homeDir : os.homedir();

  if (cfgFile) pairs.push([cfgFile, path.basename(cfgFile)]);
  if (dataDir) pairs.push([dataDir, '[dataDir]']);
  if (cfgDir && cfgDir !== '.' && cfgDir !== path.sep) {
    pairs.push([cfgDir + path.sep, '']);
    pairs.push([cfgDir, '[configDir]']);
  }
  if (home && home !== path.sep) {
    pairs.push([home + path.sep, '~/']);
    pairs.push([home, '~']);
  }
  if (process.env.HOME && process.env.HOME !== home && process.env.HOME !== path.sep) {
    pairs.push([process.env.HOME + path.sep, '~/']);
    pairs.push([process.env.HOME, '~']);
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function scrubString(value, extraLiterals = [], ctx = null) {
  let s = String(value ?? '');
  for (const lit of extraLiterals) {
    if (typeof lit === 'string' && lit.length >= 4 && s.includes(lit)) {
      s = s.split(lit).join('[redacted]');
    }
  }
  for (const [needle, repl] of pathReplacements(ctx)) {
    if (needle && s.includes(needle)) {
      s = s.split(needle).join(repl);
    }
  }
  s = s.replace(CF_ACCOUNT_SEG_RE, '$1[redacted]');
  return redactSecrets(s);
}

function scrubOutput(value, extraLiterals = [], ctx = null) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value, extraLiterals, ctx);
  if (Array.isArray(value)) return value.map((item) => scrubOutput(item, extraLiterals, ctx));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubOutput(v, extraLiterals, ctx);
    }
    return out;
  }
  return scrubString(String(value), extraLiterals, ctx);
}

function toolError(message, extra = {}, extraLiterals = [], ctx = null) {
  const payload = scrubOutput({ ok: false, error: String(message), ...extra }, extraLiterals, ctx);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function readConfigSafe(cfgFile) {
  if (!cfgFile || !fs.existsSync(cfgFile)) {
    return { exists: false, doc: null, error: 'config file does not exist; run keysmith init first' };
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
  return { exists: true, doc, error: null };
}

/* ------------------------------------------- pending free-flag diff computation */

function extractDeclaredModelIds(rawModels) {
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

function resolveCatalogueMap(source) {
  if (source instanceof Map) return source;
  if (typeof source === 'string' && source.trim()) {
    return loadCatalogue(expand(source.trim()), { log: () => {} }).get();
  }
  return null;
}

function orderedUnion(...collections) {
  const seen = new Set();
  const out = [];
  for (const col of collections) {
    if (!col) continue;
    for (const item of col) {
      if (typeof item === 'string' && item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Compute pending "free flag changed" entries for `keysmith_approved` by comparing
 * the configured catalogue (`loadCatalogue`), cached free discovery (`readDiscovered`),
 * optional previous catalogue snapshot, and the source's approved/declared model list.
 *
 * Returns `{ source, model, oldFree, newFree }[]` with no extra fields or secrets.
 */
export function computePendingFreeChanges(doc, { dataDir = null, filterSource = null, previousCatalogue = null } = {}) {
  if (!isPlainObject(doc)) return [];
  const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
  const settings = catalogueSettings(doc);
  const catMap = settings.path ? loadCatalogue(settings.path, { log: () => {} }).get() : new Map();
  const prevCatMap = resolveCatalogueMap(previousCatalogue);

  const pending = [];
  const emitted = new Set();

  const record = (source, model, oldFree, newFree) => {
    const key = `${source}\0${model}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    pending.push({
      source: String(source),
      model: String(model),
      oldFree: Boolean(oldFree),
      newFree: Boolean(newFree),
    });
  };

  for (const [source, raw] of Object.entries(adapters)) {
    if (!isPlainObject(raw)) continue;
    if (filterSource && source !== filterSource) continue;

    const declaredIds = extractDeclaredModelIds(raw.models);
    const hasApprovedBaseline = raw.modelsOnly === true || declaredIds.length > 0;
    const approvedSet = new Set(declaredIds);
    const catEntry = catMap.get(source) || null;
    const prevCatEntry = prevCatMap?.get?.(source) || null;
    const discSet = dataDir && kindOf(raw) === 'http' ? readDiscovered(discoveredPath(dataDir, source)) : null;

    if (prevCatEntry) {
      const candidates = orderedUnion(prevCatEntry.models.keys(), catEntry?.models?.keys(), discSet);
      for (const m of candidates) {
        const oldFree = prevCatEntry.models.has(m) ? prevCatEntry.models.get(m) === 'free' : approvedSet.has(m);
        const newFree =
          discSet !== null
            ? catEntry?.models?.has(m) && catEntry.models.get(m) !== 'free'
              ? false
              : discSet.has(m)
            : catEntry
              ? catEntry.models.get(m) === 'free'
              : oldFree;
        if (oldFree !== newFree && !(hasApprovedBaseline && approvedSet.has(m) === newFree)) {
          record(source, m, oldFree, newFree);
        }
      }
      continue;
    }

    if (catEntry && discSet !== null) {
      if (hasApprovedBaseline) {
        const candidates = orderedUnion(approvedSet, catEntry.models.keys(), discSet);
        for (const m of candidates) {
          const oldFree = approvedSet.has(m);
          const newFree = catEntry.models.has(m) && catEntry.models.get(m) !== 'free' ? false : discSet.has(m);
          if (oldFree !== newFree) record(source, m, oldFree, newFree);
        }
      } else {
        const candidates = orderedUnion(catEntry.models.keys(), discSet);
        for (const m of candidates) {
          const oldFree = catEntry.models.get(m) === 'free';
          const newFree = discSet.has(m);
          if (oldFree !== newFree) record(source, m, oldFree, newFree);
        }
      }
      continue;
    }

    if (catEntry) {
      for (const m of catEntry.models.keys()) {
        const oldFree = hasApprovedBaseline ? approvedSet.has(m) : false;
        const newFree = catEntry.models.get(m) === 'free';
        if (oldFree !== newFree) record(source, m, oldFree, newFree);
      }
      continue;
    }

    if (discSet !== null && hasApprovedBaseline) {
      const candidates = orderedUnion(approvedSet, discSet);
      for (const m of candidates) {
        const oldFree = approvedSet.has(m);
        const newFree = discSet.has(m);
        if (oldFree !== newFree) record(source, m, oldFree, newFree);
      }
    }
  }

  return pending;
}

/* ----------------------------------------------------------- reload helpers */

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

function countChildProcesses(ppid) {
  if (!Number.isInteger(ppid) || ppid <= 0) return 0;
  try {
    const out = execFileSync('ps', ['-Ao', 'ppid='], { encoding: 'utf8', timeout: 1000 });
    let count = 0;
    for (const line of out.split('\n')) {
      if (Number(line.trim()) === ppid) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function resolvePid({ runLaunchctl, dataDir, isAlive }) {
  const loaded = isLoaded(labels.gateway, runLaunchctl);
  const lpid = loaded ? launchdPid(labels.gateway, runLaunchctl) : null;
  const rec = readPidRecord(dataDir);
  const pid =
    (Number.isInteger(lpid) && lpid > 0 ? lpid : null) ??
    (Number.isInteger(rec?.pid) && rec.pid > 0 && isAlive(rec.pid) ? rec.pid : null);
  return { pid, rec };
}

function resolveGatewayUrl(ctx, port) {
  if (typeof ctx?.gatewayUrl === 'function') return String(ctx.gatewayUrl() || '').trim();
  if (typeof ctx?.gatewayUrl === 'string' && ctx.gatewayUrl.trim()) return ctx.gatewayUrl.trim();
  return `http://127.0.0.1:${port}`;
}

async function probeHealthz(baseUrl, ctx, extraLiterals = []) {
  const fetchFn = typeof ctx?.fetch === 'function' ? ctx.fetch : globalThis.fetch;
  const timeoutMs = Number.isFinite(ctx?.healthzTimeoutMs) ? ctx.healthzTimeoutMs : 3000;
  const target = `${String(baseUrl || '').replace(/\/+$/, '')}/healthz`;
  try {
    const res = await fetchFn(target, {
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
    const rawInFlight = parsed?.in_flight ?? parsed?.inFlight ?? parsed?.active_requests ?? parsed?.activeRequests;
    const inFlight =
      typeof rawInFlight === 'number' && Number.isFinite(rawInFlight) && rawInFlight >= 0
        ? Math.floor(rawInFlight)
        : null;
    return {
      inFlight,
      healthz: {
        ok: Boolean(res.ok && parsed?.ok !== false),
        reachable: true,
        httpStatus: res.status,
        ...(typeof parsed?.uptime_s === 'number' ? { uptimeSeconds: parsed.uptime_s } : {}),
        ...(typeof parsed?.adapters === 'number' ? { adapters: parsed.adapters } : {}),
        ...(typeof parsed?.failed_to_load === 'number' ? { failedToLoad: parsed.failed_to_load } : {}),
        ...(typeof parsed?.alias_warnings === 'number' ? { aliasWarnings: parsed.alias_warnings } : {}),
      },
    };
  } catch (err) {
    return {
      inFlight: null,
      healthz: {
        ok: false,
        reachable: false,
        httpStatus: null,
        error: scrubString(err?.message || String(err), extraLiterals, ctx),
      },
    };
  }
}

async function detectInFlight(ctx, { previousPid, portBefore, hasInjectedDoubles, extraLiterals }) {
  if (typeof ctx?.inFlight === 'function') {
    const n = Number(await ctx.inFlight());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  if (typeof ctx?.inFlight === 'number' && Number.isFinite(ctx.inFlight) && ctx.inFlight >= 0) {
    return Math.floor(ctx.inFlight);
  }
  if (typeof ctx?.gateway?.inFlight === 'number' && Number.isFinite(ctx.gateway.inFlight)) {
    return Math.max(0, Math.floor(ctx.gateway.inFlight));
  }
  if (previousPid !== null || ctx?.gatewayUrl) {
    const pre = await probeHealthz(resolveGatewayUrl(ctx, portBefore), ctx, extraLiterals);
    if (pre.inFlight !== null) return pre.inFlight;
  }
  if (!hasInjectedDoubles && previousPid !== null && previousPid > 0) {
    return countChildProcesses(previousPid);
  }
  return 0;
}

function buildReloadPayload({
  restarted = false,
  previousPid = null,
  pid = null,
  port,
  healthzStatus = 'unreachable',
  healthz = { ok: false, reachable: false, httpStatus: null },
  latencyMs = 0,
  inFlight = 0,
  inFlightWarning = null,
  enabledSources = 0,
  disabledSources = 0,
  totalSources = 0,
}) {
  return {
    restarted,
    label: labels.gateway,
    previousPid,
    pid,
    pidChanged: previousPid !== pid,
    ...(port !== undefined ? { port } : {}),
    healthzStatus,
    healthz,
    latencyMs,
    inFlight,
    inFlightWarning,
    enabledSources,
    disabledSources,
    totalSources,
  };
}

async function waitForHealthz(ctx, initialPort, extraLiterals) {
  const waitMs = Number.isFinite(ctx?.healthzWaitMs) && ctx.healthzWaitMs >= 0 ? ctx.healthzWaitMs : 15_000;
  const pollMs = Number.isFinite(ctx?.healthzPollMs) && ctx.healthzPollMs > 0 ? ctx.healthzPollMs : 200;
  const deadline = Date.now() + waitMs;
  let activePort = initialPort;
  let healthz = { ok: false, reachable: false, httpStatus: null };

  for (;;) {
    const recNow = readPidRecord(ctx.dataDir);
    if (Number.isInteger(recNow?.port) && recNow.port > 0) {
      activePort = recNow.port;
    }
    const probe = await probeHealthz(resolveGatewayUrl(ctx, activePort), ctx, extraLiterals);
    healthz = probe.healthz;
    if (healthz.ok) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }

  return { healthz, activePort };
}

/* --------------------------------------------------------------- tool handler */

async function handleReload(_args, ctx) {
  return await withReloadLock(async () =>
    withScopedEnv(ctx, async () => {
      const t0 = performance.now();
      const latency = () => Math.max(0, Math.round(performance.now() - t0));
      const extraLiterals = collectExtraLiterals(ctx?.configFile);

      const cfgRes = readConfigSafe(ctx?.configFile);
      if (!cfgRes.exists || cfgRes.error) {
        return toolError(
          cfgRes.error || 'config file does not exist; run keysmith init first',
          buildReloadPayload({ latencyMs: latency() }),
          extraLiterals,
          ctx,
        );
      }

      const doc = cfgRes.doc;
      const adapters = isPlainObject(doc.adapters) ? doc.adapters : {};
      const totalSources = Object.keys(adapters).length;
      const enabledSources = Object.values(adapters).filter((a) => isPlainObject(a) && !a.disabled).length;
      const disabledSources = totalSources - enabledSources;
      const configuredPort = Number.isInteger(doc.port) ? doc.port : DEFAULTS.port;
      const sourceCounts = { enabledSources, disabledSources, totalSources };

      if (process.platform !== 'darwin' && typeof ctx?.launchctl !== 'function') {
        return toolError(
          'keysmith_reload requires macOS launchd',
          buildReloadPayload({ latencyMs: latency(), ...sourceCounts }),
          extraLiterals,
          ctx,
        );
      }

      const plistPath =
        typeof ctx?.plistFile === 'string' && ctx.plistFile
          ? ctx.plistFile
          : path.join(launchAgentsDir(), `${labels.gateway}.plist`);
      if (!fs.existsSync(plistPath)) {
        return toolError(
          'launchd gateway plist is not installed; run keysmith install-service first',
          buildReloadPayload({ latencyMs: latency(), ...sourceCounts }),
          extraLiterals,
          ctx,
        );
      }

      const runLaunchctl = typeof ctx?.launchctl === 'function' ? ctx.launchctl : undefined;
      const isAlive = typeof ctx?.isPidAlive === 'function' ? ctx.isPidAlive : defaultPidAlive;
      const { pid: previousPid, rec: recBefore } = resolvePid({ runLaunchctl, dataDir: ctx?.dataDir, isAlive });
      const portBefore = Number.isInteger(recBefore?.port) && recBefore.port > 0 ? recBefore.port : configuredPort;

      const hasInjectedDoubles =
        typeof ctx?.launchctl === 'function' ||
        typeof ctx?.fetch === 'function' ||
        typeof ctx?.isPidAlive === 'function' ||
        ctx?.inFlight !== undefined ||
        ctx?.gateway !== undefined;

      const inFlight = await detectInFlight(ctx, { previousPid, portBefore, hasInjectedDoubles, extraLiterals });
      const inFlightWarning =
        inFlight > 0 ? `${inFlight} request${inFlight === 1 ? '' : 's'} in flight when reload started` : null;

      try {
        await reloadAgent(labels.gateway, plistPath, {
          ...(runLaunchctl ? { run: runLaunchctl } : {}),
          ...(Number.isFinite(ctx?.reloadTimeoutMs) ? { timeoutMs: ctx.reloadTimeoutMs } : {}),
          ...(Number.isFinite(ctx?.reloadIntervalMs) ? { intervalMs: ctx.reloadIntervalMs } : {}),
        });
      } catch (err) {
        return toolError(
          err?.message || String(err),
          buildReloadPayload({
            previousPid,
            latencyMs: latency(),
            inFlight,
            inFlightWarning,
            ...sourceCounts,
          }),
          extraLiterals,
          ctx,
        );
      }

      const { healthz, activePort: polledPort } = await waitForHealthz(ctx, portBefore, extraLiterals);
      const { pid, rec: recAfter } = resolvePid({ runLaunchctl, dataDir: ctx?.dataDir, isAlive });
      const activePort = Number.isInteger(recAfter?.port) && recAfter.port > 0 ? recAfter.port : polledPort;
      const healthzStatus = healthz.ok ? 'ok' : healthz.reachable ? 'unhealthy' : 'unreachable';

      const payload = buildReloadPayload({
        restarted: true,
        previousPid,
        pid,
        port: activePort,
        healthzStatus,
        healthz,
        latencyMs: latency(),
        inFlight,
        inFlightWarning,
        ...sourceCounts,
      });

      if (!healthz.ok) {
        return toolError(
          'gateway restarted via launchd, but /healthz did not report ok before timeout',
          payload,
          extraLiterals,
          ctx,
        );
      }

      return scrubOutput({ ok: true, ...payload }, extraLiterals, ctx);
    }),
  );
}

/* -------------------------------------------------------------- registration */

const RELOAD_TOOLS = [
  {
    name: 'keysmith_reload',
    description:
      'Restart the gateway LaunchAgent (dev.keysmith.gateway) via launchd, wait for /healthz, and warn if requests are in flight.',
    inputSchema: { type: 'object', properties: {} },
    handler: handleReload,
  },
];

export function registerTools(register = registerTool) {
  for (const def of RELOAD_TOOLS) {
    register({
      ...def,
      write: true,
      destructive: true,
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  }
}
