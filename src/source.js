/**
 * `keysmith source enable|disable <profile>`: open (or close) a free-tier source in the config
 * without hand-editing it. Enabling writes the adapter (its key a Keychain `{exec:…}` reference,
 * never a value), turns discovery on, and puts conservative limits in the catalogue file. It
 * never puts the adapter in an alias: it is reached by naming it, `<id>/<model>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { expand } from './config.js';
import { getProfile, SOURCE_FACTS } from './profiles.js';
import { checkAdapter } from './gateway.js';
import { backupFile, getPath, readRaw, setPath, unsetPath, writeJsonAtomic } from './config-edit.js';

const SAFE = /^[A-Za-z0-9._:@\/-]+$/; // goes into a shell command line: no quoting needed, none possible
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export const sourceNames = () => Object.keys(SOURCE_FACTS);

/** `{account}` in a profile's baseUrl, filled; the id is not a secret, but it must look like one. */
export function fillAccount(baseUrl, accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new Error('this endpoint needs --account-id <32 hex characters> (Cloudflare dashboard, or `GET /client/v4/accounts` with the token)');
  }
  return baseUrl.replace('{account}', accountId.toLowerCase());
}

/** Does the Keychain hold this item? Asks for its attributes only, never its value. */
function keychainHas(service, account) {
  const bin = process.env.KEYSMITH_SECURITY_BIN || '/usr/bin/security';
  const r = spawnSync(bin, ['find-generic-password', '-s', service, '-a', account], { stdio: 'ignore', timeout: 10_000 });
  return r.status === 0;
}

const NOT_CHAT = /embed|whisper|tts|guard|image|vision|rerank|moderat|transcri|speech|audio|ocr|safety|diffusion/i;
const SMALL_WORD = /(^|[^a-z0-9])(mini|flash|lite|nano|small)([^a-z0-9]|$)/i;

function isSmall(id) {
  if (SMALL_WORD.test(id)) return true;
  for (const m of id.matchAll(/(^|[^a-z0-9.])(\d+(?:\.\d+)?)b([^a-z0-9]|$)/gi)) if (Number(m[2]) <= 32) return true;
  return false;
}

/** The numbers in a name other than its size (8b, 20b): 3.1 in llama-3.1-8b-instant. */
const versionOf = (id) => (id.replace(/(^|[^a-z0-9.])\d+(?:\.\d+)?b(?=[^a-z0-9]|$)/gi, '$1').match(/\d+/g) || []).map(Number);
function newer(a, b) {
  const x = versionOf(a), y = versionOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d > 0;
  }
  return false;
}

/**
 * The model to name when none was asked for, from the provider's own list: a chat model (not
 * embedding, speech, guard, image, vision …), small by name (8b, mini, flash, lite, nano, small),
 * newest by the numbers in its name; with no small one, the first chat model in the list.
 */
export function pickDefaultModel(ids) {
  const chat = ids.filter((id) => typeof id === 'string' && id && !NOT_CHAT.test(id));
  const small = chat.filter(isSmall);
  if (small.length) return small.reduce((best, id) => (newer(id, best) ? id : best));
  return chat[0] ?? ids.find((id) => typeof id === 'string' && id) ?? null;
}

/** The provider's model ids, or null when there is no key to ask with or the answer is unusable. */
async function providerModels(baseUrl, key, override) {
  if (!key && !override) return null;
  const url = override || baseUrl.replace(/\/+$/, '') + '/models';
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const body = await res.json();
    const arr = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null);
    if (!arr) return null;
    const ids = arr.map((m) => (typeof m === 'string' ? m : m?.id)).filter((x) => typeof x === 'string' && x);
    return ids.length ? ids : null;
  } catch { return null; }
}

