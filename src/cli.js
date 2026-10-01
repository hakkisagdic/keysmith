#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, configPath, dataDir, newApiKey, configExists } from './config.js';
import { Gateway } from './gateway.js';
import { createServer } from './server.js';
import { UsageLog } from './usage.js';
import { CLI_PROFILES, HTTP_PROFILES, getProfile, profileNames } from './profiles.js';
import { which } from './cli-adapter.js';
import * as tunnel from './tunnel.js';
import * as service from './service.js';
import { rel, truncate } from './util.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * `keysmith add` names that are not profiles but *are* legal: they say which kind of
 * adapter you are hand-writing, so `--bin` / `--base-url` fill in the rest.
 */
const GENERIC_PROFILES = { custom: 'cli', cli: 'cli', agent: 'cli', tool: 'cli', http: 'http', api: 'http', proxy: 'http' };

const HELP = `keysmith ${PKG.version} — forge an API key out of any coding CLI

  keysmith init                      write a starter config (+ one API key)
  keysmith add <profile>             attach an adapter (see: keysmith adapters)
  keysmith remove <adapter>          detach one
  keysmith adapters                  list profiles and what is attached
  keysmith models [--refresh]        what this gateway exposes, and from where
  keysmith serve [--port N]          run the gateway  (http://127.0.0.1:<port>/v1)
  keysmith start | stop | status     keep it running in the background
  keysmith install-service           run gateway (+ named tunnel) at login via launchd
  keysmith uninstall-service         remove those launchd agents
  keysmith chat <model> <prompt>     one-shot request against your own gateway
  keysmith doctor [--probe-models]   is each adapter actually alive, and at what cost
  keysmith tunnel <status|setup|run> cloudflared: named tunnel first, quick as fallback
  keysmith usage [--hours N]         who spent what
  keysmith key <add|list|revoke>     client-facing API keys

  config  ${rel(configPath())}
  data    ${rel(dataDir())}/usage.jsonl
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        return out(HELP);
      case '-v':
      case '--version':
      case 'version':
        return out(PKG.version);
      case 'init':
        return cmdInit(flags);
      case 'add':
        return cmdAdd(flags);
      case 'remove':
      case 'rm':
        return cmdRemove(flags);
      case 'adapters':
        return cmdAdapters(flags);
      case 'models':
        return cmdModels(flags);
      case 'serve':
        return cmdServe(flags);
      case 'start':
        return cmdStart(flags);
      case 'stop':
        return cmdStop(flags);
      case 'install-service':
        return cmdInstallService(flags);
      case 'uninstall-service':
        return cmdUninstallService(flags);
      case 'status':
        return cmdStatus(flags);
      case 'chat':
        return cmdChat(flags);
      case 'doctor':
        return cmdDoctor(flags);
      case 'tunnel':
        return cmdTunnel(flags);
      case 'usage':
        return cmdUsage(flags);
      case 'key':
        return cmdKey(flags);
      default:
        fail(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (e) {
    fail(e.message || String(e));
  }
}

/* ------------------------------------------------------------------------ config */

function cmdInit(flags) {
  if (configExists() && !flags.force) return out(`${rel(configPath())} already exists — ${flags.force ? 'overwriting' : 'pass --force to overwrite'}`);
  const cfg = structuredClone(DEFAULT_CONFIG());
  const written = saveConfig(cfg);
  fs.chmodSync(written, 0o600);
  out(`wrote ${rel(written)} (0600)\n\n  gateway key: ${cfg.auth.keys[0]}\n\nNext: keysmith add cmd && keysmith serve --tunnel`);
}

function DEFAULT_CONFIG() {
  return {
    host: '127.0.0.1',
    port: 8787,
    auth: { enabled: true, keys: [newApiKey()] },
    log: { usage: true, body: false },
    limits: { maxConcurrent: 4, timeoutMs: 300_000 },
    tunnel: { provider: 'cloudflared', name: null, hostname: null, configFile: null },
    adapters: {},
    aliases: {},
  };
}

function loadOrFail() {
  if (!configExists()) {
    fail(`no config at ${rel(configPath())} — run \`keysmith init\`, or \`keysmith add cmd\``);
  }
  return loadConfig();
}

