#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, configPath, dataDir, newApiKey, configExists, expand, resolveSecret } from './config.js';
import { Gateway, checkAdapter, own } from './gateway.js';
import { createServer } from './server.js';
import { UsageLog } from './usage.js';
import { CLI_PROFILES, HTTP_PROFILES, getProfile, profileNames } from './profiles.js';
import { autoApproveFlag, which } from './cli-adapter.js';
import * as tunnel from './tunnel.js';
import * as service from './service.js';
import { rel, truncate } from './util.js';
import { fingerprint, knownSecrets, redactKey, redactSecrets, registerSecrets, streamRedactor } from './redact.js';
import { ensurePrivateDir, logFiles, openPrivateLog, rotatedLogFiles, scrubLogFile, secureLogFiles, FILE_MODE } from './logfiles.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * `keysmith add` names that are not profiles but *are* legal: they say which kind of
 * adapter you are hand-writing, so `--bin` / `--base-url` fill in the rest.
 */
const GENERIC_PROFILES = { custom: 'cli', cli: 'cli', agent: 'cli', tool: 'cli', http: 'http', api: 'http', proxy: 'http' };

const HELP = `keysmith ${PKG.version} — forge an API key out of any coding CLI

  keysmith init [--reveal]           write a starter config (+ one API key; --reveal shows it, to a terminal only)
  keysmith add <profile>             attach an adapter (see: keysmith adapters); --explicit-only keeps it out of aliases
  keysmith remove <adapter>          detach one
  keysmith set <adapter> <field> <v> change one field of an attached adapter (JSON when it parses); --unset removes it
  keysmith alias [<name> <leg>…]     list aliases, or set one; --prepend/--append/--drop <leg>, --delete
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
  keysmith key <add|list> [--reveal] client-facing API keys; --reveal prints them in full, to a terminal only
  keysmith key revoke fp:<8 hex>     revoke by the fingerprint list/logs print (never the key itself: argv is public)
  keysmith scrub-logs [file…]        redact keys left in the logs, their rotated copies and any file named; counts only

  config  ${rel(configPath())}
  data    ${rel(dataDir())}/usage.jsonl

  The gateway key is printed in full by \`init --reveal\` and \`key list|add --reveal\` only,
  and only when stdin and stdout are an interactive terminal. Without --reveal, piped,
  redirected, under launchd or in a terminal an agent opened, they print ks_Q…35 fp:3f9a0c12
  (first 4 chars, length, sha256 fingerprint), and so does everything else: the serve
  banner, errors, launchd-*.log, keysmith.log and usage.jsonl. Log files are 0600 in a 0700
  directory. A script that needs the key reads it into a variable, never onto stdout:
    KEY=$(jq -r '.auth.keys[0]' ${rel(configPath())})
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  // `return await`, not `return`: a promise returned from inside `try` settles after the
  // `catch` is gone, so its rejection skipped fail() and Node printed it raw — message,
  // stack and fields, key and all — to stderr, which under launchd is a log file.
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
        return await cmdInit(flags);
      case 'add':
        return await cmdAdd(flags);
      case 'remove':
      case 'rm':
        return await cmdRemove(flags);
      case 'set':
        return await cmdSet(flags);
      case 'alias':
      case 'aliases':
        return await cmdAlias(flags);
      case 'adapters':
        return await cmdAdapters(flags);
      case 'models':
        return await cmdModels(flags);
      case 'serve':
        return await cmdServe(flags);
      case 'start':
        return await cmdStart(flags);
      case 'stop':
        return await cmdStop(flags);
      case 'install-service':
        return await cmdInstallService(flags);
      case 'uninstall-service':
        return await cmdUninstallService(flags);
      case 'status':
        return await cmdStatus(flags);
      case 'chat':
        return await cmdChat(flags);
      case 'doctor':
        return await cmdDoctor(flags);
      case 'tunnel':
        return await cmdTunnel(flags);
      case 'usage':
        return await cmdUsage(flags);
      case 'key':
        return await cmdKey(flags);
      case 'scrub-logs':
        return await cmdScrubLogs(flags);
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
  out(`wrote ${rel(written)} (0600)\n`);
  showKeys(cfg.auth.keys, { label: '  gateway key: ', note: 'printed to this terminal only — `keysmith key list --reveal` shows it again', reveal: flags.reveal });
  out('\nNext: keysmith adapters (the profiles), keysmith add <profile>, keysmith serve --tunnel');
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
    fail(`no config at ${rel(configPath())} — run \`keysmith init\`, or \`keysmith add <profile>\``);
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
  if (typeof id !== 'string' || !id || /[/\s]/.test(id) || id.startsWith('-') || FORBIDDEN_FIELDS.has(id)) {
    fail(`"${id}" cannot be an adapter id: it becomes the model prefix, so no "/", no spaces, not starting with "-", and not __proto__, prototype or constructor`);
  }
  const profile = Object.hasOwn(CLI_PROFILES, name) || Object.hasOwn(HTTP_PROFILES, name) ? getProfile(name) : null;
  let entry;
  if (profile) {
    entry = structuredClone(profile);
  } else {
    // No built-in profile — but `custom`/`http` and an explicit --bin/--base-url are a
    // legitimate way to declare an adapter the shipped profiles have never heard of.
    const generic = Object.hasOwn(GENERIC_PROFILES, name) ? GENERIC_PROFILES[name] : null;
    if (!generic && !flags.bin && !flags.baseUrl && !flags.url) {
      fail(`no built-in profile "${name}". Either pick one of: ${profileNames().join(', ')}\n  or declare your own:\n  keysmith add custom --as ${name} --bin ${name} --args '["-p","{prompt}"]' --parser raw`);
    }
    const kind = flags.kind || generic || (flags.bin ? 'cli' : 'http');
    if (!flags.as && generic) fail(`"${name}" only says the kind — name the adapter itself: --as <id>, which becomes the model prefix`);
    // A hand-written agent runs in an empty directory keysmith owns too, never in whatever
    // directory the gateway happens to run in (under launchd: keysmith's own source tree).
    entry = kind === 'cli' ? { kind: 'cli', bin: flags.bin || id, args: ['{prompt}'], parser: 'raw', cwd: `~/.local/share/keysmith/workspaces/${id}`, maxConcurrent: 1 } : { kind: 'http', wire: 'openai', baseUrl: flags.baseUrl || flags.url || '', apiKey: flags.key || null };
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
  if (flags.explicitOnly) entry.explicitOnly = true;
  // Re-adding replaces the entry — to pin a binary, to pick up a newer profile — but it never
  // loosens a guard: a mark the old entry had is kept. Dropping one is a `keysmith set`.
  const prev = own(cfg.adapters, id) ? cfg.adapters[id] : null;
  if (prev && typeof prev === 'object') {
    const kept = ['explicitOnly', 'unsafeTools', 'disabled'].filter((k) => prev[k] && !entry[k]);
    for (const k of kept) entry[k] = true;
    if (kept.length) {
      const undo = (k) => `keysmith set ${id} ${k} false${k === 'unsafeTools' || (k === 'disabled' && entry.unsafeTools) ? ' --allow-unsafe-tools' : ''}`;
      out(`  kept ${kept.join(', ')} from the "${id}" entry this replaces: a re-add never drops a guard (${kept.map(undo).join('; ')})`);
    }
  }
  // Refused here what the gateway would refuse to load: an auto-approving argv, a malformed
  // field. Credentials and binaries are only reported below — they can appear later.
  try {
    checkAdapter(id, entry);
  } catch (e) {
    if (!flags.force) fail(`not added: ${e.message}`);
    out(`! saved although "${id}" will not load: ${e.message}`);
  }
  if (entry.kind === 'cli' && !which(entry.bin)) {
    out(`! ${entry.bin} is not on PATH right now — the adapter is saved, \`keysmith doctor\` will keep reporting it until it is`);
  }
  if (entry.unsafeTools) {
    out(`! ${id} can run commands and edit files: keysmith could not take its tools away (unsafeTools).\n  It is added ${entry.disabled ? 'disabled' : 'ENABLED'}, is never an alias leg and is never probed.${entry.disabled ? `\n  To serve it anyway: keysmith set ${id} disabled false --allow-unsafe-tools` : ''}`);
  } else if (entry.explicitOnly) {
    out(`  explicit-only: "${id}" answers requests that name it — never an alias leg, never probed by doctor`);
  }
  if (entry.unsafeTools || entry.explicitOnly) {
    for (const [alias, legs] of Object.entries(cfg.aliases || {})) {
      for (const leg of Array.isArray(legs) ? legs : []) {
        if (legAdapter(leg) === id) out(`! alias "${alias}" names ${leg}: keysmith skips that leg — keysmith alias ${alias} --drop ${leg}`);
      }
    }
  }
  if (entry.kind === 'http' && entry.apiKey && String(entry.apiKey).startsWith('{env:')) {
    const varName = String(entry.apiKey).slice(5, -1);
    if (!process.env[varName]) out(`! ${varName} is not set in this shell. Either export it, or point at where the key already is:\n  keysmith add ${name} --key "{dotenv:~/project/.env#${varName}}"    (or {file:…}, {json:…#path})`);
  } else if (entry.kind === 'http' && /^\{(file|json|dotenv):/.test(String(entry.apiKey || ''))) {
    const ref = String(entry.apiKey);
    // A reference that can never work is a typo: refuse it rather than save it.
    if (ref.startsWith('{dotenv:') && !/#[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)) fail('--key: {dotenv:…} names one variable after a #, e.g. {dotenv:~/project/.env#GOOGLE_API_KEY}');
    // Resolved here only to say whether it would load; the value goes nowhere.
    let ok = false;
    let why = '';
    try {
      ok = !!resolveSecret(ref);
    } catch (e) {
      why = ` (${e.message})`;
    }
    if (!ok) out(`! ${ref} does not resolve to a key right now${why} — the adapter is saved, \`keysmith doctor\` will report it until it does`);
  }
  cfg.adapters = cfg.adapters || {};
  cfg.adapters[id] = entry;
  saveConfig(cfg);
  out(`added adapter "${id}" (${entry.kind}) → ${rel(configPath())}\n  models will appear as ${id}/<model>`);
  noteRestart(`adapter "${id}"`);
}

function looksLikeRef(v) {
  return /^\{\w+:/.test(v);
}

function cmdRemove(flags) {
  const id = flags._[0];
  if (!id) fail('usage: keysmith remove <adapter>');
  const cfg = loadOrFail();
  if (!own(cfg.adapters, id)) fail(`no adapter named "${id}"`);
  delete cfg.adapters[id];
  saveConfig(cfg);
  out(`removed "${id}"`);
  noteRestart(`removing "${id}"`);
}

/** Names `keysmith` refuses for a field, an adapter or an alias: they would reach Object.prototype, not the config. */
const FORBIDDEN_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * On an `unsafeTools` adapter, the fields `keysmith set` changes without
 * `--allow-unsafe-tools`: none of them shapes what is spawned or how a run is stopped.
 * Everything else — `stopAtToolCall`, `args`, `resumeArgs`, `bin`, `env`, `cwd`, `parser`,
 * `modelsFrom`, a field added later — is the same decision as serving it.
 */
const SAFE_ON_UNSAFE = new Set(['note', 'provenance', 'models', 'defaultModel', 'priority', 'timeoutMs', 'maxConcurrent', 'maxPromptChars', 'explicitOnly']);

/** Why setting `field` (entry → next) needs --allow-unsafe-tools, or null when it does not. */
function unsafeChange(entry, next, field) {
  if (JSON.stringify(entry[field]) === JSON.stringify(next[field])) return null;
  if (entry.unsafeTools) {
    if (field === 'disabled') return next.disabled ? null : 'serving it';
    if (field === 'unsafeTools') return next.unsafeTools ? null : 'taking the mark off';
    if (SAFE_ON_UNSAFE.has(field)) return null;
    return `changing ${field}, which shapes what it runs or how keysmith stops it`;
  }
  // The mark is what lets an auto-approving argv load at all: on an enabled entry, adding it
  // serves an agent that approves its own tool calls.
  const approving = field === 'unsafeTools' && next.unsafeTools && !next.disabled ? autoApproveFlag(next) : null;
  return approving ? `marking it unsafeTools while its argv passes ${approving}, which serves an agent that approves its own tool calls` : null;
}

/**
 * `keysmith set <adapter> <field> <value>` — one field of an attached adapter, so a change
 * to a live config (a model's request defaults, `explicitOnly`, a pinned `bin`) never means
 * opening the file that holds the gateway key. The value is JSON when it parses (`true`,
 * `42`, `["a","b"]`, `{"k":1}`) and a plain string otherwise. Nothing is echoed back: the
 * field might be `apiKey`.
 */
function cmdSet(flags) {
  const [id, field, raw] = flags._;
  if (!id || !field || (raw === undefined && !flags.unset)) {
    fail('usage: keysmith set <adapter> <field> <value>   (value: JSON when it parses, a string otherwise)\n       keysmith set <adapter> <field> --unset');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || FORBIDDEN_FIELDS.has(field)) fail(`"${field}" is not a field name`);
  const cfg = loadOrFail();
  if (!own(cfg.adapters, id)) fail(`no adapter named "${id}" — keysmith add <profile> first`);
  const entry = cfg.adapters[id];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`adapter "${id}" is not an object in ${rel(configPath())}`);
  let value;
  if (!flags.unset) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  const next = { ...entry };
  if (flags.unset) delete next[field];
  else next[field] = value;
  // A tool-capable CLI is served only by someone who said so: turning it on, taking the mark
  // off, or changing what it runs and how it is stopped needs the flag that names what it means.
  const unsafe = unsafeChange(entry, next, field);
  if (unsafe && !flags.allowUnsafeTools) {
    fail(`"${id}" can run commands and edit files: keysmith could not take its tools away, and ${unsafe} needs --allow-unsafe-tools.\n  Serving it means a request through this gateway — from any client holding a key, through the tunnel too — can make it act on this machine.\n  If you accept that: keysmith set ${id} ${field} ${flags.unset ? '--unset' : raw} --allow-unsafe-tools`);
  }
  if (field === 'explicitOnly' && !next.explicitOnly && next.unsafeTools) {
    out(`! "${id}" stays out of aliases anyway: unsafeTools implies explicit-only`);
  }
  // What the gateway would refuse to load is refused here, before it replaces a working entry:
  // after the next restart the adapter, its routes and every alias leg on it would be gone.
  try {
    checkAdapter(id, next);
    if ((field === 'apiKey' || field === 'key') && !flags.unset) checkKeyRef(value);
  } catch (e) {
    if (!flags.force) fail(`not saved: ${e.message}\n  (--force saves it anyway; the gateway then refuses to load "${id}" until it is fixed)`);
    out(`! saved although "${id}" will not load: ${e.message}`);
  }
  cfg.adapters[id] = next;
  saveConfig(cfg);
  out(`${flags.unset ? 'removed' : 'set'} ${id}.${field} → ${rel(configPath())}`);
  if (unsafe) out(`! "${id}": ${unsafe}, with --allow-unsafe-tools. It can run commands and edit files on this machine${next.disabled ? ' once it is enabled' : ''}; it is still never an alias leg.`);
  noteRestart(`${id}.${field}`);
}

/**
 * An `apiKey` reference the gateway could never resolve — an unknown kind, a `{dotenv:…}`
 * with no `#NAME`, a JSON file that does not parse — throws, as it would at load. One that is
 * well-formed but empty in this shell is only said: launchd's environment is not this one.
 * `{env:…}` and `{exec:…}` are not resolved here, and nothing about the value is printed.
 */
function checkKeyRef(value) {
  if (value == null || value === false) return;
  if (typeof value !== 'string') throw new Error('apiKey must be a string reference, e.g. {env:GOOGLE_API_KEY}');
  const m = value.match(/^\{(\w+):([\s\S]*)\}$/);
  if (!m) return; // a literal key
  if (!['env', 'file', 'json', 'dotenv', 'exec'].includes(m[1])) throw new Error(`apiKey reference: unknown kind "${m[1]}" — env, file, json, dotenv or exec`);
  if (m[1] === 'env' || m[1] === 'exec') return;
  let ok = false;
  try {
    ok = !!resolveSecret(value);
  } catch (e) {
    throw new Error(`apiKey reference: ${e.message}`);
  }
  if (!ok) out('! the apiKey reference does not resolve to a key right now — saved; `keysmith doctor` reports it until it does');
}

/** The adapter part of an alias leg: everything before the first slash. */
function legAdapter(leg) {
  const s = String(leg);
  const i = s.indexOf('/');
  return i < 0 ? s : s.slice(0, i);
}

/**
 * `keysmith alias` — the alias chains, without opening the config file:
 *
 *   keysmith alias                              every alias and its legs
 *   keysmith alias <name> <leg> [leg…]          set the chain (replaces it)
 *   keysmith alias <name> --prepend <leg>       put a leg first (moved there if already in it)
 *   keysmith alias <name> --append <leg>        put a leg last (moved there if already in it)
 *   keysmith alias <name> --drop <leg>          take a leg out
 *   keysmith alias <name> --delete              remove the alias
 *
 * A leg must name an attached adapter (`--force` saves one that is not attached yet), and
 * never an explicit-only or tool-capable one: those answer only requests that name them.
 */
function cmdAlias(flags) {
  const [name, ...legs] = flags._;
  const cfg = loadOrFail();
  cfg.aliases = cfg.aliases || {};
  if (!name) {
    const entries = Object.entries(cfg.aliases);
    if (!entries.length) return out('no aliases — keysmith alias <name> <adapter/model> [<adapter/model>…]');
    return out(entries.map(([a, l]) => `${a.padEnd(12)} ${(Array.isArray(l) ? l : []).join('  →  ')}`).join('\n'));
  }
  if (name.includes('/') || /\s/.test(name)) fail(`alias names cannot contain "/" or spaces: "${name}"`);
  if (FORBIDDEN_FIELDS.has(name)) fail(`"${name}" cannot be an alias name`);
  if (own(cfg.adapters, name)) fail(`"${name}" is an adapter: an alias with that name would hide it`);
  const exists = own(cfg.aliases, name);
  const current = exists && Array.isArray(cfg.aliases[name]) ? [...cfg.aliases[name]] : [];

  if (flags.delete) {
    if (!exists) fail(`no alias named "${name}"`);
    delete cfg.aliases[name];
    saveConfig(cfg);
    out(`removed alias "${name}"`);
    return noteRestart(`removing alias "${name}"`);
  }

  const edits = ['prepend', 'append', 'drop'].filter((k) => flags[k] !== undefined);
  if (edits.length > 1 || (edits.length && legs.length)) fail('one change at a time: legs to set the chain, or one of --prepend / --append / --drop');
  let chain;
  if (edits.length) {
    const op = edits[0];
    const leg = flags[op];
    if (typeof leg !== 'string' || !leg) fail(`--${op} takes a leg: adapter/model`);
    if (op !== 'drop') checkAliasLeg(cfg, leg, flags);
    if (op === 'drop' && !current.includes(leg)) fail(`alias "${name}" has no leg ${leg}`);
    const rest = current.filter((l) => l !== leg);
    chain = op === 'prepend' ? [leg, ...rest] : op === 'append' ? [...rest, leg] : rest;
    if (!chain.length) fail(`that would leave alias "${name}" with no legs — keysmith alias ${name} --delete removes it`);
  } else {
    if (!legs.length) {
      if (!exists) fail(`no alias named "${name}" — keysmith alias ${name} <adapter/model> [<adapter/model>…] creates it`);
      return out(`${name.padEnd(12)} ${current.join('  →  ')}`);
    }
    for (const leg of legs) checkAliasLeg(cfg, leg, flags);
    if (new Set(legs).size !== legs.length) fail('a leg is named twice: each one is tried once, in order');
    chain = legs;
  }
  cfg.aliases[name] = chain;
  saveConfig(cfg);
  out(`alias "${name}": ${chain.join('  →  ')}`);
  // The same check doctor and the status page run, so a model the adapter does not list is
  // said now rather than discovered as a slow failover later.
  const { gateway } = buildGateway(cfg);
  for (const p of gateway.aliasIssues[name] || []) warn(`! ${p}`);
  noteRestart(`alias "${name}"`);
}

function checkAliasLeg(cfg, leg, flags) {
  if (typeof leg !== 'string' || !leg.trim() || /\s/.test(leg)) fail(`not a leg: "${leg}" — adapter/model, e.g. agy/gemini-4-argon-high`);
  const id = legAdapter(leg);
  if (own(cfg.aliases, leg)) fail(`${leg} is an alias: aliases cannot nest — name the adapter/model directly`);
  const entry = own(cfg.adapters, id) ? cfg.adapters[id] : null;
  if (!entry || typeof entry !== 'object') {
    if (!flags.force) fail(`no adapter named "${id}" — keysmith add ${id} first (or --force to save the leg anyway)`);
    return;
  }
  // `--force` never lets these in: a tool-capable agent in a route the gateway picks legs from
  // on its own is exactly what the marks exist to prevent.
  const approving = autoApproveFlag(entry);
  if (entry.unsafeTools || approving) {
    fail(`${leg}: adapter "${id}" can run commands and edit files (${entry.unsafeTools ? 'unsafeTools' : `its argv passes ${approving}`}), so keysmith keeps it out of every alias`);
  }
  if (entry.explicitOnly) fail(`${leg}: adapter "${id}" is explicit-only — it answers requests that name it, never an alias. \`keysmith set ${id} explicitOnly false\` first if you mean it`);
}

function cmdAdapters() {
  const cfg = configExists() ? loadConfig() : { adapters: {} };
  const attached = Object.entries(cfg.adapters || {});
  const lines = [];
  lines.push('attached:');
  if (!attached.length) lines.push('  (none — keysmith add <profile>)');
  for (const [id, a] of attached) {
    const state = a.kind === 'cli' ? (which(a.bin || id) ? 'binary ok' : `MISSING ${a.bin || id}`) : `key ${maskRef(a.apiKey)}`;
    const marks = `${a.disabled ? ' · disabled' : ''}${a.unsafeTools ? ' · unsafeTools' : a.explicitOnly ? ' · explicit-only' : ''}`;
    lines.push(`  ${id.padEnd(14)} ${String(a.kind).padEnd(5)} ${a.wire || a.parser || ''}  ${state}${marks}`);
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
  // Under launchd this stderr is a log file. Adapter errors quote whatever a CLI printed,
  // which can be a prompt that held the key, so every line is redacted on the way out.
  const log = process.env.KEYSMITH_VERBOSE ? (m) => process.stderr.write(`[keysmith] ${redactSecrets(m)}\n`) : () => {};
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
  for (const e of errors) warn(`! ${e}`);
}

/* -------------------------------------------------------------------- serve/start */

async function cmdServe(flags) {
  const cfg = loadOrFail();
  if (flags.port) cfg.port = Number(flags.port);
  if (flags.host) cfg.host = flags.host;
  // launchd opened its log before this process started, with the default umask: tighten
  // that, and anything an older keysmith left behind, before the first line is written.
  const secured = secureLogFiles();
  const { gateway, usage, log } = buildGateway(cfg);
  const server = createServer(gateway, cfg, { usage, log });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const local = `http://${cfg.host}:${cfg.port}`;
  out(`keysmith listening on ${local}/v1  (status page at ${local}/)`);
  out(`  adapters: ${gateway.publicAdapters.map((a) => a.id).join(', ') || 'none — keysmith add <profile>'}`);
  // This banner is launchd's log file and keysmith.log: the key is named, never printed.
  out(`  key     : ${keyBanner(cfg)}`);
  if (secured.changed.length) out(`  logs    : tightened ${secured.changed.length} file(s)/dir(s) to 0600/0700`);
  for (const f of secured.failed) warn(`! could not tighten ${f}`);
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
function keyBanner(cfg) {
  const keys = cfg.auth?.keys || [];
  if (!cfg.auth?.enabled) return 'none — auth is disabled';
  if (!keys.length) return 'none';
  return `${redactKey(keys[0])}${keys.length > 1 ? ` (+${keys.length - 1} more)` : ''} — full key: \`keysmith key list --reveal\`, in a terminal`;
}

function writePid(port, pid) {
  ensurePrivateDir(dataDir());
  fs.writeFileSync(pidFile(), JSON.stringify({ pid, port, at: new Date().toISOString() }), { mode: FILE_MODE });
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
  secureLogFiles();
  const fd = openPrivateLog(logFile);
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

  secureLogFiles();
  out(`installed:\n${res.files.map((f) => `  ${f}`).join('\n')}`);
  out(`logs: ${service.logDir()}/launchd-*.log (0600 in a 0700 directory; the key appears there redacted)`);
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
      const stale = staleCode(rec);
      if (stale) lines.push(`code    : ${stale}`);
      const changed = staleConfig(rec);
      if (changed) lines.push(`changes : ${changed}`);
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

/**
 * A gateway keeps running the code it started with. After an upgrade — a fix to what it
 * logs, say — it goes on doing the old thing until it is restarted, and nothing says so.
 */
function staleCode(rec) {
  const started = Date.parse(rec?.at || '');
  if (!Number.isFinite(started)) return null;
  const src = path.dirname(currentEntry());
  let newest = 0;
  let newestFile = null;
  try {
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      const t = fs.statSync(path.join(src, f)).mtimeMs;
      if (t > newest) [newest, newestFile] = [t, f];
    }
  } catch {
    return null;
  }
  if (newest <= started) return null;
  return `${rel(path.join(src, newestFile))} changed ${new Date(newest).toISOString()}, after this gateway started (${rec.at}): it still runs the old code — restart it (${restartCommand()})`;
}

/**
 * The same for the config: the gateway reads it once, at start. An alias set since then is a
 * 404, an adapter disabled since then still answers, a key revoked since then still works.
 */
function staleConfig(rec) {
  const started = Date.parse(rec?.at || '');
  if (!Number.isFinite(started)) return null;
  let changed = 0;
  try {
    changed = fs.statSync(configPath()).mtimeMs;
  } catch {
    return null;
  }
  if (changed <= started) return null;
  return `${rel(configPath())} changed ${new Date(changed).toISOString()}, after this gateway started (${rec.at}): it still serves the old config — restart it (${restartCommand()})`;
}

function restartCommand() {
  return `launchd: launchctl kickstart -k gui/${process.getuid?.() ?? '$UID'}/${service.labels.gateway}; otherwise keysmith stop && keysmith start`;
}

/**
 * Said after `add`, `remove`, `set`, `alias` and `key` save the config while a gateway runs:
 * what they changed is not what it serves until it restarts — in the safe direction too
 * (`set warp disabled true`, `key revoke`).
 */
function noteRestart(what) {
  const rec = readPid();
  if (!rec || !alive(rec.pid)) return;
  out(`! the running gateway (pid ${rec.pid}) still serves the config it started with — ${what} takes effect when it restarts: ${restartCommand()}`);
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
  // A delta is a token or two, so a key is never inside one: each is redacted as part of
  // the text around it, with the tail that could still be a key held for the next delta.
  const redactor = streamRedactor();
  for await (const evt of gateway.complete({ model, messages })) {
    if (evt.type === 'delta') process.stdout.write(redactor.push(evt.text));
    if (evt.type === 'error') {
      process.stdout.write(redactor.end());
      warn(`\nerror: ${evt.message}`);
    }
  }
  process.stdout.write(`${redactor.end()}\n\n— ${model}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
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
      rows.push([id, 'load error', gateway.loadError(id) || 'did not construct']);
      continue;
    }
    if (adapter.disabled) {
      rows.push([id, 'disabled', adapter.unsafeTools ? `can run commands and edit files (unsafeTools) — keysmith set ${id} disabled false --allow-unsafe-tools serves it` : 'disabled in the config']);
      continue;
    }
    const tag = adapter.unsafeTools ? ' · UNSAFE TOOLS: can run commands, never an alias' : adapter.explicitOnly ? ' · explicit-only' : '';
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
      rows.push([id, models.length ? 'ok' : 'no models', `${bin} · ${models.length} models · parser ${adapter.parser}${tag}`]);
    } else {
      try {
        const models = await adapter.models();
        rows.push([id, 'ok', `${adapter.baseUrl} · ${models.length} models${tag}`]);
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
    out(`  ${state === 'ok' ? '✓' : state === 'alias warning' ? '!' : state === 'disabled' ? '·' : '✗'} ${id.padEnd(w)}  ${state.padEnd(16)} ${detail}`);
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
      // An explicit-only adapter spends something its owner keeps for requests that name it
      // (a Claude subscription, say), and a tool-capable one acts on this machine: neither is
      // spent on a probe nobody asked of it by name.
      const owner = gateway.adapters.get(m.keysmith?.adapter);
      if (owner?.explicitOnly) {
        out(`  · ${m.id.padEnd(42)} skipped: ${owner.unsafeTools ? 'unsafeTools' : 'explicit-only'}, never probed`);
        continue;
      }
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
  if (sub === 'list') {
    if (!cfg.auth.keys.length) return out('(none)');
    return showKeys(cfg.auth.keys, { reveal: flags.reveal });
  }
  if (sub === 'add') {
    const key = newApiKey();
    cfg.auth.keys.push(key);
    registerSecrets([key]);
    saveConfig(cfg);
    showKeys([key], { reveal: flags.reveal });
    return noteRestart('the new key');
  }
  if (sub === 'revoke') {
    // The fingerprint only — what `key list`, the serve banner and every log line show. A
    // key on the command line is in shell history and, while it runs, in everyone's `ps`;
    // so is any piece of one.
    const m = String(flags._[1] ?? '').match(/^(?:fp:)?([0-9a-fA-F]{8})$/);
    if (!m) fail('usage: keysmith key revoke fp:<8 hex>\n  the fingerprint `keysmith key list` prints next to each key; the key itself is never taken on the command line');
    const fp = m[1].toLowerCase();
    const before = cfg.auth.keys.length;
    const revoked = cfg.auth.keys.filter((x) => fingerprint(x) === fp);
    cfg.auth.keys = cfg.auth.keys.filter((x) => !revoked.includes(x));
    if (!revoked.length) return out(`no key matched fp:${fp} — this would have removed nothing`);
    saveConfig(cfg);
    out(`revoked ${before - cfg.auth.keys.length} key(s): ${revoked.map(redactKey).join(', ')}; ${cfg.auth.keys.length} left`);
    return noteRestart('the revocation (the revoked key works until then)');
  }
  fail('usage: keysmith key <list|add> [--reveal] | keysmith key revoke fp:<8 hex>');
}

/* -------------------------------------------------------------------- scrub-logs */

/**
 * Logs written before keysmith redacted its banner hold the key in full. Rewrite them in
 * place — and their rotated copies, and any file named on the command line (a log another
 * KEYSMITH_DATA wrote, an agent's transcript) — and say how many replacements were made,
 * never what was replaced.
 */
function cmdScrubLogs(flags) {
  if (configExists()) loadConfig(); // registers the configured keys
  const { changed, failed } = secureLogFiles();
  const rotated = rotatedLogFiles();
  const named = flags._.map((p) => path.resolve(expand(p)));
  const lines = [];
  let total = 0;
  let configured = 0;
  for (const f of [...new Set([...logFiles(), ...rotated.files, ...named])]) {
    if (fs.existsSync(f) && !fs.statSync(f).isFile()) {
      lines.push(`  ${rel(f)}  not a file — skipped`);
      continue;
    }
    const r = scrubLogFile(f, knownSecrets());
    if (!r) {
      lines.push(`  ${rel(f)}  absent`);
      continue;
    }
    total += r.configured + r.shaped;
    configured += r.configured;
    lines.push(`  ${rel(f)}  ${r.configured} configured key(s), ${r.shaped} other key-shaped string(s) (ks_…, AIza…) replaced`);
  }
  for (const f of rotated.compressed) lines.push(`  ${rel(f)}  compressed — not rewritten; delete it, or unpack it and name it here`);
  out(`${lines.join('\n')}\n${total} replacement(s); ${changed.length} file(s)/dir(s) tightened to 0600/0700`);
  for (const f of failed) warn(`! could not tighten ${f}`);
  if (configured) {
    // A key that reached a log has been copied wherever that log went: backups, a pasted
    // tail, an agent's transcript. Scrubbing these files cannot reach those copies.
    out(
      [
        '',
        'A configured key was in these files, so it may also be in copies scrub-logs cannot reach',
        '(Time Machine, transcripts, rotated archives, logs under another KEYSMITH_DATA). Rotate it:',
        '  keysmith key add --reveal     # in a terminal; move every client to the new key',
        '  keysmith key revoke fp:<old>  # the fingerprint `keysmith key list` shows',
        '  then restart the gateway, which reads its keys at start',
      ].join('\n'),
    );
  }
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

/**
 * Everything keysmith prints goes through redaction: the configured keys, and anything
 * shaped like a minted one, come out as `ks_Q…35 fp:…`. Only `showKeys`, to a terminal, gets past it.
 */
function out(s) {
  process.stdout.write(redactSecrets(s) + '\n');
}
function warn(s) {
  process.stderr.write(redactSecrets(s) + '\n');
}
function fail(msg) {
  process.stderr.write(`keysmith: ${redactSecrets(msg)}\n`);
  process.exit(1);
}

/**
 * A full key goes to an interactive terminal, when asked for by name, and nowhere else.
 * Not a pipe, not a file, not launchd's log: a stdout that is not a TTY gets the redacted
 * form, and stdin is checked too, so `keysmith key list < /dev/null > tty` is not
 * "interactive". A TTY alone is not enough either: an agent's terminal tool (tmux, expect,
 * `script`) opens a real one, and what it reads there lands in a transcript. `--reveal`
 * is the one thing such a tool has to type on purpose.
 */
function canReveal(reveal) {
  return !!(reveal && process.stdout.isTTY && process.stdin.isTTY);
}

function showKeys(keys, { label = '', note = '', reveal = false } = {}) {
  if (canReveal(reveal)) {
    process.stdout.write(keys.map((k) => `${label}${k}`).join('\n') + '\n');
    if (note) out(`(${note})`);
    return;
  }
  out(keys.map((k) => `${label}${redactKey(k)}`).join('\n'));
  const s = keys.length > 1 ? 's' : '';
  const why = !process.stdout.isTTY || !process.stdin.isTTY ? 'stdout is not an interactive terminal' : 'no --reveal';
  warn(`(full key${s} not printed: ${why} — \`keysmith key list --reveal\` prints ${s ? 'them' : 'it'} to an interactive terminal; a script reads auth.keys from ${rel(configPath())} into a variable)`);
}

/**
 * The last word on an error nothing else caught: redacted, on stderr, exit 1. Node's own
 * report prints the message, the stack and every field it can find (a bad URL's `input`,
 * an adapter's stderr) as they are.
 */
export function installCrashHandlers(proc = process) {
  const report = (what) => (e) => {
    try {
      proc.stderr.write(`keysmith: ${what}: ${redactSecrets(e?.stack || e?.message || String(e))}\n`);
    } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', report('uncaught exception'));
  proc.on('unhandledRejection', report('unhandled rejection'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installCrashHandlers();
  main(process.argv.slice(2));
}
