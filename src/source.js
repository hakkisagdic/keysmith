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
export function sourceEnable(cfgFile, name, flags = {}) {
  const facts = Object.hasOwn(SOURCE_FACTS, name) ? SOURCE_FACTS[name] : null;
  if (!facts) throw new Error(`no source "${name}" — one of: ${sourceNames().join(', ')}`);
  const id = typeof flags.as === 'string' ? flags.as : name;
  if (!ID.test(id)) throw new Error(`"${id}" cannot be an adapter id`);
  const service = flags.keyRef;
  const account = typeof flags.keyAccount === 'string' ? flags.keyAccount : 'keysmith';
  if (typeof service !== 'string' || !SAFE.test(service) || !SAFE.test(account)) {
    throw new Error(`usage: keysmith source enable ${name} --key-ref <Keychain service> [--key-account keysmith]${facts.needsAccount ? ' --account-id <id>' : ''}${facts.freeOnly ? '' : ' --model <id[,id]>'}`);
  }
  const models = list(flags.model);
  if (!facts.freeOnly && !models.length) {
    throw new Error(`${name}: its /models lists no prices, so free cannot be checked; name the model(s) you accept with --model <id[,id]> (the guard here is: no alias, a catalogue limit, a named model)`);
  }
  const doc = readRaw(cfgFile);
  if (getPath(doc, `adapters.${id}`) && !flags.force) throw new Error(`adapter "${id}" already exists: keysmith source disable ${name} first, or pass --force`);
  if (!keychainHas(service, account)) throw new Error(`no Keychain item "${service}" for account "${account}": nothing written (add it with \`security add-generic-password -s ${service} -a ${account} -w\`)`);

  const entry = structuredClone(getProfile(name));
  if (facts.needsAccount) entry.baseUrl = fillAccount(entry.baseUrl, flags.accountId);
  entry.apiKey = `{exec:/usr/bin/security find-generic-password -s ${service} -a ${account} -w}`;
  entry.explicitOnly = true;
  if (facts.freeOnly) entry.freeOnly = true;
  if (models.length) entry.models = models;
  checkAdapter(id, entry);

  const lines = [];
  setPath(doc, `adapters.${id}`, entry);
  lines.push(`+ adapters.${id}  ${entry.baseUrl}, key from Keychain "${service}", explicitOnly${facts.freeOnly ? ', freeOnly' : ''}${models.length ? `, models ${models.join(',')}` : ''}`);
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