function cmdAdd(flags) {
  const name = flags._[0];
  if (!name) {
    return out(`profiles:\n\n  cli : ${Object.keys(CLI_PROFILES).join(', ')}\n  http: ${Object.keys(HTTP_PROFILES).join(', ')}\n\nusage: keysmith add <profile> [--as <id>] [--key <ref|literal>] [--base-url <url>]\n\n  a CLI nobody ships a profile for:\n  keysmith add custom --as myagent --bin myagent --args '["-p","{prompt}"]' --parser raw\n  an HTTP endpoint nobody ships a profile for:\n  keysmith add http --as mygateway --base-url https://llm.internal/v1 --key '{env:MY_KEY}'`);
  }
  const cfg = configExists() ? loadConfig() : structuredClone(DEFAULT_CONFIG());
  const id = flags.as || name;
  const profile = getProfile(name);
  let entry;
  if (profile) {
    entry = structuredClone(profile);
  } else {
    // No built-in profile — but `custom`/`http` and an explicit --bin/--base-url are a
    // legitimate way to declare an adapter the shipped profiles have never heard of.
    const generic = GENERIC_PROFILES[name];
    if (!generic && !flags.bin && !flags.baseUrl && !flags.url) {
      fail(`no built-in profile "${name}". Either pick one of: ${profileNames().join(', ')}\n  or declare your own:\n  keysmith add custom --as ${name} --bin ${name} --args '["-p","{prompt}"]' --parser raw`);
    }
    const kind = flags.kind || generic || (flags.bin ? 'cli' : 'http');
    if (!flags.as && GENERIC_PROFILES[name]) fail(`"${name}" only says the kind — name the adapter itself: --as <id>, which becomes the model prefix`);
    entry = kind === 'cli' ? { kind: 'cli', bin: flags.bin || id, args: ['{prompt}'], parser: 'raw', maxConcurrent: 1 } : { kind: 'http', wire: 'openai', baseUrl: flags.baseUrl || flags.url || '', apiKey: flags.key || null };
    entry.note = 'hand-written template — nothing about this argv is verified; `keysmith doctor` and one `keysmith chat` will tell you fast.';
    if (kind === 'http' && !entry.baseUrl) fail('an http adapter needs --base-url https://host/v1');
  }
  if (flags.key) {
    entry.apiKey = looksLikeRef(flags.key) ? flags.key : flags.key;
  }
  if (flags.baseUrl || flags.url) entry.baseUrl = flags.baseUrl || flags.url;
  if (flags.bin) entry.bin = flags.bin;
  if (flags.args) entry.args = JSON.parse(flags.args);
  if (flags.parser) entry.parser = flags.parser;
  if (flags.priority != null) entry.priority = Number(flags.priority);
  if (flags.model) entry.models = (entry.models || []).concat(flags.model);
  if (entry.kind === 'cli' && !which(entry.bin)) {
    out(`! ${entry.bin} is not on PATH right now — the adapter is saved, \`keysmith doctor\` will keep reporting it until it is`);
  }
  if (entry.kind === 'http' && entry.apiKey && String(entry.apiKey).startsWith('{env:')) {
    const varName = String(entry.apiKey).slice(5, -1);
    if (!process.env[varName]) out(`! ${varName} is not set in this shell. Either export it, or store the key:\n  keysmith add ${name} --key "{file:~/secrets/${name}.txt}"`);
  }
  cfg.adapters = cfg.adapters || {};
  cfg.adapters[id] = entry;
  saveConfig(cfg);
  out(`added adapter "${id}" (${entry.kind}) → ${rel(configPath())}\n  models will appear as ${id}/<model>`);
}

