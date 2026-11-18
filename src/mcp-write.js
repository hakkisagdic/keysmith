/**
 * keysmith MCP write tools (slice 3 of 5):
 *   - keysmith_source_add
 *   - keysmith_source_enable
 *   - keysmith_source_disable
 *   - keysmith_source_set_models
 *   - keysmith_model_approve
 *   - keysmith_model_revoke
 *
 * All write tools require `confirm: true` (enforced centrally in src/mcp.js),
 * serialize config edits, create a mode-0600 backup first, write atomically
 * with mode 0600, wrap existing keysmith modules (source.js, config-edit.js,
 * gateway.js), and scrub secrets, reference interiors, and directory paths
 * before returning results.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPath, readRaw, setPath } from './config-edit.js';
import { checkAdapter, kindOf } from './gateway.js';
import { registerTool, writeConfigWithBackup } from './mcp.js';
import { SOURCE_FACTS } from './profiles.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { sourceEnable, sourceNames } from './source.js';
import { isPlainObject } from './tools/model.js';

const ADAPTER_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_KEYCHAIN_NAME_RE = /^[A-Za-z0-9._:@/-]+$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const ANY_REF_RE = /^\{([a-z][a-z0-9_-]*):([\s\S]*)\}$/i;
const SECRET_SHAPE_RE = /^(ks_|sk[-_]|gsk_|xai-|AIza|gh[pousr]_|Bearer\s|Basic\s)/i;
const CF_ACCOUNT_SEG_RE = /(\/accounts\/)(?!\{account\})(?!\[redacted\])[^/?#]+/gi;
const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);

let writeQueue = Promise.resolve();

function withWriteLock(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function withScopedEnv(ctx, fn) {
  const prevConfig = process.env.KEYSMITH_CONFIG;
  const prevData = process.env.KEYSMITH_DATA;
  const prevHome = process.env.HOME;
  if (ctx?.configFile) process.env.KEYSMITH_CONFIG = ctx.configFile;
  if (ctx?.dataDir) process.env.KEYSMITH_DATA = ctx.dataDir;
  if (ctx?.homeDir) process.env.HOME = ctx.homeDir;
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
      // Unreadable or malformed config is handled by the caller.
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

function backupBasename(fullPath) {
  return typeof fullPath === 'string' && fullPath.trim() ? path.basename(fullPath.trim()) : null;
}

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

function validateSourceName(rawSource) {
  const source = typeof rawSource === 'string' ? rawSource.trim() : '';
  if (!source) return { ok: false, error: 'source is required' };
  if (FORBIDDEN_IDS.has(source)) return { ok: false, error: `invalid source name "${source}"` };
  return { ok: true, source };
}

function validateModelId(rawModel) {
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!model) return { ok: false, error: 'model is required' };
  if (FORBIDDEN_IDS.has(model)) return { ok: false, error: `invalid model id "${model}"` };
  if (/[\r\n]/.test(model)) return { ok: false, error: 'model id must not contain newlines' };
  return { ok: true, model };
}

function looksLikeSecretOrRef(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s.includes('{') || s.includes('}') || SECRET_SHAPE_RE.test(s);
}

function runWriteConfigWithBackup(ctx, mutate) {
  if (typeof ctx?.writeConfigWithBackup === 'function') {
    return ctx.writeConfigWithBackup(mutate, { tag: 'mcp' });
  }
  return writeConfigWithBackup(ctx.configFile, mutate, { tag: 'mcp' });
}

function ensureConfigExists(ctx, extraLiterals) {
  if (!ctx?.configFile || !fs.existsSync(ctx.configFile)) {
    return toolError('config file does not exist; run keysmith init first', {}, extraLiterals, ctx);
  }
  return null;
}

function requireExistingAdapter(doc, source, extraLiterals, ctx) {
  const entry = getPath(doc, `adapters.${source}`);
  if (!isPlainObject(entry)) {
    return {
      ok: false,
      error: toolError(`unknown source "${source}"`, { source }, extraLiterals, ctx),
    };
  }
  return { ok: true, entry };
}

/**
 * Provide a scoped temporary KEYSMITH_SECURITY_BIN wrapper when `ctx.keychainHas`
 * is injected so `sourceEnable` never calls the real `/usr/bin/security` binary.
 */