/** The key's value, read the way the adapter will read it, for this one request. Never printed. */
function keychainValue(service, account) {
  const bin = process.env.KEYSMITH_SECURITY_BIN || '/usr/bin/security';
  const r = spawnSync(bin, ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

export function sourceList(cfgFile) {
  const doc = readRaw(cfgFile);
  return sourceNames().map((n) => {
    const f = SOURCE_FACTS[n];
    return `${n}${getPath(doc, `adapters.${n}`) ? ' (attached)' : ''}  ${f.freeOnly ? 'freeOnly' : 'named models'}${f.note ? `  note: ${f.note}` : ''}`;
  });
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

function catalogueFile(doc, cfgFile) {
  const cur = typeof doc.catalogue === 'string' && doc.catalogue.trim() ? doc.catalogue.trim() : null;
  if (cur) return { file: expand(cur), isNew: false };
  return { file: path.join(path.dirname(cfgFile), 'catalogue.json'), isNew: true };
}

function readCatalogue(file) {
  if (!fs.existsSync(file)) return { version: 1, sources: [] };
  const c = readRaw(file);
  if (c.version !== 1 || !Array.isArray(c.sources)) throw new Error(`${file}: expected { version: 1, sources: [...] }`);
  return c;
}

const hasSource = (cat, id) => cat.sources.some((s) => s?.reach?.keysmith === id);

/** Returns the lines to print. Writes nothing when `dryRun`. */
export async function sourceEnable(cfgFile, name, flags = {}) {
  const facts = Object.hasOwn(SOURCE_FACTS, name) ? SOURCE_FACTS[name] : null;
  if (!facts) throw new Error(`no source "${name}" — one of: ${sourceNames().join(', ')}`);
  const id = typeof flags.as === 'string' ? flags.as : name;
  if (!ID.test(id)) throw new Error(`"${id}" cannot be an adapter id`);
  const service = flags.keyRef;
  const account = typeof flags.keyAccount === 'string' ? flags.keyAccount : 'keysmith';
  if (typeof service !== 'string' || !SAFE.test(service) || !SAFE.test(account)) {
    throw new Error(`usage: keysmith source enable ${name} --key-ref <Keychain service> [--key-account keysmith]${facts.needsAccount ? ' --account-id <id>' : ''}${facts.freeOnly ? '' : ' --model <id[,id]>'}`);
  }
  let models = list(flags.model);
  const doc = readRaw(cfgFile);
  if (getPath(doc, `adapters.${id}`) && !flags.force) throw new Error(`adapter "${id}" already exists: keysmith source disable ${name} first, or pass --force`);
  if (!keychainHas(service, account)) throw new Error(`no Keychain item "${service}" for account "${account}": nothing written (add it with \`security add-generic-password -s ${service} -a ${account} -w\`)`);

  const entry = structuredClone(getProfile(name));
  if (facts.needsAccount) entry.baseUrl = fillAccount(entry.baseUrl, flags.accountId);
  const notes = facts.note ? [`note: ${name}: ${facts.note}`] : [];
  if (!facts.freeOnly) {
    const listed = await providerModels(entry.baseUrl, keychainValue(service, account), typeof flags.modelsUrl === 'string' ? flags.modelsUrl : null);
    if (models.length) {
      if (listed) {
        const missing = models.filter((m) => !listed.includes(m));
        if (missing.length) throw new Error(`${name}: asked for ${missing.join(', ')}, but the provider's list has ${listed.slice(0, 12).join(', ')}${listed.length > 12 ? ` … (${listed.length} in all)` : ''}: nothing written`);
      } else notes.push(`note: ${name}: the provider's list could not be read, so ${models.join(', ')} was not checked against it`);
    } else {
      if (!listed) throw new Error(`${name}: no model named and the provider's /models list could not be read (no key, or no answer), so none can be chosen; name it with --model <id[,id]>`);
      models = [pickDefaultModel(listed)];
      if (!models[0]) throw new Error(`${name}: the provider's list holds no chat model; name one with --model <id[,id]>`);
      notes.push(`note: ${name}: no --model; chose ${models[0]} from the provider's list (chat, small, newest)`);
    }
  }
  entry.apiKey = `{exec:/usr/bin/security find-generic-password -s ${service} -a ${account} -w}`;
  entry.explicitOnly = true;
  if (facts.freeOnly) entry.freeOnly = true;
  if (models.length) entry.models = models;
  if (!facts.freeOnly) entry.modelsOnly = true;
  checkAdapter(id, entry);

  const lines = [...notes];
  setPath(doc, `adapters.${id}`, entry);
  lines.push(`+ adapters.${id}  ${entry.baseUrl}, key from Keychain "${service}", explicitOnly${facts.freeOnly ? ', freeOnly' : ', modelsOnly'}${models.length ? `, models ${models.join(',')}` : ''}`);
  if (getPath(doc, 'discovery.enabled') !== true) { setPath(doc, 'discovery.enabled', true); lines.push('+ discovery.enabled  true'); }
  if (facts.prices) { setPath(doc, `discovery.${id}`, { ...facts.prices }); lines.push(`+ discovery.${id}  ${JSON.stringify(facts.prices)}`); }

  const cat = catalogueFile(doc, cfgFile);
  const catalogue = readCatalogue(cat.file);
  catalogue.sources = catalogue.sources.filter((s) => s?.reach?.keysmith !== id);
  catalogue.sources.push({
    id: name, reach: { keysmith: id }, limits: { ...facts.limits },
    models: models.map((m) => ({ id: m, tier: 'free' })),
  });
  lines.push(`+ catalogue ${cat.file}  ${JSON.stringify(facts.limits)}`);
  if (cat.isNew) { setPath(doc, 'catalogue', cat.file.startsWith(os.homedir() + path.sep) ? `~${cat.file.slice(os.homedir().length)}` : cat.file); lines.push('+ catalogue  (key, pointing at that file)'); }
  if (flags.dryRun) return { lines: [...lines, '(dry run: nothing written)'] };

  if (fs.existsSync(cat.file)) backupFile(cat.file, 'source');
  writeJsonAtomic(cat.file, catalogue);
  const backup = backupFile(cfgFile, 'source');
  writeJsonAtomic(cfgFile, doc);
  lines.push(`backup ${backup}`, `restart the gateway for this to take effect (keysmith stop && keysmith start); then keysmith discover ${id}`);
  return { lines };
}

export function sourceDisable(cfgFile, name, flags = {}) {
  const id = typeof flags.as === 'string' ? flags.as : name;
  if (!ID.test(id)) throw new Error(`"${id}" cannot be an adapter id`);
  const doc = readRaw(cfgFile);
  if (!getPath(doc, `adapters.${id}`)) throw new Error(`adapter "${id}" is not attached`);
  unsetPath(doc, `adapters.${id}`);
  const lines = [`- adapters.${id}`];
  if (unsetPath(doc, `discovery.${id}`)) lines.push(`- discovery.${id}`);
  const cat = typeof doc.catalogue === 'string' && doc.catalogue.trim() ? catalogueFile(doc, cfgFile).file : null;
  let catalogue = null;
  if (cat && fs.existsSync(cat)) {
    catalogue = readCatalogue(cat);
    if (hasSource(catalogue, id)) {
      catalogue.sources = catalogue.sources.filter((s) => s?.reach?.keysmith !== id);
      lines.push(`- catalogue ${cat}  (row of ${id})`);
    } else catalogue = null;
  }
  if (flags.dryRun) return { lines: [...lines, '(dry run: nothing written)'] };
  if (catalogue) { backupFile(cat, 'source'); writeJsonAtomic(cat, catalogue); }
  lines.push(`backup ${backupFile(cfgFile, 'source')}`);
  writeJsonAtomic(cfgFile, doc);
  lines.push('restart the gateway for this to take effect (keysmith stop && keysmith start)');
  return { lines };
}