function looksLikeRef(v) {
  return /^\{\w+:/.test(v);
}

function cmdRemove(flags) {
  const id = flags._[0];
  if (!id) fail('usage: keysmith remove <adapter>');
  const cfg = loadOrFail();
  if (!cfg.adapters?.[id]) fail(`no adapter named "${id}"`);
  delete cfg.adapters[id];
  saveConfig(cfg);
  out(`removed "${id}"`);
}

function cmdAdapters() {
  const cfg = configExists() ? loadConfig() : { adapters: {} };
  const attached = Object.entries(cfg.adapters || {});
  const lines = [];
  lines.push('attached:');
  if (!attached.length) lines.push('  (none — keysmith add cmd)');
  for (const [id, a] of attached) {
    const state = a.kind === 'cli' ? (which(a.bin || id) ? 'binary ok' : `MISSING ${a.bin || id}`) : `key ${maskRef(a.apiKey)}`;
    lines.push(`  ${id.padEnd(14)} ${String(a.kind).padEnd(5)} ${a.wire || a.parser || ''}  ${state}`);
  }
  lines.push('');
  lines.push('profiles:');
  lines.push(`  cli : ${Object.keys(CLI_PROFILES).join(', ')}`);
  lines.push(`  http: ${Object.keys(HTTP_PROFILES).join(', ')}`);
  out(lines.join('\n'));
}

function maskRef(ref) {
  if (!ref) return 'none';
  if (looksLikeRef(ref)) return ref;
  return `{env:KEYSMITH_${'X'.repeat(4)}} (literal, stored 0600) ` + '•'.repeat(Math.min(8, String(ref).length));
}

/* ------------------------------------------------------------------------ models */

function buildGateway(cfg) {
  const usage = new UsageLog();
  const log = process.env.KEYSMITH_VERBOSE ? (m) => process.stderr.write(`[keysmith] ${m}\n`) : () => {};
  return { gateway: new Gateway(cfg, { log }), usage, log };
}

async function cmdModels(flags) {
  const cfg = loadOrFail();
  const { gateway } = buildGateway(cfg);
  const { models, errors } = await gateway.listModels({ refresh: !!flags.refresh });
  if (!models.length) {
    out('no models resolved. Adapters that need credentials/binaries are skipped silently — run `keysmith doctor`.');
  } else {
    const width = Math.max(...models.map((m) => m.id.length)) + 2;
    out(models.map((m) => `${m.id.padEnd(width)} ${m.keysmith.kind === 'cli' ? 'cli' : 'http'} ${m.keysmith.contextWindow ? 'ctx ' + m.keysmith.contextWindow : ''}`).join('\n'));
  }
  for (const e of errors) process.stderr.write(`! ${e}\n`);
}

/* -------------------------------------------------------------------- serve/start */

async function cmdServe(flags) {
  const cfg = loadOrFail();
  if (flags.port) cfg.port = Number(flags.port);
  if (flags.host) cfg.host = flags.host;
  const { gateway, usage, log } = buildGateway(cfg);
  const server = createServer(gateway, cfg, { usage, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const local = `http://${cfg.host}:${cfg.port}`;
  out(`keysmith listening on ${local}/v1  (status page at ${local}/)`);
  out(`  adapters: ${gateway.publicAdapters.map((a) => a.id).join(', ') || 'none — keysmith add cmd'}`);
  out(`  key     : ${cfg.auth.keys[0]}`);
  writePid(cfg.port, process.pid);

  let tn = null;
  if (flags.tunnel) {
    const named = cfg.tunnel?.name && tunnel.readTunnelConfig();
    tn = tunnel.startTunnel({
      port: cfg.port,
      name: named ? cfg.tunnel.name : null,
      hostname: named ? cfg.tunnel.hostname : null,
      configFile: named ? cfg.tunnel.configFile : null,
      onLog: (m) => log(m),
    });
    out(`  tunnel  : starting cloudflared (${named ? 'named' : 'quick'})…`);
    setTimeout(() => {
      if (tn.url) out(`  public  : ${tn.url}/v1`);
      else if (tn.mode === 'quick') out('  public  : still negotiating; watch `keysmith tunnel status`');
    }, 3500);
  }

  const shutdown = (sig) => {
    out(`\n${sig} — closing`);
    tn?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
    removePid();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await new Promise((resolve) => {
    server.on('close', resolve);
  });
}

function pidFile() {
  return path.join(dataDir(), 'keysmith.pid');
}
function writePid(port, pid) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(pidFile(), JSON.stringify({ pid, port, at: new Date().toISOString() }));
}
function removePid() {
  try { fs.unlinkSync(pidFile()); } catch {}
}
function readPid() {
  try {
    return JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
  } catch {
    return null;
  }
}

function cmdStart(flags) {
  const rec = readPid();
  if (rec && alive(rec.pid)) return out(`already running (pid ${rec.pid}, port ${rec.port})`);
  const logFile = path.join(dataDir(), 'keysmith.log');
  fs.mkdirSync(dataDir(), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [currentEntry(), 'serve', ...(flags.tunnel ? ['--tunnel'] : [])], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  out(`started pid ${child.pid}; log ${rel(logFile)}\n  tail -f ${rel(logFile)}`);
}

function currentEntry() {
  return new URL('./cli.js', import.meta.url).pathname;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdStop() {
  const rec = readPid();
  if (!rec || !alive(rec.pid)) return out('not running');
  process.kill(rec.pid, 'SIGTERM');
  removePid();
  out(`stopped pid ${rec.pid}`);
}

/* ---------------------------------------------------------------------- service */

function cmdInstallService() {
  const cfg = loadOrFail();
  const named = cfg.tunnel?.name && cfg.tunnel?.configFile ? cfg.tunnel : null;
  if (!named) {
    out('no named tunnel configured — installing the gateway agent only.');
    out('(a quick tunnel earns nothing from persistence: the hostname is random every start)\n');
  }
  const cloudflared = named ? tunnel.cloudflaredBin() : null;
  if (named && !cloudflared) fail('named tunnel configured but cloudflared is not on PATH — install it first');
  if (named && !fs.existsSync(named.configFile)) fail(`ingress file missing: ${rel(named.configFile)} — re-run \`keysmith tunnel setup <hostname> --yes\``);

  const res = service.installService({
    nodeBin: process.execPath,
    entry: currentEntry(),
    port: cfg.port,
    cloudflared,
    tunnelName: named?.name,
    tunnelConfig: named?.configFile,
  });

  // Handover: launchd's gateway may have already tried and failed to bind while the
  // old foreground one held the port (throttled retry picks it up within ~10s).
  const rec = readPid();
  if (rec && alive(rec.pid)) {
    process.kill(rec.pid, 'SIGTERM');
    removePid();
    out(`handover: stopped foreground gateway pid ${rec.pid}`);
  }
  killStrayTunnel(named?.configFile);

  out(`installed:\n${res.files.map((f) => `  ${f}`).join('\n')}`);
  out(`logs: ${service.logDir()}/launchd-*.log`);
  out(`verify: launchctl list | grep keysmith   (gateway answers within ~10s of the handover)`);
}

/** Kill cloudflared processes matching our ingress file that are NOT owned by launchd. */
function killStrayTunnel(configFile) {
  if (!configFile) return;
  let lines = '';
  try {
    lines = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of lines.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, cmd] = m;
    if (Number(ppid) === 1) continue; // launchd's own connector — leave it
    if (cmd.includes('cloudflared') && cmd.includes(configFile)) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        out(`handover: stopped stray tunnel pid ${pid}`);
      } catch {}
    }
  }
}

function cmdUninstallService() {
  const removed = service.uninstallService();
  if (!removed.length) return out('no keysmith launchd agents installed');
  out(`removed:\n${removed.map((f) => `  ${f}`).join('\n')}`);
  out('the gateway keeps running until killed — `keysmith stop` if you want it down too');
}

async function cmdStatus() {
  const cfg = configExists() ? loadConfig() : null;
  const rec = readPid();
  const lines = [];
  lines.push(`process : ${rec && alive(rec.pid) ? `running (pid ${rec.pid}, port ${rec.port})` : 'not running'}`);
  lines.push(`config  : ${rel(configPath())}${cfg ? '' : ' (missing — keysmith init)'}`);
  if (cfg) {
    lines.push(`adapters: ${Object.keys(cfg.adapters || {}).join(', ') || 'none'}`);
    const t = tunnel.tunnelStatus(cfg);
    lines.push(`tunnel  : cloudflared ${t.installed ? 'installed' : 'MISSING'}${t.logged_in ? ', cloudflare login ok' : ', not logged in'}${t.configured ? `, named "${t.configured.name}" → ${t.configured.hostname}` : ', no named tunnel'}`);
    if (rec && alive(rec.pid)) {
      try {
        const r = await fetch(`http://127.0.0.1:${rec.port}/healthz`);
        lines.push(`healthz : ${await r.text()}`);
      } catch (e) {
        lines.push(`healthz : unreachable (${e.message})`);
      }
    }
  }
  out(lines.join('\n'));
}

/* -------------------------------------------------------------------------- chat */

async function cmdChat(flags) {
  const [model, ...prompt] = flags._;
  if (!model || !prompt.length) fail('usage: keysmith chat <adapter/model> "prompt"  [--stream]');
  const cfg = loadOrFail();
  const { gateway } = buildGateway(cfg);
  const messages = [{ role: 'user', content: prompt.join(' ') }];
  const started = Date.now();
  if (!flags.stream) {
    const { text } = await gateway.collect({ model, messages });
    out(`${text.trim()}\n\n— ${model}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }
  for await (const evt of gateway.complete({ model, messages })) {
    if (evt.type === 'delta') process.stdout.write(evt.text);
    if (evt.type === 'error') process.stderr.write(`\nerror: ${evt.message}\n`);
  }
  process.stdout.write(`\n\n— ${model}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

/* ------------------------------------------------------------------------ doctor */

async function cmdDoctor(flags) {
  const cfg = loadOrFail();
  const { gateway, log } = buildGateway(cfg);
  const rows = [];
  out(`keysmith ${PKG.version} — config ${rel(configPath())}\n`);

  for (const [id, raw] of Object.entries(cfg.adapters || {})) {
    const adapter = gateway.adapters.get(id);
    if (!adapter) {
      rows.push([id, 'load error', gateway.loadErrors[id] || 'did not construct']);
      continue;
    }
    if (adapter.kind === 'cli') {
      const bin = which(adapter.bin);
      if (!bin) {
        rows.push([id, 'binary missing', `${adapter.bin} not on PATH`]);
        continue;
      }
      let models = [];
      try {
        models = await adapter.models();
      } catch (e) {
        rows.push([id, 'model list failed', truncate(e.message, 60)]);
        continue;
      }
      rows.push([id, models.length ? 'ok' : 'no models', `${bin} · ${models.length} models · parser ${adapter.parser}`]);
    } else {
      try {
        const models = await adapter.models();
        rows.push([id, 'ok', `${adapter.baseUrl} · ${models.length} models`]);
      } catch (e) {
        rows.push([id, 'unreachable', truncate(e.message, 70)]);
        continue;
      }
    }
  }

  // Read from gateway.aliasIssues, not the per-request log: failover makes a dead alias leg
  // look like a slow provider, so a typo is only visible before any traffic has been sent.
  for (const [alias, problems] of Object.entries(gateway.aliasIssues)) {
    for (const p of problems) rows.push([alias, 'alias warning', truncate(p, 70)]);
  }

  const w = Math.max(...rows.map((r) => r[0].length), 8);
  for (const [id, state, detail] of rows) {
    // '!' rather than '✗': the route still answers, because the next leg in the chain picks it
    // up. What is broken is the ordering you asked for, and the money you think you are saving.
    out(`  ${state === 'ok' ? '✓' : state === 'alias warning' ? '!' : '✗'} ${id.padEnd(w)}  ${state.padEnd(16)} ${detail}`);
  }

  const t = tunnel.tunnelStatus(cfg);
  out('');
  out(`  tunnel     ${t.installed ? '✓ cloudflared installed' : '✗ cloudflared missing (brew install cloudflared)'}`);
  out(`             ${t.logged_in ? '✓ origin cert present' : '· not logged in — cloudflared tunnel login'}${t.configured ? ` · named "${t.configured.name}" → ${t.configured.hostname}` : ' · no named tunnel — keysmith tunnel setup <host>'}`);
  out(`  keys       ${cfg.auth.keys?.length || 0} client key(s) — ${cfg.host}:${cfg.port}`);

  if (flags.probeModels) {
    out('\nprobing every model with a 1-token request (this spends real quota):');
    const { models } = await gateway.listModels();
    for (const m of models) {
      const t0 = Date.now();
      try {
        const { text } = await gateway.collect({ model: m.id, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
        out(`  ✓ ${m.id.padEnd(42)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${truncate(text, 30)}`);
      } catch (e) {
        out(`  ✗ ${m.id.padEnd(42)} ${truncate(e.message, 70)}`);
      }
    }
  }
  void log;
}

/* ------------------------------------------------------------------------ tunnel */

async function cmdTunnel(flags) {
  const sub = flags._[0] || 'status';
  const cfg = loadOrFail();
  if (sub === 'status') {
    const st = tunnel.tunnelStatus(cfg);
    out(JSON.stringify(st, null, 2));
    if (st.quick_only && st.installed) {
      out('\nQuick tunnels hand out a random hostname that dies with the process. For a URL you can');
      out('paste into Warp once and forget:  keysmith tunnel setup <sub.domain.tld>');
    }
    return;
  }
  if (sub === 'setup') {
    const hostname = flags._[1];
    if (!hostname) fail('usage: keysmith tunnel setup <hostname> [--name keysmith]\n\nThis creates a Cloudflare tunnel and DNS record for your account. Nothing is sent anywhere until you run `keysmith tunnel run`.');
    if (!flags.yes) {
      out(`About to: cloudflared tunnel create ${flags.name || 'keysmith'}; cloudflared tunnel route dns → ${hostname}; write ${rel(tunnel.tunnelConfigPath())}`);
      out('Re-run with --yes if that is what you want.');
      return;
    }
    const res = await tunnel.createNamedTunnel({ hostname, port: cfg.port, name: flags.name || 'keysmith' });
    cfg.tunnel = { ...(cfg.tunnel || {}), provider: 'cloudflared', name: res.tunnel.name, hostname, configFile: res.configFile };
    saveConfig(cfg);
    out(`named tunnel ready: https://${hostname}\n  ingress: ${rel(res.configFile)}\n  start with: keysmith serve --tunnel   (or keysmith tunnel run)`);
    return;
  }
  if (sub === 'run') {
    const named = cfg.tunnel?.name;
    const t = tunnel.startTunnel({
      port: cfg.port,
      name: named,
      hostname: cfg.tunnel?.hostname,
      configFile: cfg.tunnel?.configFile,
      onLog: (m) => process.env.KEYSMITH_VERBOSE && out(m),
    });
    out(`cloudflared ${t.mode} tunnel → 127.0.0.1:${cfg.port} (pid ${t.child.pid})`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    out(t.url ? `public: ${t.url}/v1` : 'no hostname yet — quick tunnels take a few seconds; watch stderr with KEYSMITH_VERBOSE=1');
    t.child.on('close', () => process.exit(0));
    return;
  }
  fail(`unknown tunnel command "${sub}" — status | setup <hostname> [--yes] | run`);
}

/* ------------------------------------------------------------------------- usage */

function cmdUsage(flags) {
  const usage = new UsageLog();
  const s = usage.summarize((flags.hours || 24) * 3600_000);
  out(`last ${s.window}: ${s.requests} requests, ${s.failures} failed, ${s.tokensIn} in / ${s.tokensOut} out`);
  for (const m of s.models) out(`  ${m.model.padEnd(44)} ${String(m.requests).padStart(4)} req  ${String(m.failures).padStart(3)} err  ${m.input} in  ${m.output} out`);
  if (flags.tail) {
    out('\nrecent:');
    for (const e of usage.tail(Number(flags.tail))) {
      out(`  ${e.ts}  ${e.status === 'ok' ? 'ok  ' : 'ERR '}  ${(e.model || '?').padEnd(40)} ${String(e.ms).padStart(6)}ms  ${e.usage?.input || 0}→${e.usage?.output || 0}  ${truncate(e.error || '', 60)}`);
    }
  }
}

/* --------------------------------------------------------------------------- key */

function cmdKey(flags) {
  const cfg = loadOrFail();
  const sub = flags._[0] || 'list';
  cfg.auth = cfg.auth || { enabled: true, keys: [] };
  if (sub === 'list') return out(cfg.auth.keys.join('\n') || '(none)');
  if (sub === 'add') {
    cfg.auth.keys.push(newApiKey());
    saveConfig(cfg);
    return out(cfg.auth.keys[cfg.auth.keys.length - 1]);
  }
  if (sub === 'revoke') {
    const k = flags._[1];
    if (!k) fail('usage: keysmith key revoke <key>');
    const before = cfg.auth.keys.length;
    // Accept the full key, or the last 4 characters for a key you only have on screen.
    cfg.auth.keys = cfg.auth.keys.filter((x) => x !== k && !(k.length <= 8 && x.endsWith(k)));
    const removed = before - cfg.auth.keys.length;
    if (!removed) return out(`no key matched ${k} — this would have removed nothing`);
    saveConfig(cfg);
    return out(`revoked ${removed} key(s); ${cfg.auth.keys.length} left`);
  }
  fail('usage: keysmith key <list|add|revoke <key>>');
}

/* ------------------------------------------------------------------------ helpers */

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('-')) out[a.slice(2)] = args[++i];
      else out[a.slice(2)] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      out[a.slice(1)] = true;
    } else out._.push(a);
  }
  // `--base-url` is the name people type; code reads flags.baseUrl. Keep both true.
  for (const k of Object.keys(out)) {
    if (k.includes('-')) out[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = out[k];
  }
  return out;
}

function out(s) {
  process.stdout.write(String(s) + '\n');
}
function fail(msg) {
  process.stderr.write(`keysmith: ${msg}\n`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