async function withScopedKeychainAndFetch(ctx, service, account, extraLiterals, fn) {
  const prevSec = process.env.KEYSMITH_SECURITY_BIN;
  const prevFetch = globalThis.fetch;
  let tempDir = null;

  try {
    if (typeof ctx?.keychainHas === 'function') {
      const exists = Boolean(await ctx.keychainHas(service, account));
      if (!exists) {
        return { missingKeychain: true };
      }

      let secretOut = '';
      if (typeof ctx?.keychainRead === 'function') {
        const readVal = await ctx.keychainRead(service, account);
        if (readVal) {
          secretOut = String(readVal).trim();
          registerSecrets([secretOut]);
          extraLiterals.push(secretOut);
        }
      } else if (typeof ctx?.fetch === 'function') {
        secretOut = 'ks_test_kc_placeholder_' + crypto.randomBytes(6).toString('hex');
        registerSecrets([secretOut]);
        extraLiterals.push(secretOut);
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-mcp-kc-'));
      const stubPath = path.join(tempDir, 'security-stub.sh');
      const secretFile = path.join(tempDir, 'val.txt');
      if (secretOut) {
        fs.writeFileSync(secretFile, secretOut, { mode: 0o600 });
      }
      const script = [
        '#!/bin/sh',
        'want_w=0',
        'for arg in "$@"; do',
        '  if [ "$arg" = "-w" ]; then want_w=1; fi',
        'done',
        secretOut
          ? `if [ "$want_w" = "1" ]; then cat "${secretFile}"; fi`
          : 'true',
        'exit 0',
        '',
      ].join('\n');
      fs.writeFileSync(stubPath, script, { mode: 0o700 });
      process.env.KEYSMITH_SECURITY_BIN = stubPath;
    }

    if (typeof ctx?.fetch === 'function') {
      globalThis.fetch = ctx.fetch;
    }

    const value = await fn();
    return { missingKeychain: false, value };
  } finally {
    if (prevSec === undefined) delete process.env.KEYSMITH_SECURITY_BIN;
    else process.env.KEYSMITH_SECURITY_BIN = prevSec;
    globalThis.fetch = prevFetch;
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/* ------------------------------------------------------------- tool handlers */

async function handleSourceAdd(args, ctx) {
  return await withWriteLock(async () =>
    withScopedEnv(ctx, async () => {
      const seedLiterals = [];
      for (const field of ['keyRef', 'keyAccount', 'accountId', 'apiKey', 'key', 'secret', 'keyValue']) {
        if (typeof args?.[field] === 'string' && args[field].trim()) {
          seedLiterals.push(args[field].trim());
        }
      }
      const extraLiterals = collectExtraLiterals(ctx?.configFile, seedLiterals);

      if (
        Object.hasOwn(args || {}, 'apiKey') ||
        Object.hasOwn(args || {}, 'key') ||
        Object.hasOwn(args || {}, 'secret') ||
        Object.hasOwn(args || {}, 'keyValue')
      ) {
        for (const field of ['apiKey', 'key', 'secret', 'keyValue']) {
          if (typeof args?.[field] === 'string' && args[field].trim()) {
            registerSecrets([args[field].trim()]);
          }
        }
        return toolError(
          'keysmith_source_add accepts Keychain service/account names (keyRef/keyAccount), never a key value',
          {},
          extraLiterals,
          ctx,
        );
      }

      const missingCfg = ensureConfigExists(ctx, extraLiterals);
      if (missingCfg) return missingCfg;

      const profile = typeof args?.profile === 'string' ? args.profile.trim() : '';
      const validProfiles = sourceNames();
      if (!profile || !validProfiles.includes(profile)) {
        return toolError(
          `unknown source profile "${profile || '(empty)'}" — expected one of: ${validProfiles.join(', ')}`,
          {},
          extraLiterals,
          ctx,
        );
      }
      const facts = SOURCE_FACTS[profile] || {};

      const targetId = args?.as !== undefined && args?.as !== null ? String(args.as).trim() : profile;
      if (!ADAPTER_ID_RE.test(targetId) || FORBIDDEN_IDS.has(targetId)) {
        return toolError(`invalid adapter id "${targetId}"`, {}, extraLiterals, ctx);
      }

      const rawKeyRef = typeof args?.keyRef === 'string' ? args.keyRef.trim() : '';
      if (!rawKeyRef) {
        return toolError('keyRef (Keychain service name) is required', { source: targetId, profile }, extraLiterals, ctx);
      }
      if (looksLikeSecretOrRef(rawKeyRef)) {
        if (!rawKeyRef.includes('{')) registerSecrets([rawKeyRef]);
        return toolError(
          'keyRef must be a Keychain service name, never a key value or {...} secret reference',
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }
      if (!SAFE_KEYCHAIN_NAME_RE.test(rawKeyRef)) {
        return toolError(
          'keyRef contains invalid characters for a Keychain service name',
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }

      const rawKeyAccount =
        args?.keyAccount !== undefined && args?.keyAccount !== null && String(args.keyAccount).trim() !== ''
          ? String(args.keyAccount).trim()
          : 'keysmith';
      if (looksLikeSecretOrRef(rawKeyAccount)) {
        if (!rawKeyAccount.includes('{')) registerSecrets([rawKeyAccount]);
        return toolError(
          'keyAccount must be a Keychain account name, never a key value or {...} secret reference',
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }
      if (!SAFE_KEYCHAIN_NAME_RE.test(rawKeyAccount)) {
        return toolError(
          'keyAccount contains invalid characters for a Keychain account name',
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }

      let modelList = [];
      if (args?.models !== undefined && args?.models !== null) {
        if (!Array.isArray(args.models)) {
          return toolError('models must be an array of model id strings', { source: targetId, profile }, extraLiterals, ctx);
        }
        const seen = new Set();
        for (const item of args.models) {
          if (typeof item !== 'string') {
            return toolError('models must contain only non-empty strings', { source: targetId, profile }, extraLiterals, ctx);
          }
          const trimmed = item.trim();
          if (!trimmed || /[,\s]/.test(trimmed) || FORBIDDEN_IDS.has(trimmed)) {
            return toolError(`invalid model id "${trimmed}"`, { source: targetId, profile }, extraLiterals, ctx);
          }
          if (!seen.has(trimmed)) {
            seen.add(trimmed);
            modelList.push(trimmed);
          }
        }
      }

      let accountId;
      if (args?.accountId !== undefined && args?.accountId !== null) {
        accountId = String(args.accountId).trim();
      }
      if (facts.needsAccount && (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId))) {
        return toolError(
          `source "${profile}" requires a 32-hex accountId`,
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }

      const flags = {
        keyRef: rawKeyRef,
        keyAccount: rawKeyAccount,
        ...(args?.as !== undefined && args?.as !== null ? { as: targetId } : {}),
        ...(modelList.length ? { model: modelList.join(',') } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(args?.force === true ? { force: true } : {}),
      };

      let runRes;
      try {
        runRes = await withScopedKeychainAndFetch(ctx, rawKeyRef, rawKeyAccount, extraLiterals, async () => {
          return await sourceEnable(ctx.configFile, profile, flags);
        });
      } catch (e) {
        return toolError(e?.message || String(e), { source: targetId, profile }, extraLiterals, ctx);
      }

      if (runRes.missingKeychain) {
        return toolError(
          'Keychain item not found for the specified service and account; nothing written',
          { source: targetId, profile },
          extraLiterals,
          ctx,
        );
      }

      const doc = readRaw(ctx.configFile);
      const written = getPath(doc, `adapters.${targetId}`) || {};
      const lines = Array.isArray(runRes.value?.lines) ? runRes.value.lines : [];
      const backupLine = lines.find((l) => typeof l === 'string' && l.startsWith('backup '));
      const backupPath = backupLine ? backupLine.slice('backup '.length).trim() : null;

      return scrubOutput(
        {
          ok: true,
          changed: true,
          source: targetId,
          profile,
          disabled: Boolean(written.disabled),
          explicitOnly: Boolean(written.explicitOnly),
          freeOnly: written.freeOnly === true,
          modelsOnly: written.modelsOnly === true,
          models: extractDeclaredModelIds(written.models),
          keyRefType: 'exec',
          catalogueUpdated: true,
          backup: backupBasename(backupPath),
          reloadRequired: true,
          ...(facts.note ? { note: facts.note } : {}),
        },
        extraLiterals,
        ctx,
      );
    }),
  );
}

async function toggleSourceDisabled(args, ctx, targetDisabled) {
  return await withWriteLock(async () =>
    withScopedEnv(ctx, async () => {
      const extraLiterals = collectExtraLiterals(ctx?.configFile);
      const missingCfg = ensureConfigExists(ctx, extraLiterals);
      if (missingCfg) return missingCfg;

      const nameCheck = validateSourceName(args?.source);
      if (!nameCheck.ok) return toolError(nameCheck.error, {}, extraLiterals, ctx);
      const { source } = nameCheck;

      let doc;
      try {
        doc = readRaw(ctx.configFile);
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }
      const existing = requireExistingAdapter(doc, source, extraLiterals, ctx);
      if (!existing.ok) return existing.error;

      if (!targetDisabled && existing.entry.unsafeTools === true) {
        return toolError(
          `source "${source}" is marked unsafeTools and cannot be enabled via MCP`,
          { source },
          extraLiterals,
          ctx,
        );
      }

      const previousDisabled = Boolean(existing.entry.disabled);
      let writeRes;
      try {
        writeRes = await runWriteConfigWithBackup(ctx, (draft) => {
          const cur = getPath(draft, `adapters.${source}`);
          if (!isPlainObject(cur)) throw new Error(`unknown source "${source}"`);
          if (targetDisabled) {
            if (cur.disabled === true) return { disabled: true };
            setPath(draft, `adapters.${source}.disabled`, true);
          } else {
            if (!cur.disabled) return { disabled: false };
            setPath(draft, `adapters.${source}.disabled`, false);
          }
          checkAdapter(source, draft.adapters[source]);
          return { disabled: Boolean(draft.adapters[source].disabled) };
        });
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }

      return scrubOutput(
        {
          ok: true,
          changed: writeRes.changed,
          source,
          field: 'disabled',
          previousDisabled,
          disabled: targetDisabled,
          backup: backupBasename(writeRes.backup),
          reloadRequired: writeRes.changed,
        },
        extraLiterals,
        ctx,
      );
    }),
  );
}

function buildModelsField(existingModels, nextIds) {
  if (isPlainObject(existingModels)) {
    const out = {};
    for (const id of nextIds) {
      out[id] = Object.hasOwn(existingModels, id) && isPlainObject(existingModels[id])
        ? structuredClone(existingModels[id])
        : {};
    }
    return out;
  }
  if (Array.isArray(existingModels)) {
    const metaById = new Map();
    for (const item of existingModels) {
      if (isPlainObject(item) && typeof item.id === 'string' && item.id) {
        metaById.set(item.id, item);
      }
    }
    if (metaById.size > 0) {
      return nextIds.map((id) => (metaById.has(id) ? structuredClone(metaById.get(id)) : id));
    }
  }
  return [...nextIds];
}

async function handleSourceSetModels(args, ctx) {
  return await withWriteLock(async () =>
    withScopedEnv(ctx, async () => {
      const extraLiterals = collectExtraLiterals(ctx?.configFile);
      const missingCfg = ensureConfigExists(ctx, extraLiterals);
      if (missingCfg) return missingCfg;

      const nameCheck = validateSourceName(args?.source);
      if (!nameCheck.ok) return toolError(nameCheck.error, {}, extraLiterals, ctx);
      const { source } = nameCheck;

      if (!Array.isArray(args?.models)) {
        return toolError('models must be an array of model id strings', { source }, extraLiterals, ctx);
      }
      const nextIds = [];
      const seen = new Set();
      for (const item of args.models) {
        if (typeof item !== 'string') {
          return toolError('models must contain only non-empty strings', { source }, extraLiterals, ctx);
        }
        const check = validateModelId(item);
        if (!check.ok) return toolError(check.error, { source }, extraLiterals, ctx);
        if (!seen.has(check.model)) {
          seen.add(check.model);
          nextIds.push(check.model);
        }
      }

      let doc;
      try {
        doc = readRaw(ctx.configFile);
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }
      const existing = requireExistingAdapter(doc, source, extraLiterals, ctx);
      if (!existing.ok) return existing.error;
      if (kindOf(existing.entry) === 'cli') {
        return toolError('approved model lists are enforced only on HTTP sources', { source }, extraLiterals, ctx);
      }

      const previousModels = extractDeclaredModelIds(existing.entry.models);
      const prevSet = new Set(previousModels);
      const nextSet = new Set(nextIds);
      const added = nextIds.filter((id) => !prevSet.has(id));
      const removed = previousModels.filter((id) => !nextSet.has(id));

      let writeRes;
      try {
        writeRes = await runWriteConfigWithBackup(ctx, (draft) => {
          const cur = getPath(draft, `adapters.${source}`);
          if (!isPlainObject(cur)) throw new Error(`unknown source "${source}"`);
          const nextModelsField = buildModelsField(cur.models, nextIds);
          setPath(draft, `adapters.${source}.models`, nextModelsField);
          setPath(draft, `adapters.${source}.modelsOnly`, true);
          checkAdapter(source, draft.adapters[source]);
        });
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }

      return scrubOutput(
        {
          ok: true,
          changed: writeRes.changed,
          source,
          modelsOnly: true,
          previousModels,
          models: nextIds,
          added,
          removed,
          backup: backupBasename(writeRes.backup),
          reloadRequired: writeRes.changed,
        },
        extraLiterals,
        ctx,
      );
    }),
  );
}

async function handleModelApprove(args, ctx) {
  return await withWriteLock(async () =>
    withScopedEnv(ctx, async () => {
      const extraLiterals = collectExtraLiterals(ctx?.configFile);
      const missingCfg = ensureConfigExists(ctx, extraLiterals);
      if (missingCfg) return missingCfg;

      const nameCheck = validateSourceName(args?.source);
      if (!nameCheck.ok) return toolError(nameCheck.error, {}, extraLiterals, ctx);
      const { source } = nameCheck;

      const modelCheck = validateModelId(args?.model);
      if (!modelCheck.ok) return toolError(modelCheck.error, { source }, extraLiterals, ctx);
      const { model } = modelCheck;

      let doc;
      try {
        doc = readRaw(ctx.configFile);
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }
      const existing = requireExistingAdapter(doc, source, extraLiterals, ctx);
      if (!existing.ok) return existing.error;
      if (kindOf(existing.entry) === 'cli') {
        return toolError('approved model lists are enforced only on HTTP sources', { source }, extraLiterals, ctx);
      }

      let writeRes;
      try {
        writeRes = await runWriteConfigWithBackup(ctx, (draft) => {
          const cur = getPath(draft, `adapters.${source}`);
          if (!isPlainObject(cur)) throw new Error(`unknown source "${source}"`);
          const curIds = extractDeclaredModelIds(cur.models);
          if (!curIds.includes(model)) {
            if (isPlainObject(cur.models)) {
              cur.models[model] = {};
            } else if (Array.isArray(cur.models)) {
              cur.models.push(model);
            } else {
              cur.models = [model];
            }
          }
          setPath(draft, `adapters.${source}.modelsOnly`, true);
          checkAdapter(source, draft.adapters[source]);
          return {
            models: extractDeclaredModelIds(draft.adapters[source].models),
          };
        });
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }

      return scrubOutput(
        {
          ok: true,
          changed: writeRes.changed,
          source,
          model,
          approved: true,
          modelsOnly: true,
          models: writeRes.models,
          backup: backupBasename(writeRes.backup),
          reloadRequired: writeRes.changed,
        },
        extraLiterals,
        ctx,
      );
    }),
  );
}

async function handleModelRevoke(args, ctx) {
  return await withWriteLock(async () =>
    withScopedEnv(ctx, async () => {
      const extraLiterals = collectExtraLiterals(ctx?.configFile);
      const missingCfg = ensureConfigExists(ctx, extraLiterals);
      if (missingCfg) return missingCfg;

      const nameCheck = validateSourceName(args?.source);
      if (!nameCheck.ok) return toolError(nameCheck.error, {}, extraLiterals, ctx);
      const { source } = nameCheck;

      const modelCheck = validateModelId(args?.model);
      if (!modelCheck.ok) return toolError(modelCheck.error, { source }, extraLiterals, ctx);
      const { model } = modelCheck;

      let doc;
      try {
        doc = readRaw(ctx.configFile);
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }
      const existing = requireExistingAdapter(doc, source, extraLiterals, ctx);
      if (!existing.ok) return existing.error;
      if (kindOf(existing.entry) === 'cli') {
        return toolError('approved model lists are enforced only on HTTP sources', { source }, extraLiterals, ctx);
      }

      let writeRes;
      try {
        writeRes = await runWriteConfigWithBackup(ctx, (draft) => {
          const cur = getPath(draft, `adapters.${source}`);
          if (!isPlainObject(cur)) throw new Error(`unknown source "${source}"`);
          const curIds = extractDeclaredModelIds(cur.models);
          if (!curIds.includes(model)) {
            return {
              modelsOnly: cur.modelsOnly === true,
              models: curIds,
            };
          }
          if (isPlainObject(cur.models)) {
            delete cur.models[model];
          } else if (Array.isArray(cur.models)) {
            cur.models = cur.models.filter((item) => {
              const id = typeof item === 'string' ? item : isPlainObject(item) ? item.id : null;
              return id !== model;
            });
          }
          setPath(draft, `adapters.${source}.modelsOnly`, true);
          checkAdapter(source, draft.adapters[source]);
          return {
            modelsOnly: true,
            models: extractDeclaredModelIds(draft.adapters[source].models),
          };
        });
      } catch (e) {
        return toolError(e?.message || String(e), { source }, extraLiterals, ctx);
      }

      return scrubOutput(
        {
          ok: true,
          changed: writeRes.changed,
          source,
          model,
          approved: false,
          modelsOnly: writeRes.modelsOnly,
          models: writeRes.models,
          backup: backupBasename(writeRes.backup),
          reloadRequired: writeRes.changed,
        },
        extraLiterals,
        ctx,
      );
    }),
  );
}

/* -------------------------------------------------------------- registration */

const WRITE_TOOLS = [
  {
    name: 'keysmith_source_add',
    description:
      'Attach a built-in free-tier source using a Keychain service/account name (writes an {exec:...} Keychain reference, never a key value) after creating a mode-0600 backup.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: `Built-in source profile name (${sourceNames().join(', ')}).`,
        },
        keyRef: {
          type: 'string',
          description: 'Keychain generic-password service name (-s), never a key value or {...} reference.',
        },
        keyAccount: {
          type: 'string',
          description: 'Keychain generic-password account name (-a). Defaults to "keysmith".',
        },
        as: {
          type: 'string',
          description: 'Optional custom source (adapter) id in config; defaults to the profile name.',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional initial model ids to allow on the source.',
        },
        accountId: {
          type: 'string',
          description: '32-hex Cloudflare account id (required only for cloudflare; never echoed back).',
        },
        force: {
          type: 'boolean',
          description: 'Overwrite an existing source entry with the same id.',
        },
      },
      required: ['profile', 'keyRef'],
    },
    handler: handleSourceAdd,
  },
  {
    name: 'keysmith_source_enable',
    description: 'Enable a configured source (sets disabled: false) with backup-first atomic write.',
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
    handler: (args, ctx) => toggleSourceDisabled(args, ctx, false),
  },
  {
    name: 'keysmith_source_disable',
    description: 'Disable a configured source (sets disabled: true) with backup-first atomic write.',
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
    handler: (args, ctx) => toggleSourceDisabled(args, ctx, true),
  },
  {
    name: 'keysmith_source_set_models',
    description:
      "Replace a configured source's approved models list (keeps modelsOnly: true) with backup-first atomic write.",
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Configured source (adapter) id.',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact list of model ids to allow for this source.',
        },
      },
      required: ['source', 'models'],
    },
    handler: handleSourceSetModels,
  },
  {
    name: 'keysmith_model_approve',
    description:
      "Add a model to a source's approved models list (ensures modelsOnly: true) with backup-first atomic write.",
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Configured source (adapter) id.',
        },
        model: {
          type: 'string',
          description: 'Model id to approve for this source.',
        },
      },
      required: ['source', 'model'],
    },
    handler: handleModelApprove,
  },
  {
    name: 'keysmith_model_revoke',
    description:
      "Remove a model from a source's approved models list (keeps modelsOnly: true) with backup-first atomic write.",
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Configured source (adapter) id.',
        },
        model: {
          type: 'string',
          description: 'Model id to revoke from this source.',
        },
      },
      required: ['source', 'model'],
    },
    handler: handleModelRevoke,
  },
];

export function registerTools(register = registerTool) {
  for (const def of WRITE_TOOLS) {
    register({
      ...def,
      write: true,
      destructive: true,
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  }
}
