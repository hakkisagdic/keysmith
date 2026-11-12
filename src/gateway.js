import { randomUUID } from 'node:crypto';
import { HttpAdapter } from './http-adapter.js';
import { CliAdapter, which } from './cli-adapter.js';
import { LlmError, routeError, truncate } from './util.js';
import { resolveSecret } from './config.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { ThoughtSignatures, limitsFrom } from './thought-signatures.js';
import { adapterReach, aliasDecision, globCanStartWith, requestDecision, scopeText, virtualDecision } from './keys.js';
import { describeUnsupported, relaysVerbatim, toolEvents, toolPath, toolSkipReason } from './tools/router.js';
import { addUsage } from './tools/emulate.js';
import { McpBridge } from './bridge/index.js';
import { CreditGuard, creditGuardError } from './credit-guard.js';
import { DRIVERS } from './bridge/drivers.js';
import { resolveEffort, suffixedIds } from './effort.js';
import { credentialAccount, execAccountMigrationWarnings, fmtUsd, hostOf, isExecCredentialAdapter } from './usage.js';
import {
  TIER_ORDER,
  buildVirtualCandidateList,
  checkVirtualModel,
  classifyPrompt,
  defaultLoadProbe,
  evaluateLoadGate,
  extractClassifierPrompt,
  formatRouteExplain,
  isFallthroughError,
  isLocalAdapter,
  parseClassifierLabel,
  validateVirtualModels,
} from './virtual-models.js';

export {
  LlmError,
  checkVirtualModel,
  validateVirtualModels,
  formatRouteExplain,
  evaluateLoadGate,
  isLocalAdapter,
  parseClassifierLabel,
  classifyPrompt,
  buildVirtualCandidateList,
  isFallthroughError,
};

/**
 * The gateway: config in, one model catalogue + one streaming `complete()` out.
 *
 * Namespacing rule: `<adapter>/<upstream model>`. Upstream ids may themselves
 * contain slashes (`deepseek/deepseek-v4-flash` on OpenRouter), so only the FIRST
 * slash separates adapter from model. Adapter ids are config keys and therefore
 * slash-free by construction.
 */
export class Gateway {
  constructor(cfg, { log = () => {}, usage = null, deferAdapterChecks = false, loadProbe = null, now = null, adapters = null, creditGuard = null } = {}) {
    this.cfg = cfg;
    this.usage = usage;
    this.loadProbe = typeof loadProbe === 'function' ? loadProbe : defaultLoadProbe;
    this.now = typeof now === 'function' ? now : () => Date.now();
    // Redacted here as well as by the CLI's writer: an embedding's own log function is
    // handed provider errors, and those can quote a key.
    this.log = (m) => log(redactSecrets(m));
    // Kiro's plan credits (src/credit-guard.js): a leg of an adapter that runs kiro-cli is passed
    // by while its plan is at or over its threshold. In memory unless the caller keeps the
    // readings in a file (the CLI does: dataDir()/credit-guard.json).
    this.creditGuard = creditGuard || new CreditGuard({ log: this.log });
    if (this.usage && !this.usage.log) this.usage.log = this.log;
    this._virtualCache = new Map();
    const rawAdaptersMap = new Map();
    const origSet = rawAdaptersMap.set.bind(rawAdaptersMap);
    rawAdaptersMap.set = (k, v) => {
      this._virtualCache.clear();
      return origSet(k, v);
    };
    this.adapters = rawAdaptersMap;
    this.loadErrors = {}; // adapter id -> why it never constructed; doctor and /status must say so
    this.sessions = new Map(); // x-keysmith-session id -> {adapter, upstream session}
    this.inFlight = 0;
    // Upstream URL -> the one thought-signature store every adapter on it shares, so a
    // failover leg to a second key on the same endpoint can put back what the first leg saw.
    this.signatureStores = new Map();
    // The tool engines a CLI leg can run besides EMULATE (src/tools/router.js): the MCP bridge,
    // `{ check(adapter, spec, ctx), run(adapter, opts) }` (src/bridge/index.js), when an adapter
    // can use it — set below, once the adapters are loaded. Without it toolMode auto is EMULATE,
    // and toolMode mcp a 503.
    this.toolEngines = { mcp: null };
    if (adapters) {
      const entries = adapters instanceof Map ? adapters.entries() : Object.entries(adapters);
      for (const [id, inst] of entries) {
        if (inst) this.adapters.set(id, inst);
      }
    }
    for (const [id, raw] of Object.entries(cfg.adapters || {})) {
      try {
        if (raw && typeof raw.complete === 'function') {
          if (!raw.id) raw.id = id;
          this.adapters.set(id, raw);
          continue;
        }
        const prepared = prepareAdapter(id, raw);
        // From here on every log line, usage row and error message takes this key out, the
        // way it takes out the gateway's own (redact.js).
        registerSecrets([prepared._apiKey]);
        if (prepared.kind !== 'cli' && prepared.thoughtSignatures) prepared._signatureStore = this._signatureStore(prepared);
        // Whether a media URL a request sends is fetched (public addresses only) or refused: the gateway's call, not an adapter's.
        prepared._fetchMedia = cfg.fetchMedia !== false;
        const adapter = prepared.kind === 'cli' ? new CliAdapter(id, prepared) : new HttpAdapter(id, prepared);
        this.adapters.set(id, adapter);
        if (adapter.unsafeTools && !adapter.disabled) this.log(`adapter "${id}" can run commands and edit files (unsafeTools) and is enabled: it answers requests that name it, never an alias`);
        if (adapter.kind === 'cli' && !adapter.disabled && !deferAdapterChecks) {
          const wsCheck = adapter.checkWorkspaceFiles?.();
          if (wsCheck?.warning) {
            adapter._workspaceWarned = true;
            this.log(`adapter "${id}": ${wsCheck.warning}`);
          }
        }
      } catch (e) {
        // Shown on /status, /v1/models, /v1/keysmith/routes and by doctor: redacted at the source.
        this.loadErrors[id] = redactSecrets(e.message);
        this.log(`adapter "${id}" failed to load: ${e.message}`);
      }
    }
    // Validate virtualModels at load: throws a descriptive Error if virtualModels is invalid.
    this.virtualModels = validateVirtualModels(cfg, {
      adapters: this.adapters,
      loadErrors: new Map(Object.entries(this.loadErrors)),
      requireAdapter: true,
    });
    // The bridge exists when a CLI with toolMode mcp or auto has a driver for it (a `bridge.args`,
    // and the driver it names: agy, opencode, codex, qoder). Nothing listens until the first
    // request that takes it, or `serve`'s start().
    const bridged = [...this.adapters.values()].some((a) => a.kind === 'cli' && (a.toolMode === 'mcp' || a.toolMode === 'auto') && DRIVERS.some((d) => d.supports(a)));
    if (bridged) this.toolEngines.mcp = new McpBridge({ limits: cfg.limits?.bridge, log: this.log, adapters: () => [...this.adapters.values()] });
    this._warnedExecMigration = false;
    const hasExecAdapter = Object.values(cfg.adapters || {}).some((raw) => isExecCredentialAdapter(raw));
    this._warnExecMigrationOnce({ checkDisk: hasExecAdapter });
  }

  _warnExecMigrationOnce({ checkDisk = false } = {}) {
    if (this._warnedExecMigration) return;
    const warnings = execAccountMigrationWarnings(this.cfg, this.usage, { checkDisk });
    if (!warnings.length) return;
    this._warnedExecMigration = true;
    for (const w of warnings) this.log(w);
  }

  /** Stop what the gateway runs on its own: the MCP bridge's sessions (each CLI stopped) and its socket. */
  async close() {
    await this.toolEngines.mcp?.close?.();
  }

  /**
   * Run startup/health checks (workspace files + CLI version) across enabled CLI adapters.
   * Logs any warnings not yet logged and returns all current warnings as `Array<string>`.
   */
  async checkAdapters({ log = null } = {}) {
    const logger = log ? (m) => log(redactSecrets(m)) : this.log;
    const warnings = [];
    for (const adapter of this.publicAdapters) {
      if (adapter.kind !== 'cli' || typeof adapter.probe !== 'function') continue;
      const res = await adapter.probe();
      if (res.workspaceWarning) {
        const line = `adapter "${adapter.id}": ${res.workspaceWarning}`;
        warnings.push(line);
        if (!adapter._workspaceWarned) {
          adapter._workspaceWarned = true;
          logger(line);
        }
      }
      if (res.versionWarning) {
        const line = `adapter "${adapter.id}": ${res.versionWarning}`;
        warnings.push(line);
        if (!adapter._versionWarned) {
          adapter._versionWarned = true;
          logger(line);
        }
      }
    }
    return warnings;
  }

  /**
   * Throw a 429 rate_limit_error when `adapter` (or its credential account) has reached its
   * recorded metered spend cap for the current UTC calendar month (`limits.spend`).
   */
  checkSpend(adapter, upstreamModel = '', scope = null) {
    const err = this._spendCapError(adapter, upstreamModel, scope);
    if (err) throw err;
  }

  reserveSpend(adapter, upstreamModel = '', scope = null, { inputTokens = 1, outputTokens = 256 } = {}) {
    this.checkSpend(adapter, upstreamModel, scope);
    const spendCfg = this.cfg?.limits?.spend;
    if (!spendCfg || !this.usage || !adapter || typeof this.usage.reserveSpend !== 'function') return () => {};
    return this.usage.reserveSpend(spendCfg, adapter, {
      adaptersCfg: this.cfg?.adapters,
      model: upstreamModel,
      upstreamModel: typeof adapter.upstreamModel === 'function' ? adapter.upstreamModel(upstreamModel) : upstreamModel,
      inputTokens,
      outputTokens,
    });
  }

  /**
   * Realistic token estimate for in-flight spend reservation:
   * - inputTokens: prompt characters / 4 (across messages, tool messages, tool definitions, or input)
   * - outputTokens: requested max output tokens, or the adapter's max output tokens when absent
   */
  estimateTokens(adapter, model = '', args = {}, tools = null) {
    const msgChars = Math.max(countPromptChars(args?.messages), countPromptChars(tools?.messages));
    const toolChars = countPromptChars(tools?.spec?.tools);
    const inputChars = countPromptChars(args?.input);
    const totalChars = msgChars + toolChars + inputChars;
    const inputTokens = Math.max(1, Math.ceil(totalChars / 4));

    if (args?.maxTokens === 0) {
      return { inputTokens, outputTokens: 0 };
    }
    const reqMax = Number(args?.maxTokens ?? args?.maxCompletionTokens ?? args?.maxOutputTokens);
    if (Number.isFinite(reqMax) && reqMax > 0) {
      return { inputTokens, outputTokens: reqMax };
    }
    const upModel = typeof adapter?.upstreamModel === 'function' ? adapter.upstreamModel(model) : model;
    const mp = typeof adapter?._paramsFor === 'function'
      ? adapter._paramsFor(upModel)
      : (adapter?.modelParams?.[upModel] || adapter?.modelParams?.[model] || null);
    const rawAdapterCfg = adapter?.id ? this.cfg?.adapters?.[adapter.id] : null;
    const adapterMax = Number(
      mp?.max_tokens ??
      mp?.max_completion_tokens ??
      mp?.max_output_tokens ??
      mp?.maxTokens ??
      mp?.maxOutputTokens ??
      adapter?.maxOutputTokens ??
      adapter?.maxTokens ??
      adapter?.max_tokens ??
      rawAdapterCfg?.maxOutputTokens ??
      rawAdapterCfg?.maxTokens ??
      rawAdapterCfg?.max_tokens,
    );
    const outputTokens = Number.isFinite(adapterMax) && adapterMax > 0 ? adapterMax : 4096;
    return { inputTokens, outputTokens };
  }

  _spendCapError(adapter, upstreamModel = '', scope = null) {
    const spendCfg = this.cfg?.limits?.spend;
    if (!spendCfg || !this.usage || !adapter) return null;
    const capped = this.usage.checkSpendCap(spendCfg, adapter, { adaptersCfg: this.cfg?.adapters });
    this._warnExecMigrationOnce({ checkDisk: false });
    if (!capped) return null;
    const msg = capped.error
      ? `spend cap for ${capped.kind} "${capped.target}" (${fmtUsd(capped.cap)} monthly cap in ${capped.month}, resets ${capped.resetAt}): refusing request because the usage log is unreadable (${capped.error})`
      : scope
        ? `spend cap reached for ${capped.kind} "${capped.target}" (${fmtUsd(capped.cap)} monthly cap in ${capped.month}, resets ${capped.resetAt})`
        : `spend cap reached for ${capped.kind} "${capped.target}": spent ${fmtUsd(capped.spent)} of ${fmtUsd(capped.cap)} monthly cap in ${capped.month} (resets ${capped.resetAt})`;
    const err = new LlmError(msg, {
      status: 429,
      type: 'rate_limit_error',
      provider: adapter.id,
    });
    if (capped.error) {
      err.retryAfter = capped.retryAfter || 5;
    } else {
      const nowMs = this.usage?._nowDate ? this.usage._nowDate().getTime() : Date.now();
      const resetMs = Date.parse(capped.resetAt);
      err.retryAfter = Number.isFinite(resetMs) ? Math.max(1, Math.ceil((resetMs - nowMs) / 1000)) : 3600;
    }
    err.spendCap = capped;
    err.leg = legMetaOf(adapter, upstreamModel);
    return err;
  }

  isVirtualModel(requested) {
    if (!requested || typeof requested !== 'string') return false;
    return this.virtualModels?.has?.(requested) || own(this.cfg?.virtualModels, requested);
  }

  getVirtualSpec(requested) {
    if (!this.isVirtualModel(requested)) return null;
    if (this.virtualModels?.has?.(requested)) return this.virtualModels.get(requested);
    const raw = own(this.cfg?.virtualModels, requested) ? this.cfg.virtualModels[requested] : null;
    if (!raw) return null;
    const spec = checkVirtualModel(requested, raw, {
      cfg: this.cfg,
      adapters: this.adapters,
      loadErrors: new Map(Object.entries(this.loadErrors)),
      requireAdapter: true,
    });
    this.virtualModels.set(requested, spec);
    return spec;
  }

  /**
   * Check whether `scope` permits reaching concrete target `adapterId/model` during virtual model routing.
   */
  checkVirtualTarget(adapterId, model, scope) {
    if (!scope) return { ok: true };
    if (scope.error || scope.invalid) {
      return { ok: false, reason: `the scope of this key is invalid in the config (${scope.error || 'invalid scope'})` };
    }
    const direct = this.checkTarget(adapterId, model, scope);
    if (direct.ok) return direct;
    // When a key's allow-list names only virtual models (e.g. `allow: ["auto/*"]`) AND also
    // defines `deny` or `maxCostBasis` to block specific concrete targets (e.g. `{ allow: ["auto/*"], deny: ["claude-api"] }`),
    // enforce the concrete target against `deny` and `maxCostBasis`.
    if (
      Array.isArray(scope.allow) &&
      scope.allow.length > 0 &&
      ((Array.isArray(scope.deny) && scope.deny.length > 0) || scope.maxCostBasis)
    ) {
      const vmNames = [
        ...Object.keys(this.cfg?.virtualModels || {}),
        ...(this.virtualModels ? this.virtualModels.keys() : []),
      ];
      const allVirtualOnly =
        vmNames.length > 0 &&
        scope.allow.every((p) => {
          if (!p || p.kind === 'invalid' || p.kind === 'alias') return false;
          const raw = p.text || (p.model ? `${p.adapter}/${p.model}` : p.id || '');
          return vmNames.some((vm) => globCanStartWith(raw, vm.split('/')[0] + '/') || raw === vm);
        });
      if (allVirtualOnly) {
        return this.checkTarget(adapterId, model, { ...scope, allow: null });
      }
    }
    return direct;
  }

  /**
   * Audit metadata for `requested` when a request fails before any leg starts.
   */
  resolveLegMeta(requested) {
    if (!requested || typeof requested !== 'string') return null;
    if (this.isVirtualModel(requested)) {
      return { adapter: 'virtual', kind: 'virtual', account: null, model: requested };
    }
    const aliases = this.cfg?.aliases || {};
    let target = requested;
    if (own(aliases, requested) && Array.isArray(aliases[requested]) && aliases[requested].length) {
      target = String(aliases[requested][0] || '');
    }
    const slash = target.indexOf('/');
    const adapterId = slash < 0 ? target : target.slice(0, slash);
    const modelName = slash < 0 ? '' : target.slice(slash + 1);
    const adapter = this.adapters.get(adapterId);
    if (adapter) return legMetaOf(adapter, modelName || adapter.defaultModel || '');
    if (own(this.cfg?.adapters, adapterId)) {
      const raw = this.cfg.adapters[adapterId];
      if (raw && typeof raw === 'object') {
        const k = kindOf(raw);
        return {
          adapter: adapterId,
          kind: k,
          ...(k === 'http' && raw.baseUrl ? { host: hostOf(raw.baseUrl) } : {}),
          ...(k === 'cli' && raw.parser ? { parser: raw.parser } : {}),
          ...(raw.costBasis ? { costBasis: raw.costBasis } : {}),
          account: credentialAccount(raw),
          model: modelName || raw.defaultModel || '',
        };
      }
    }
    return null;
  }

  /**
   * Alias ids whose legs can never work, read straight off the config.
   *
   * A dead leg is invisible in the two ways that matter. If it names an adapter we do not
   * have, `resolve()` skips it and the route answers from a different provider than the one
   * you meant to be paying for. If it names a model that adapter never heard of, the
   * upstream rejects it after a round trip and failover retries the next leg before anything
   * reaches the client — so all you see is latency. Neither is loud until it is the whole
   * chain and the client gets a 502. Checking the config before any traffic is what makes a
   * typo a one-line warning in `keysmith doctor` instead of a mystery in production.
   *
   * Computed on access rather than cached in the constructor: adapters are added to the map
   * after construction (a CLI whose binary appeared late, a test wiring stubs directly), and
   * a snapshot taken that early would report legs as broken forever. It walks a handful of
   * strings, so recomputing is cheaper than invalidating correctly.
   *
   * A leg naming a model in a *dynamic* catalogue (a CLI with no declared `models`, a
   * provider whose `/models` has not been read yet) can only be checked once that list is
   * known, so it is checked against the adapter's cache when there is one and left alone
   * when there is not — the alternative is spawning every adapter on the way to a listening
   * socket. `keysmith doctor --probe-models` covers what no listing can tell you: an id a
   * catalogue advertises but the upstream refuses to actually run.
   *
   * @returns {Record<string, string[]>} alias id -> one line per unusable leg
   */
  get aliasIssues() {
    return this.aliasIssuesFor(null);
  }

  /**
   * `aliasIssues` as one key sees them: an alias it may not name is left out, and so is a leg
   * outside its scope — that leg is never part of this key's route, broken or not.
   */
  aliasIssuesFor(scope = null) {
    const out = {};
    for (const [alias, targets] of Object.entries(this.cfg.aliases || {})) {
      if (scope && !aliasDecision(scope, alias).ok) continue;
      const problems = [];
      if (!Array.isArray(targets) || targets.length === 0) {
        problems.push('has no targets, so requesting it can only fail');
      } else {
        for (const leg of targets) {
          if (typeof leg !== 'string' || !leg) {
            problems.push(`has an empty leg (${JSON.stringify(leg)})`);
            continue;
          }
          const slash = leg.indexOf('/');
          const adapterId = slash < 0 ? leg : leg.slice(0, slash);
          const model = slash < 0 ? '' : leg.slice(slash + 1);
          if (scope && !this.checkTarget(adapterId, model, scope).ok) continue;
          const adapter = this.adapters.get(adapterId);
          if (!adapter && slash < 0 && own(this.cfg.aliases, leg)) {
            problems.push(`${leg}: aliases cannot nest — name the adapter/model directly`);
            continue;
          }
          if (!adapter) {
            const why = this.loadError(adapterId);
            problems.push(`${leg}: ${why ? `adapter "${adapterId}" is configured but did not load (${why})` : `no adapter named "${adapterId}"`} — that leg 404s on every request`);
            continue;
          }
          if (adapter.disabled) {
            problems.push(`${leg}: adapter "${adapterId}" is disabled`);
            continue;
          }
          if (adapter.explicitOnly) {
            problems.push(`${leg}: ${keptOutOfAliases(adapterId, adapter)} — keysmith skips this leg`);
            continue;
          }
          const known = knownModels(adapter);
          if (model && known && !known.ids.includes(model)) {
            problems.push(`${leg}: "${model}" is not among ${adapterId}'s ${known.from} — it will be sent upstream and rejected`);
          }
        }
      }
      if (problems.length) out[alias] = problems;
    }
    return out;
  }

  /** Why adapter `id` did not load, or undefined — an own entry only, so `constructor` is no adapter. */
  loadError(id) {
    return own(this.loadErrors, id) ? this.loadErrors[id] : undefined;
  }

  _signatureStore(cfg) {
    const url = String(cfg.baseUrl || '')
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    const limits = limitsFrom(cfg.thoughtSignatures);
    let store = this.signatureStores.get(url);
    if (store) store.widen(limits);
    else this.signatureStores.set(url, (store = new ThoughtSignatures(limits)));
    return store;
  }

  get publicAdapters() {
    return [...this.adapters.values()].filter((a) => !a.disabled);
  }

  /**
   * May a key with `scope` reach `adapterId` for `model` (as requested; '' for "the adapter's
   * own model")? `{ ok }`, or `{ ok: false, reason }` naming the adapter — never the key.
   * Unscoped (`scope` null) is always ok: a key with no scope reaches what it always did.
   */
  checkTarget(adapterId, model, scope) {
    if (!scope) return { ok: true };
    const adapter = this.adapters.get(adapterId) ?? (own(this.cfg.adapters, adapterId) ? this.cfg.adapters[adapterId] : null);
    return requestDecision(scope, adapterId, adapter, model);
  }

  /** May a key with `scope` name `requested` at all — an alias/virtual model it may use, or a target it may reach? */
  mayName(requested, scope) {
    if (!scope) return true;
    if (typeof requested !== 'string' || !requested) return false;
    if (this.isVirtualModel(requested)) {
      if (!virtualDecision(scope, requested).ok) return false;
      const vspec = this.getVirtualSpec(requested);
      if (!vspec) return false;
      return Object.values(vspec.tierLegs || {}).some((legs) =>
        Array.isArray(legs) && legs.some((leg) => this.checkVirtualTarget(leg.adapterId, leg.model, scope).ok),
      );
    }
    if (own(this.cfg.aliases, requested)) {
      // An alias it may name, with a leg it may run: what /v1/models lists for it.
      const legs = this.cfg.aliases[requested];
      return aliasDecision(scope, requested).ok && Array.isArray(legs) && legs.some((leg) => typeof leg === 'string' && leg && this.checkTarget(adapterOf(leg), modelOf(leg), scope).ok);
    }
    return this.checkTarget(adapterOf(requested), modelOf(requested), scope).ok;
  }

  /** Can a key with `scope` reach any part of adapter `id`? (Listings: models, routes, the status page.) */
  adapterVisible(id, scope) {
    return !scope || adapterReach(scope, id) !== 'none';
  }

  /**
   * The aliases one key may name, each with only the legs it may run: `cfg.aliases` itself
   * for an unscoped key.
   */
  aliasesFor(scope = null) {
    const aliases = this.cfg.aliases || {};
    if (!scope) return aliases;
    const out = {};
    for (const [alias, legs] of Object.entries(aliases)) {
      if (!aliasDecision(scope, alias).ok) continue;
      const usable = (Array.isArray(legs) ? legs : []).filter((leg) => typeof leg === 'string' && leg && this.checkTarget(adapterOf(leg), modelOf(leg), scope).ok);
      if (usable.length) out[alias] = usable;
    }
    return out;
  }

  /**
   * The virtual models one key may name, each with only the tier candidates it may reach.
   */
  virtualModelsFor(scope = null) {
    const out = {};
    const names = new Set([
      ...(this.virtualModels ? this.virtualModels.keys() : []),
      ...Object.keys(this.cfg?.virtualModels || {}),
    ]);
    for (const name of names) {
      if (scope && !virtualDecision(scope, name).ok) continue;
      const vspec = this.getVirtualSpec(name);
      if (!vspec) continue;
      if (!scope) {
        out[name] = {
          classifier: vspec.classifier,
          tiers: vspec.tiers,
          ...(vspec.loadGate ? { loadGate: vspec.loadGate } : {}),
          ...(vspec.stickySeconds != null ? { stickySeconds: vspec.stickySeconds } : {}),
          ...(vspec.note ? { note: vspec.note } : {}),
        };
        continue;
      }
      const scopedTiers = {};
      let anyUsable = false;
      for (const [tier, legs] of Object.entries(vspec.tierLegs || {})) {
        const usable = (legs || [])
          .filter((leg) => this.checkVirtualTarget(leg.adapterId, leg.model, scope).ok)
          .map((leg) => leg.target);
        if (usable.length) {
          scopedTiers[tier] = usable;
          anyUsable = true;
        }
      }
      if (anyUsable) {
        out[name] = {
          classifier: vspec.classifier,
          tiers: scopedTiers,
          ...(vspec.loadGate ? { loadGate: vspec.loadGate } : {}),
          ...(vspec.stickySeconds != null ? { stickySeconds: vspec.stickySeconds } : {}),
          ...(vspec.note ? { note: vspec.note } : {}),
        };
      }
    }
    return out;
  }

  get virtualModelIssues() {
    return this.virtualModelIssuesFor(null);
  }

  virtualModelIssuesFor(scope = null) {
    const out = {};
    const names = new Set([
      ...(this.virtualModels ? this.virtualModels.keys() : []),
      ...Object.keys(this.cfg?.virtualModels || {}),
    ]);
    for (const name of names) {
      if (scope && !virtualDecision(scope, name).ok) continue;
      const vspec = this.getVirtualSpec(name);
      if (!vspec) continue;
      const problems = [];
      const checkLeg = (label, leg) => {
        const adapter = this.adapters.get(leg.adapterId);
        if (!adapter) {
          const why = this.loadError(leg.adapterId);
          problems.push(
            `${label} (${leg.target}): ${why ? `adapter "${leg.adapterId}" is configured but did not load (${why})` : `no adapter named "${leg.adapterId}"`}`,
          );
          return;
        }
        if (adapter.disabled) {
          problems.push(`${label} (${leg.target}): adapter "${leg.adapterId}" is disabled`);
          return;
        }
        const known = knownModels(adapter);
        if (leg.model && known && !known.ids.includes(leg.model)) {
          problems.push(`${label} (${leg.target}): "${leg.model}" is not among ${leg.adapterId}'s ${known.from}`);
        }
      };
      checkLeg('classifier', vspec.classifierLeg);
      for (const [tier, legs] of Object.entries(vspec.tierLegs || {})) {
        for (const leg of legs || []) {
          if (scope && !this.checkVirtualTarget(leg.adapterId, leg.model, scope).ok) continue;
          checkLeg(`tiers.${tier}`, leg);
        }
      }
      if (problems.length) out[name] = problems;
    }
    return out;
  }

  /**
   * The catalogue, or one key's share of it: with a `scope`, an adapter the key cannot reach is
   * not even asked for its list, a model outside the scope is left out, and an alias is listed
   * with the legs the key may run (and not at all when it may run none).
   *
   * @returns {Promise<{models: Array<object>, errors: Array<string>}>}
   */
  async listModels({ refresh = false, scope = null } = {}) {
    const models = [];
    const errors = [];
    for (const [id, msg] of Object.entries(this.loadErrors)) if (this.adapterVisible(id, scope)) errors.push(`${id}: configured but did not load — ${msg}`);
    await Promise.all(
      this.publicAdapters.filter((a) => this.adapterVisible(a.id, scope)).map(async (a) => {
        if (refresh) a._modelCache = null;
        if (a.kind === 'cli' && a._isOpencode && !a._versionProbed) {
          a._versionProbed = true;
          const ver = await a.checkVersion?.();
          if (ver?.warning && !a._versionWarned) {
            a._versionWarned = true;
            this.log(`adapter "${a.id}": ${ver.warning}`);
          }
        }
        try {
          const list = await a.models();
          const entry = (id, m, extra = {}) => ({
            id: `${a.id}/${id}`,
            object: 'model',
            owned_by: `keysmith:${a.id}`,
            keysmith: {
              adapter: a.id,
              kind: a.kind,
              upstream: m.id,
              name: m.name || null,
              contextWindow: m.contextWindow || m.context_window || null,
              maxOutput: m.maxOutput || null,
              priority: a.priority,
              note: m.note || null,
              ...(m.efforts && a.takesEffort ? { efforts: m.efforts } : {}),
              ...extra,
            },
          });
          for (const m of list) {
            if (!m?.id) continue;
            const baseOk = !scope || this.checkTarget(a.id, m.id, scope).ok;
            if (baseOk) models.push(entry(m.id, m));
            // A client that cannot send an effort (OpenBot) names one in the model id: one id per
            // level the catalogue lists for the model, on a CLI whose argv takes an effort. A scope
            // decides both the base model and the suffixed id as written.
            if (!a.takesEffort || !baseOk) continue;
            for (const { id, level } of suffixedIds(list, m)) {
              if (scope && !this.checkTarget(a.id, id, scope).ok) continue;
              models.push(entry(id, m, { effort: level, name: m.name ? `${m.name} (effort ${level})` : null }));
            }
          }
        } catch (e) {
          errors.push(redactSecrets(`${a.id}: ${e.message}`));
        }
      }),
    );
    const issues = this.aliasIssuesFor(scope);
    for (const [alias, targets] of Object.entries(this.aliasesFor(scope))) {
      models.push({
        id: alias,
        object: 'model',
        owned_by: 'keysmith:alias',
        keysmith: { adapter: 'alias', kind: 'alias', routes: targets, priority: -1, ...(issues[alias] ? { warnings: issues[alias] } : {}) },
      });
    }
    // After the fetches above: `knownModels` can only check a dynamic catalogue once the
    // adapter has actually read one, so an alias leg pointing at a wrong evren/CLI model
    // becomes knowable right here — report it in the same call that learned it.
    for (const [alias, problems] of Object.entries(issues)) {
      for (const p of problems) errors.push(`alias "${alias}" ${p}`);
    }
    const vmIssues = this.virtualModelIssuesFor(scope);
    for (const [vmName, vspec] of Object.entries(this.virtualModelsFor(scope))) {
      models.push({
        id: vmName,
        object: 'model',
        owned_by: 'keysmith:virtual',
        keysmith: {
          adapter: 'virtual',
          kind: 'virtual',
          classifier: vspec.classifier,
          tiers: vspec.tiers,
          ...(vspec.loadGate ? { loadGate: vspec.loadGate } : {}),
          ...(vspec.stickySeconds != null ? { stickySeconds: vspec.stickySeconds } : {}),
          priority: -2,
          ...(vspec.note ? { note: vspec.note } : {}),
          ...(vmIssues[vmName] ? { warnings: vmIssues[vmName] } : {}),
        },
      });
    }
    for (const [vmName, problems] of Object.entries(vmIssues)) {
      for (const p of problems) errors.push(`virtual model "${vmName}" ${p}`);
    }
    models.sort((x, y) => x.id.localeCompare(y.id));
    return { models, errors };
  }

  /** Sessions live in memory only: restart the gateway and clients start fresh. */
  _remember(publicId, rec) {
    this.sessions.set(publicId, rec);
    while (this.sessions.size > 1000) this.sessions.delete(this.sessions.keys().next().value);
  }

  /**
   * Resolve a requested model id into the ordered candidate list to try.
   *
   * A bare model id that names no adapter is a straight error — you asked for a specific
   * thing and we do not have it. Inside an alias it is a dead leg: the chain exists to be
   * robust, so an unusable leg is skipped and reported rather than poisoning the route.
   * `aliasIssues` (doctor, /status, /v1/models, the routes endpoint) is where the skip
   * becomes loud, so skipping never hides a misconfiguration — it only keeps answering.
   *
   * `exclude` takes out legs (by `adapter/model` target) that already answered this request:
   * the tool relay's refusals, which a plain completion must not ask a second time.
   *
   * `scope` is the requesting key's (keys.js): a target outside it is a 403 that names the
   * adapter; inside an alias such a leg is skipped — never run — and the alias is a 403 only
   * when no leg is left. The legs skipped that way ride on the result as `skipped`.
   */
  resolve(requested, { exclude = null, scope = null, label = null, congested = null } = {}) {
    if (!requested) throw new LlmError('missing "model"', { status: 400 });
    if (typeof requested !== 'string') throw new LlmError('"model" must be a string', { status: 400 });
    if (this.isVirtualModel(requested)) {
      if (scope) {
        const d = virtualDecision(scope, requested);
        if (!d.ok) throw scopeError(d.reason, null);
      }
      const vspec = this.getVirtualSpec(requested);
      const candidates = buildVirtualCandidateList(vspec, {
        label: label || 'simple',
        congested: !!congested,
        adapters: this.adapters,
        cfgAdapters: this.cfg?.adapters,
      });
      const out = [];
      const skipped = [];
      let excluded = 0;
      let firstError = null;
      for (const cand of candidates) {
        const { adapterId, model: modelName, target, tier, local } = cand;
        if (scope) {
          const d = this.checkVirtualTarget(adapterId, modelName, scope);
          if (!d.ok) {
            skipped.push(target);
            this.log(`virtual model "${requested}" skipped ${target}: outside the requesting key's scope`);
            continue;
          }
        }
        const adapter = this.adapters.get(adapterId);
        let err = null;
        if (!adapter) {
          const why = this.loadError(adapterId);
          const live = [...this.adapters.keys()].filter((id) => this.adapterVisible(id, scope));
          err = new LlmError(
            why
              ? `adapter "${adapterId}" is configured but did not load: ${why}`
              : `no adapter named "${adapterId}" — try one of: ${live.join(', ')}`,
            { status: why ? 503 : 404, provider: why ? adapterId : null },
          );
        } else if (adapter.disabled) {
          err = new LlmError(`adapter "${adapterId}" is disabled`, { status: 503, provider: adapterId });
        } else if (adapter.explicitOnly) {
          err = new LlmError(`virtual model "${requested}": ${keptOutOfAliases(adapterId, adapter)}`, { status: 403, provider: null });
        }
        if (err) {
          firstError ??= err;
          if (candidates.length > 1) {
            this.log(`virtual model "${requested}" skipped a dead leg: ${err.message}`);
            continue;
          }
          throw err;
        }
        if (exclude?.has(target)) {
          excluded++;
          continue;
        }
        out.push({ adapter, model: modelName || adapter.defaultModel || '', target, tier, local });
      }
      if (!out.length) {
        if (skipped.length && !excluded) {
          throw scopeError(
            `virtual model "${requested}" has no candidate this key may use: ${skipped.join(', ')} ${skipped.length > 1 ? 'are' : 'is'} outside its scope`,
            adapterOf(skipped[0]),
          );
        }
        throw firstError || new LlmError(`every candidate of "${requested}" has already refused this request`, { status: 502 });
      }
      out.skipped = skipped;
      out.virtual = true;
      return out;
    }
    const aliases = this.cfg.aliases || {};
    // Own names only: a model called `constructor` or `toString` is not an alias, and an
    // alias that is not a list of legs is an alias with no legs.
    const isAlias = own(aliases, requested);
    if (isAlias && scope) {
      const d = aliasDecision(scope, requested);
      if (!d.ok) throw scopeError(d.reason, null);
    }
    const chain = isAlias ? (Array.isArray(aliases[requested]) ? [...aliases[requested]] : []) : [requested];
    if (isAlias && !chain.length) throw new LlmError(`alias "${requested}" has no legs`, { status: 503 });
    const out = [];
    const skipped = [];
    let excluded = 0;
    let firstError = null;
    for (const entry of chain) {
      if (typeof entry !== 'string' || !entry) {
        // A hand-edited leg that is not `adapter/model` at all; aliasIssues names it.
        firstError ??= new LlmError(`alias "${requested}" has an empty leg (${JSON.stringify(entry)})`, { status: 503 });
        continue;
      }
      const slash = entry.indexOf('/');
      const adapterId = slash < 0 ? entry : entry.slice(0, slash);
      const modelName = slash < 0 ? '' : entry.slice(slash + 1);
      // The key's scope comes before anything about the adapter: a key that may not reach it
      // learns nothing about it — not whether it exists, loaded or is switched off.
      if (scope) {
        const d = this.checkTarget(adapterId, modelName, scope);
        if (!d.ok) {
          if (!isAlias) throw scopeError(d.reason, adapterId);
          skipped.push(entry);
          this.log(`alias "${requested}" skipped ${entry}: outside the requesting key's scope`);
          continue;
        }
      }
      const adapter = this.adapters.get(adapterId);
      let err = null;
      if (!adapter) {
        const why = this.loadError(adapterId);
        const live = [...this.adapters.keys()].filter((id) => this.adapterVisible(id, scope));
        err = new LlmError(why ? `adapter "${adapterId}" is configured but did not load: ${why}` : `no adapter named "${adapterId}" — try one of: ${live.join(', ')}`, { status: why ? 503 : 404, provider: why ? adapterId : null });
      } else if (adapter.disabled) {
        err = new LlmError(`adapter "${adapterId}" is disabled`, { status: 503, provider: adapterId });
      } else if (isAlias && adapter.explicitOnly) {
        // An alias is a route the gateway picks legs from on its own; this adapter is only
        // ever run by a request that names it. A hand-edited leg is a dead leg, not a route.
        err = new LlmError(`alias "${requested}": ${keptOutOfAliases(adapterId, adapter)}`, { status: 403, provider: null });
      }
      if (err) {
        firstError ??= err;
        if (isAlias && chain.length > 1) {
          this.log(`alias "${requested}" skipped a dead leg: ${err.message}`);
          continue;
        }
        throw err;
      }
      if (exclude?.has(entry)) {
        excluded++;
        continue;
      }
      out.push({ adapter, model: modelName || adapter.defaultModel || '', target: entry });
    }
    if (!out.length) {
      if (skipped.length && !excluded) {
        throw scopeError(`alias "${requested}" has no leg this key may use: ${skipped.join(', ')} ${skipped.length > 1 ? 'are' : 'is'} outside its scope`, adapterOf(skipped[0]));
      }
      throw firstError || new LlmError(`every leg of "${requested}" has already refused this request`, { status: 502 });
    }
    // Declared order wins in an alias: you wrote the chain, you know which leg should
    // be tried first. `priority` only orders the flat model listing.
    out.skipped = skipped;
    return out;
  }

  /**
   * Perform the virtual model routing decision for a single request (`loadGate` -> `classifier` -> tier candidates).
   */
  async routeVirtual(requested, { messages = [], prompt = '', session = null, exclude = null, scope = null, signal = null } = {}) {
    if (!this.isVirtualModel(requested)) {
      throw new LlmError(`unknown virtual model "${requested}"`, { status: 404 });
    }
    if (scope) {
      const d = virtualDecision(scope, requested);
      if (!d.ok) throw scopeError(d.reason, null);
    }
    const vspec = this.getVirtualSpec(requested);
    const gate = evaluateLoadGate(vspec.loadGate, this.loadProbe);
    const promptText = extractClassifierPrompt(messages, prompt);

    let label = 'medium';
    let baseReason = 'classified';
    let clf = null;

    if (gate.congested) {
      label = vspec.tierLegs.congested ? 'congested' : 'medium';
      baseReason = `congested (${gate.detail})`;
    } else {
      const classifierAllowed = !scope || this.checkVirtualTarget(vspec.classifierLeg.adapterId, vspec.classifierLeg.model, scope).ok;
      const clfAdapter = classifierAllowed ? this.adapters.get(vspec.classifierLeg.adapterId) || null : null;
      // A classifier under the Kiro credit guard is asked only while its plan is under the
      // threshold, like any leg: held back, the request is labelled medium unasked.
      let unavailable = null;
      if (clfAdapter?.creditGuard && this.creditGuard) {
        try {
          const v = await this.creditGuard.check(clfAdapter);
          if (!v.ok) unavailable = `classifier adapter "${clfAdapter.id}" is held back by the kiro credit guard — ${v.detail}`;
        } catch {}
      }
      clf = await classifyPrompt({
        vspec,
        adapter: clfAdapter,
        promptText,
        session,
        cache: this._virtualCache,
        now: this.now,
        signal,
        unavailable,
      });
      label = clf.label;
      baseReason =
        !classifierAllowed
          ? 'classifier_scope_denied (defaulted to medium)'
          : clf.reason === 'classified' || clf.reason === 'sticky' || clf.reason === 'cached'
          ? clf.reason
          : `${clf.reason} (defaulted to medium)`;
    }

    const chain = this.resolve(requested, {
      exclude,
      scope,
      label: gate.congested ? 'medium' : label,
      congested: gate.congested,
    });

    return {
      vspec,
      chain,
      gate,
      label,
      tier: chain[0]?.tier || label,
      baseReason,
      clf,
      skipped: chain.skipped || [],
      promptText,
    };
  }

  /**
   * Dry-run a virtual model routing decision (`keysmith route explain <virtualModel> "<prompt>"`)
   * without calling the target adapter/model.
   */
  async explainRoute(requested, prompt = '', { messages = null, scope = null, session = null, signal = null } = {}) {
    const t0 = Date.now();
    const msgs = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: String(prompt || '') }];
    const routed = await this.routeVirtual(requested, {
      messages: msgs,
      prompt: typeof prompt === 'string' ? prompt : '',
      session,
      scope,
      signal,
    });
    const latency = Math.max(0, Date.now() - t0);
    const first = routed.chain[0] || null;
    const fallbacks = routed.chain.slice(1).map((c) => c.target);
    return {
      virtual: requested,
      prompt: routed.promptText,
      classifier: routed.vspec.classifier,
      congested: routed.gate.congested,
      loadGate: routed.vspec.loadGate,
      load: routed.gate,
      label: routed.label,
      tier: first?.tier || routed.tier,
      reason: routed.baseReason,
      classifyError: routed.clf?.error || null,
      classifyMs: routed.clf?.classifyMs ?? 0,
      cached: !!routed.clf?.cached,
      chosen: first?.target || null,
      adapter: first?.adapter?.id || null,
      model: first?.model || null,
      candidates: routed.chain.map((c) => c.target),
      fallbacks,
      fallbacksTried: [],
      skipped: routed.skipped,
      latency,
      dryRun: true,
    };
  }

  /**
   * Stream one completion. Fails over to the next candidate in the chain only while
   * nothing has reached the client yet — a half-delivered answer is never restarted.
   *
   * Sessions: an OpenAI client is stateless, but a CLI has a real conversation on
   * disk. `x-keysmith-session` carries an opaque keysmith id that we map onto the
   * upstream session, so a chat app gets genuine multi-turn (and prompt-cache)
   * behaviour out of a tool that was never meant to answer HTTP.
   */
  async *complete({
    model,
    messages,
    session,
    signal,
    maxTokens,
    maxCompletionTokens,
    maxOutputTokens,
    temperature,
    includeReasoning = false,
    exclude = null,
    scope = null,
    caller = null,
    tools = null,
    effort = null,
    harnessId = null,
    trace = null,
    holdSpend = null,
    onVirtual = null,
    onSkip = null,
  }) {
    const t0 = Date.now();
    const callerKey = caller || tools?.caller || (scope ? (scope._fp || JSON.stringify(scopeText(scope))) : '');
    const publicId = session || newSessionId();
    const sessionKey = `${callerKey}:${publicId}`;
    const known = session ? this.sessions.get(sessionKey) : null;
    const isVirtual = this.isVirtualModel(model);

    let chain;
    let virtualState = null;
    if (isVirtual) {
      const routed = await this.routeVirtual(model, {
        messages,
        session: session ? sessionKey : null,
        exclude,
        scope,
        signal,
      });
      chain = routed.chain;
      const first = chain[0] || null;
      virtualState = {
        virtual: model,
        label: routed.label,
        tier: first?.tier || routed.tier,
        chosen: first?.target || null,
        chosenAdapter: first?.adapter?.id || null,
        chosenModel: first?.model || null,
        fallbacks: [],
        fallbacksTried: [],
        fallbackDetails: [],
        skipped: routed.skipped || [],
        baseReason: routed.baseReason,
        reason: routed.baseReason,
        classifyMs: routed.clf?.classifyMs ?? 0,
        congested: routed.gate.congested,
        t0,
        latency: Math.max(0, Date.now() - t0),
        status: 'ok',
        error: null,
      };
      onVirtual?.(snapshotVirtual(virtualState));
      yield { type: 'virtual', virtual: snapshotVirtual(virtualState) };
    } else {
      chain = this.resolve(model, { exclude, scope });
    }

    const localHeld = [];
    const hold = typeof holdSpend === 'function' ? holdSpend : (fn) => { if (typeof fn === 'function') localHeld.push(fn); };
    const run = {
      publicId,
      sessionKey,
      known,
      reportedSession: false,
      includeReasoning,
      signal,
      scope,
      holdSpend: hold,
      virtualState,
      onVirtual,
      // The legs passed by without being asked (`{ target, reason, detail }`: one that cannot
      // carry the request's tools, one the credit guard holds back), for the usage row.
      skips: [],
      onSkip,
    };
    const args = { messages, maxTokens, maxCompletionTokens, maxOutputTokens, temperature, includeReasoning, signal, effort, harnessId, trace };
    try {
      if (tools) return yield* this._toolRoute(model, chain, args, run, tools);
      yield* this._failover(chain, args, run, null);
    } catch (err) {
      if (run.skips.length && err && typeof err === 'object' && !err.skippedLegs) err.skippedLegs = run.skips.map((x) => ({ ...x }));
      if (virtualState) {
        virtualState.latency = Math.max(0, Date.now() - t0);
        virtualState.status = err?.scopeDenied ? 'denied' : 'error';
        virtualState.error = err?.message || String(err);
        if (!virtualState.fallbacks.length && chain.length) {
          // Record tried candidates if all failed
        }
        const snap = snapshotVirtual(virtualState);
        onVirtual?.(snap);
        if (err && typeof err === 'object') err.virtualRoute = snap;
      }
      throw err;
    } finally {
      for (const fn of localHeld.splice(0)) {
        try { fn(); } catch {}
      }
      if (virtualState && !onVirtual && this.usage) {
        virtualState.latency = Math.max(0, Date.now() - t0);
        const snap = snapshotVirtual(virtualState);
        try {
          this.usage.record({
            ts: new Date(this.now()).toISOString(),
            model,
            virtual: snap.virtual,
            label: snap.label,
            tier: snap.tier,
            chosen: snap.chosen,
            target: snap.chosen,
            adapter: snap.chosenAdapter,
            resolvedModel: snap.chosenModel,
            fallbacks: snap.fallbacks,
            fallbacksTried: snap.fallbacksTried,
            ...(snap.skipped?.length ? { skipped: snap.skipped } : {}),
            reason: snap.reason,
            classifyMs: snap.classifyMs,
            ms: snap.latency,
            latency: snap.latency,
            status: snap.status,
            ...(snap.error ? { error: snap.error } : {}),
          });
        } catch {}
      }
    }
  }

  /**
   * The legs of `chain` in order as plain completions, each tried only while nothing of an answer
   * reached the client. `carried` is a failure from before (the tool walk's), kept by the rule
   * routeError() states: a 429/503 is the answer over a later leg's other refusal.
   */
  async *_failover(chain, args, run, carried) {
    let lastError = carried;
    let heldBack = null; // a leg the credit guard passed by: the answer only when no other leg had one
    for (const leg of chain) {
      const { adapter, model: upstreamModel } = leg;
      const held = await this._heldBack(leg, run);
      if (held) {
        heldBack ||= held;
        continue;
      }
      const canResume = !!run.known && run.known.upstreamSession && adapterOf(run.known.target) === adapter.id && !!adapter.resumable;
      // Outside the try: a leg that throws after part of its answer went out (text, or a tool
      // call the client may already be running) is not restarted on the next leg either.
      const state = { emitted: false };
      let releaseSpend = () => {};
      try {
        // The leg's model and effort: an effort-suffixed id read off, a level checked against the
        // CLI's catalogue (src/effort.js) — a 400 there is this leg refusing, like any other.
        const planned = await effortPlan(leg, args.effort);
        if (run.scope && planned.model !== leg.model) {
          const d = run.virtualState
            ? this.checkVirtualTarget(adapter.id, planned.model, run.scope)
            : this.checkTarget(adapter.id, planned.model, run.scope);
          if (!d.ok) throw scopeError(d.reason, adapter.id);
        }
        const legEffort = planned.effort || (adapter.wire === 'uhp' || adapter.wire === 'traycer' ? args.effort : null);
        releaseSpend = this.reserveSpend(adapter, planned.model, run.scope, this.estimateTokens(adapter, planned.model, args, null));
        run.holdSpend(releaseSpend);
        const events = adapter.complete({
          model: planned.model,
          messages: args.messages,
          session: canResume ? run.known.upstreamSession : null,
          sessionKey: adapter.resumable ? run.publicId : null,
          signal: args.signal,
          maxTokens: adapter.kind === 'cli' ? (args.maxTokens || args.maxCompletionTokens || args.maxOutputTokens) : args.maxTokens,
          maxCompletionTokens: args.maxCompletionTokens,
          maxOutputTokens: args.maxOutputTokens,
          temperature: args.temperature,
          includeReasoning: args.includeReasoning,
          ...(legEffort ? { effort: legEffort } : {}),
          ...(args.harnessId ? { harnessId: args.harnessId } : {}),
          ...(args.trace ? { trace: args.trace } : {}),
        });
        yield* this._leg({ ...leg, model: planned.model }, withEffort(events, planned), run, state, { canResume, sessions: true });
        return;
      } catch (e) {
        releaseSpend();
        if (e?.scopeDenied) {
          if (chain.length === 1) throw e;
          lastError = lastError || e;
          continue;
        }
        if (e?.clientError) {
          e.leg = e.leg || legMetaOf(adapter, upstreamModel);
          throw e;
        }
        const err = this._legFailed(leg, e, state, args.signal, chain.length > 1 ? 'trying next candidate' : 'giving up');
        if (run.virtualState) {
          recordVirtualFallback(run.virtualState, leg, err);
          run.onVirtual?.(snapshotVirtual(run.virtualState));
          if (!isFallthroughError(err)) throw err;
        }
        if (chain.length === 1) throw lastError ? routeError(lastError, err) : err;
        lastError = routeError(lastError, err);
      }
    }
    if (run.virtualState) {
      run.virtualState.chosen = null;
      run.virtualState.chosenAdapter = null;
      run.virtualState.chosenModel = null;
      run.onVirtual?.(snapshotVirtual(run.virtualState));
    }
    throw lastError || heldBack || new LlmError('no candidate in this route succeeded', { status: 502 });
  }

  /**
   * The 400 a tool request gets when no leg of its route can carry the tools (gateway._toolWalk):
   * each leg named, with why — never a plain-text answer in its place.
   */
  _noToolLeg(requested, chain, run) {
    const skips = run.skips.filter((x) => x.reason !== 'credit_guard');
    const direct = chain.length === 1 && chain[0].target === requested;
    const why = skips.map((x) => `${x.target}: ${x.detail || x.reason}`).join('; ') || 'no leg takes tools';
    const msg = direct
      ? `${requested} cannot carry this request's tools — ${skips[0]?.detail || 'it has no way to take them'}. A text answer would drop the tools without a word, so the request fails instead`
      : `no leg of "${requested}" can carry this request's tools — ${why}. A text answer would drop the tools without a word, so the request fails instead: give the route a leg that takes tools (a CLI with a toolMode: keysmith tools <adapter> auto; on /v1/chat/completions, an HTTP upstream on the openai wire)`;
    const err = new LlmError(msg, { status: 400, type: 'invalid_request_error', provider: direct ? chain[0].adapter.id : null });
    err.toolsNotCarried = true;
    return err;
  }

  /**
   * `err`, the error that ends a tool route, with the legs passed by because they cannot carry the
   * tools named in its message (once): a client reading it knows why the route did not go on.
   */
  _toolsNotCarried(err, run) {
    if (!err || typeof err !== 'object' || err.toolsNotCarried || err.toolSkipsNamed) return err;
    const skips = run.skips.filter((x) => x.reason !== 'credit_guard');
    if (!skips.length) return err;
    err.message = `${err.message} — not asked, as they cannot carry this request's tools: ${skips.map((x) => `${x.target} (${truncate(x.detail || x.reason, 120)})`).join('; ')}`;
    err.toolSkipsNamed = true;
    return err;
  }

  /**
   * A leg passed by without being asked: kept on the request (`run.skips`, once per leg and
   * reason) for its usage row's `skippedLegs`, and logged.
   */
  _skipLeg(run, leg, reason, detail, extra = {}) {
    const target = leg.target || `${leg.adapter?.id || ''}/${leg.model || ''}`;
    if (!run.skips.some((x) => x.target === target && x.reason === reason)) {
      const entry = { target, reason, ...(detail ? { detail: truncate(detail, 240) } : {}), ...extra };
      run.skips.push(entry);
      try {
        run.onSkip?.({ ...entry });
      } catch {}
    }
    this.log(`${target} passed by (${reason}): ${truncate(detail || reason, 240)}`);
  }

  /**
   * The credit guard's word on a leg (src/credit-guard.js): null when it may be asked, else the
   * 429 a request that names it alone gets — the leg is passed by, the reason recorded.
   */
  async _heldBack(leg, run) {
    if (!leg?.adapter?.creditGuard || !this.creditGuard) return null;
    let verdict;
    try {
      verdict = await this.creditGuard.check(leg.adapter);
    } catch (e) {
      this.log(`kiro credit guard: ${leg.adapter.id}: ${truncate(e?.message || e, 160)} — not held back`);
      return null;
    }
    if (verdict.ok) return null;
    const err = creditGuardError(leg.adapter, verdict, this.now());
    err.leg = legMetaOf(leg.adapter, leg.model);
    this._skipLeg(run, leg, 'credit_guard', verdict.detail, { ratio: Math.round(verdict.ratio * 1000) / 1000, threshold: verdict.threshold });
    if (run.virtualState) {
      recordVirtualFallback(run.virtualState, leg, err);
      run.onVirtual?.(snapshotVirtual(run.virtualState));
    }
    return err;
  }

  /**
   * One leg's events on their way to a face. Throws when the leg fails before any text or call of
   * its answer went out (`state.emitted` says whether one did). `sessions`: a tool leg resumes no
   * CLI session and maps none.
   */
  async *_leg({ adapter, model: upstreamModel, target, tier }, events, run, state, { canResume = false, sessions = true } = {}) {
    // Which effort the leg ran at is said once its answer is: a leg that fails before answering
    // takes its `effort` event with it.
    let effort = null;
    if (run.virtualState) {
      run.virtualState.chosen = target || `${adapter.id}/${upstreamModel}`;
      run.virtualState.chosenAdapter = adapter.id;
      run.virtualState.chosenModel = upstreamModel;
      if (tier) run.virtualState.tier = tier;
      run.virtualState.latency = Math.max(0, Date.now() - run.virtualState.t0);
      const snap = snapshotVirtual(run.virtualState);
      run.onVirtual?.(snap);
      yield { type: 'virtual', virtual: snap };
    }
    yield { type: 'leg', leg: legMetaOf(adapter, upstreamModel) };
    for await (const evt of events) {
      if (evt.type === 'effort') {
        effort = evt;
        continue;
      }
      if (effort && (evt.type === 'delta' || evt.type === 'tool_call' || evt.type === 'done')) {
        yield effort;
        effort = null;
      }
      if (evt.type === 'done') {
        if (run.virtualState) {
          run.virtualState.latency = Math.max(0, Date.now() - run.virtualState.t0);
          const snap = snapshotVirtual(run.virtualState);
          run.onVirtual?.(snap);
          yield { type: 'virtual', virtual: snap };
        }
        yield { type: 'leg', leg: legMetaOf(adapter, upstreamModel) };
      }
      // One rule for both adapter kinds: chain-of-thought is only ever forwarded to
      // a client that asked for it. Providers and CLIs emit it freely; a UI that
      // shows it unasked is a surprise, and it costs output tokens.
      if (evt.type === 'reasoning' && !run.includeReasoning) continue;
      if (evt.type === 'retry') {
        // The adapter is already trying again on its own; say so, never silently.
        this.log(`${adapter.id}/${truncate(upstreamModel, 60)} retried after ${evt.reason}: ${truncate(evt.message, 160)}`);
        yield evt;
        continue;
      }
      if (evt.type === 'cut') {
        // Same rule for an answer the adapter ended early: it is in the log and the
        // usage log, so a harness that keeps calling tools is a number, not a mystery.
        this.log(`${adapter.id}/${truncate(upstreamModel, 60)} answer ended at a call to ${truncate(evt.tool, 60)}: the process was stopped`);
        yield evt;
        continue;
      }
      // A tool call handed to the client is an answer as much as text is: from here on this
      // leg is the one answering, and a failure is reported, never retried on the next leg.
      if (evt.type === 'delta' || evt.type === 'tool_call') state.emitted = true;
      if (evt.type === 'error') {
        // Every streamed face writes this message to its client (an error chunk, an `error`
        // event, response.failed), so it is redacted here: an adapter that let a provider's
        // quoted key through is not the last line of defence. collect() keeps what came
        // before it — a non-streamed answer is the text or calls, as it always was.
        const message = redactSecrets(evt.message);
        if (state.emitted) {
          yield { ...evt, message };
          return;
        }
        throw new LlmError(message, { status: evt.status || 502, provider: adapter.id });
      }
      if (evt.type === 'session') {
        if (!sessions) continue;
        if (evt.id) {
          this._remember(run.sessionKey || run.publicId, { target: `${adapter.id}/${upstreamModel}`, upstreamSession: evt.id });
          if (!run.reportedSession) {
            run.reportedSession = true;
            yield { type: 'session', id: run.publicId, resumed: canResume };
          }
          continue;
        }
      }
      yield evt;
    }
    if (effort) yield effort;
    if (sessions && !run.reportedSession && run.known) {
      run.reportedSession = true;
      yield { type: 'session', id: run.publicId, resumed: true };
    }
  }

  /** A leg's failure as the LlmError the route keeps, logged; rethrown when it must end the route. */
  _legFailed({ adapter, model: upstreamModel }, e, state, signal, next) {
    // Wrapped, a failure keeps what a tool engine marked it with: which engine, and what it spent.
    // The status of an untyped failure: its own when it carries one, 504 only for a failure that
    // is typed as a timeout (`ETIMEDOUT`, a `TimeoutError`), 502 for any other upstream error.
    // Never 504 off the word "timeout" in a message: the bridge's `ready_timeout` (a CLI that did
    // not list its tools in time) is an upstream error the bridge itself reports as a 502.
    const inferredStatus =
      typeof e?.status === 'number' && e.status >= 400
        ? e.status
        : isTimeoutError(e)
          ? 504
          : /\b429\b|rate[_\s-]?limit|quota|too many requests/i.test(e?.message || '')
            ? 429
            : 502;
    const err = e instanceof LlmError ? e : Object.assign(new LlmError(e.message, { status: inferredStatus, provider: adapter.id }), engineMarks(e));
    err.leg = e?.leg || legMetaOf(adapter, upstreamModel);
    if (e?.upstreamId && !err.upstreamId) err.upstreamId = e.upstreamId;
    if (signal?.aborted) throw err;
    if (state.emitted) {
      this.log(`${adapter.id}/${truncate(upstreamModel, 60)} failed after it had started answering, so no other leg is tried: ${truncate(e.message, 160)}`);
      throw err;
    }
    this.log(`${adapter.id}/${truncate(upstreamModel, 60)} failed, ${next}: ${truncate(e.message, 160)}`);
    return err;
  }

  /**
   * A request that offers tools (src/tools/router.js): the route's legs in declared order, each
   * taking the tools the way it can — an HTTP upstream on the face's own wire verbatim through
   * `tools.relay` (the face's, which writes the upstream's answer itself: openai on the chat face,
   * anthropic on the Messages face), a CLI with a toolMode through a tool engine — and failing
   * over while nothing went out; a leg that cannot carry the tools is passed by, never asked for
   * text in their place. When none answered: a plain completion from the legs not tried only for
   * tool_choice none (the client asked for text); for any other an error — the last refusal of a
   * leg that took the tools, or a 400 naming each leg and why it cannot carry them — and so for
   * tools no CLI can honour. `tools`: `{ spec, messages (canonical), face, relay, state }`.
   *
   * `state.mode` names the engine running now, for a stream's headers: each leg sets its own as it
   * starts, and the plain completion after the walk none, so its stream opens without one. `state.failed`
   * lists the tool-engine legs that failed before the answer — target, engine, status, and what
   * each spent (`usage`, `retries`) — for the row of the leg that answers; an error that ends the
   * route carries the same (`failedLegs`, with their spend added to its `usage` and `retries`).
   */
  async *_toolRoute(requested, chain, args, run, tools) {
    const failed = [];
    if (tools.state) tools.state.failed = failed;
    try {
      yield* this._toolWalk(requested, chain, args, run, tools, failed);
    } catch (e) {
      throw withFailedLegs(e, failed);
    }
  }

  async *_toolWalk(requested, chain, args, run, tools, failed) {
    const { spec, face, relay = null, state = null, caller = '' } = tools;
    let lastError = null;
    let heldBack = null; // the credit guard's 429 for a leg it passed by, when no leg failed
    const tried = new Set();
    const refused = [];
    // tool_choice none asks for text: a leg that cannot carry tools still answers it as a plain
    // completion after the walk, so it is not "passed by" there.
    const textAllowed = !!spec?.historyOnly || spec?.choice?.mode === 'none';
    for (let i = 0; i < chain.length; i++) {
      const leg = chain[i];
      if (spec?.historyOnly) {
        tried.add(i);
        if (leg.adapter.kind === 'http' && relaysVerbatim(leg.adapter, face) && relay) {
          let releaseSpend = () => {};
          try {
            releaseSpend = this.reserveSpend(leg.adapter, leg.model, run.scope, this.estimateTokens(leg.adapter, leg.model, args, tools));
            run.holdSpend(releaseSpend);
            if (await relay(leg)) {
              yield { type: 'relayed', target: leg.target };
              return;
            }
            releaseSpend();
          } catch (e) {
            releaseSpend();
            const err = e instanceof LlmError ? e : new LlmError(`${leg.adapter.id}: ${e.message}`, { status: /abort|timeout/i.test(e.message ?? '') ? 504 : 502, provider: leg.adapter.id });
            err.leg = e?.leg || legMetaOf(leg.adapter, leg.model);
            if (e?.upstreamId && !err.upstreamId) err.upstreamId = e.upstreamId;
            if (args.signal?.aborted) throw err;
            lastError = routeError(lastError, err);
            refused.push({ target: leg.target, status: err.status });
            this.log(`passthrough via ${leg.adapter.id} failed: ${truncate(e.message, 300)}`);
          }
          continue;
        }
        const held = await this._heldBack(leg, run);
        if (held) {
          heldBack ||= held;
          continue;
        }
        if (state) state.mode = null;
        const canResume = !!run.known && run.known.upstreamSession && adapterOf(run.known.target) === leg.adapter.id && !!leg.adapter.resumable;
        const st = { emitted: false };
        let releaseSpend = () => {};
        try {
          const planned = await effortPlan(leg, args.effort);
          if (run.scope && planned.model !== leg.model) {
            const d = this.checkTarget(leg.adapter.id, planned.model, run.scope);
            if (!d.ok) throw scopeError(d.reason, leg.adapter.id);
          }
          const legEffort = planned.effort || (leg.adapter.wire === 'uhp' || leg.adapter.wire === 'traycer' ? args.effort : null);
          releaseSpend = this.reserveSpend(leg.adapter, planned.model, run.scope, this.estimateTokens(leg.adapter, planned.model, args, tools));
          run.holdSpend(releaseSpend);
          const events = leg.adapter.complete({
            model: planned.model,
            messages: args.messages,
            session: canResume ? run.known.upstreamSession : null,
            sessionKey: leg.adapter.resumable ? run.publicId : null,
            signal: args.signal,
            maxTokens: leg.adapter.kind === 'cli' ? (args.maxTokens || args.maxCompletionTokens || args.maxOutputTokens) : args.maxTokens,
            maxCompletionTokens: args.maxCompletionTokens,
            maxOutputTokens: args.maxOutputTokens,
            temperature: args.temperature,
            includeReasoning: args.includeReasoning,
            ...(legEffort ? { effort: legEffort } : {}),
            ...(args.harnessId ? { harnessId: args.harnessId } : {}),
            ...(args.trace ? { trace: args.trace } : {}),
          });
          yield* this._leg({ ...leg, model: planned.model }, withEffort(events, planned), run, st, { canResume, sessions: true });
          return;
        } catch (e) {
          releaseSpend();
          if (e?.scopeDenied) {
            if (chain.length === 1) throw e;
            lastError = lastError || e;
            refused.push({ target: leg.target, status: e.status });
            continue;
          }
          if (e?.clientError) {
            e.leg = e.leg || legMetaOf(leg.adapter, leg.model);
            throw e;
          }
          const err = this._legFailed(leg, e, st, args.signal, i + 1 < chain.length ? 'trying next candidate' : 'giving up');
          lastError = routeError(lastError, err);
          refused.push({ target: leg.target, status: err.status });
        }
        continue;
      }
      const path = toolPath(leg.adapter, spec, face);
      if (path === 'skip' || (path === 'passthrough' && !relay)) {
        if (!textAllowed && !spec.unsupported?.length) {
          const why = toolSkipReason(leg.adapter, spec, face, { relay: !!relay });
          if (why) this._skipLeg(run, leg, why.reason, why.detail);
        }
        continue;
      }
      tried.add(i);
      const held = await this._heldBack(leg, run);
      if (held) {
        heldBack ||= held;
        continue;
      }
      const more = chain.slice(i + 1).some((l) => toolPath(l.adapter, spec, face) !== 'skip') ? 'trying the next leg that takes tools' : 'no other leg takes tools';
      if (path === 'passthrough') {
        let releaseSpend = () => {};
        try {
          releaseSpend = this.reserveSpend(leg.adapter, leg.model, run.scope, this.estimateTokens(leg.adapter, leg.model, args, tools));
          run.holdSpend(releaseSpend);
          if (run.virtualState) {
            run.virtualState.chosen = leg.target;
            run.virtualState.chosenAdapter = leg.adapter.id;
            run.virtualState.chosenModel = leg.model;
            if (leg.tier) run.virtualState.tier = leg.tier;
            run.virtualState.latency = Math.max(0, Date.now() - run.virtualState.t0);
            run.onVirtual?.(snapshotVirtual(run.virtualState));
          }
          if (await relay(leg)) {
            if (run.virtualState) {
              run.virtualState.latency = Math.max(0, Date.now() - run.virtualState.t0);
              const snap = snapshotVirtual(run.virtualState);
              run.onVirtual?.(snap);
              yield { type: 'virtual', virtual: snap };
            }
            yield { type: 'relayed', target: leg.target };
            return;
          }
          releaseSpend();
        } catch (e) {
          releaseSpend();
          const err = e instanceof LlmError ? e : new LlmError(`${leg.adapter.id}: ${e.message}`, { status: /abort|timeout/i.test(e.message ?? '') ? 504 : 502, provider: leg.adapter.id });
          err.leg = e?.leg || legMetaOf(leg.adapter, leg.model);
          if (e?.upstreamId && !err.upstreamId) err.upstreamId = e.upstreamId;
          if (args.signal?.aborted) throw err;
          if (run.virtualState) {
            recordVirtualFallback(run.virtualState, leg, err);
            run.onVirtual?.(snapshotVirtual(run.virtualState));
          }
          lastError = routeError(lastError, err);
          refused.push({ target: leg.target, status: err.status });
          this.log(`passthrough via ${leg.adapter.id} failed: ${truncate(e.message, 300)}`);
        }
        continue;
      }
      const st = { emitted: false };
      let releaseSpend = () => {};
      try {
        const planned = await effortPlan(leg, args.effort);
        if (run.scope && planned.model !== leg.model) {
          const d = run.virtualState
            ? this.checkVirtualTarget(leg.adapter.id, planned.model, run.scope)
            : this.checkTarget(leg.adapter.id, planned.model, run.scope);
          if (!d.ok) throw scopeError(d.reason, leg.adapter.id);
        }
        const legEffort = planned.effort || (leg.adapter.wire === 'uhp' || leg.adapter.wire === 'traycer' ? args.effort : null);
        releaseSpend = this.reserveSpend(leg.adapter, planned.model, run.scope, this.estimateTokens(leg.adapter, planned.model, args, tools));
        run.holdSpend(releaseSpend);
        // A bridge session is the model's at an effort, whichever way the request spelled it: an
        // effort-suffixed id and the base id with the same effort are one conversation.
        const engineLeg = { ...leg, model: planned.model, effort: legEffort, target: planned.model !== leg.model ? `${leg.adapter.id}/${planned.model}` : leg.target };
        const events = toolEvents(engineLeg, {
          spec,
          messages: tools.messages,
          plain: args.messages,
          signal: args.signal,
          includeReasoning: args.includeReasoning,
          maxTokens: args.maxTokens || args.maxCompletionTokens || args.maxOutputTokens,
          state,
          mcp: this.toolEngines.mcp,
          log: this.log,
          caller,
          face,
          harnessId: args.harnessId,
          trace: args.trace,
        });
        yield* this._leg(engineLeg, withEffort(events, planned), run, st, { sessions: false });
        return;
      } catch (e) {
        releaseSpend();
        if (e?.scopeDenied) {
          if (chain.length === 1) throw e;
          lastError = lastError || e;
          refused.push({ target: leg.target, status: e.status });
          continue;
        }
        const err = this._legFailed(leg, e, st, args.signal, more);
        // A failure that ends the route: a 409 from the bridge (another request is answering this
        // very tool result: no other leg makes a second answer to it), and the bridge's tripwire
        // (a CLI that reached for a tool of its own is a security event: the request is not moved
        // to another engine, an HTTP upstream included).
        if (err.routeEnd) throw err;
        if (run.virtualState) {
          recordVirtualFallback(run.virtualState, leg, err);
          run.onVirtual?.(snapshotVirtual(run.virtualState));
        }
        if (err.toolMode) failed.push(failedLeg(leg, err));
        lastError = routeError(lastError, err);
        refused.push({ target: leg.target, status: err.status });
      }
    }
    // No leg answered with tools.
    if (spec.unsupported?.length) {
      throw lastError || heldBack || new LlmError(`"${requested}" has no leg that can take ${describeUnsupported(spec)}: only an HTTP upstream relays those (the openai wire on /v1/chat/completions, the anthropic wire on /v1/messages), and a CLI leg takes plain function tools only`, { status: 400, type: 'invalid_request_error' });
    }
    const choice = spec.choice?.mode;
    if (choice === 'required' || choice === 'named') {
      // A text answer is not what was asked for: say so, never hand one over in its place.
      throw this._toolsNotCarried(
        lastError ||
          heldBack ||
          new LlmError(`tool_choice ${choice === 'named' ? `names "${String(spec.choice.name).slice(0, 64)}"` : 'is required'}: the request needs a tool call, and no leg of "${requested}" takes tools — an HTTP upstream on the openai wire does, and so does a CLI with a toolMode (keysmith set <adapter> toolMode auto)`, {
            status: 400,
            type: 'invalid_request_error',
          }),
        run,
      );
    }
    const rest = chain.filter((_, i) => !tried.has(i));
    // Every leg could take the tools, and each one refused. Running the route again as a plain
    // completion would ask the same upstream a second time, drop the tools without a word and turn
    // a 429 into a 502: answer with what the leg said instead.
    if (!rest.length) throw lastError || heldBack || new LlmError(`every leg of "${requested}" has already refused this request`, { status: 502 });
    if (!textAllowed) {
      // tool_choice auto, and no leg that carries tools answered: the rest cannot carry them. A
      // plain completion from them would drop the tools without a word, and a client that offered
      // tools (Claude Code) breaks on a text answer it never asked for: fail out loud instead —
      // the last failure of a leg that took the tools, or a 400 naming each leg and why not.
      const passed = rest.map((l) => l.target).join(', ');
      this.log(
        refused.length
          ? `tools requested; ${refused.map((r) => `${r.target} refused (${r.status})`).join(', ')}, and the rest of "${requested}" (${passed}) cannot carry them — the request fails instead of a plain completion without them`
          : `tools requested but no leg of "${requested}" can carry them (${passed}) — the request fails instead of a plain completion without them`,
      );
      throw this._toolsNotCarried(lastError || heldBack || this._noToolLeg(requested, chain, run), run);
    }
    if (!spec.historyOnly) {
      if (refused.length) {
        // Those legs already said no to this very request: asking them again without the tools
        // spends their quota twice and can turn their refusal into a tool-less answer.
        this.log(`tools requested; ${refused.map((r) => `${r.target} refused (${r.status})`).join(', ')} — the rest of "${requested}" runs as a plain completion, without tools`);
      } else {
        this.log(`tools requested but no leg of "${requested}" takes them (an HTTP upstream on the openai wire, or a CLI with a toolMode) — running as a plain completion`);
      }
    }
    // No tool engine answers from here: a stream that opens now names none.
    if (state) state.mode = null;
    yield* this._failover(rest, args, run, lastError);
  }

  /**
   * Non-streaming convenience used by the faces when stream=false: the text, the usage (or why a
   * CLI reported none: `usageReason`), and the tool calls
   * an engine handed back for the client to run (`toolCalls`, canonical `tool_call` events), with
   * which engine answered (`toolMode`), why not the one picked first (`fallback`) and, for the MCP
   * bridge, which session answered and how it was reached (`bridge`). `relayed`:
   * an HTTP leg's answer went to the client verbatim (the face's relay wrote it), so there is
   * nothing here to write.
   */
  async collect(opts) {
    let text = '';
    let reasoning = '';
    let usage = null;
    let usageReason = null;
    let effort = null;
    let sessionId = null;
    let err = null;
    let retries = 0;
    let cutAt = null;
    const toolCalls = [];
    let toolMode = null;
    let fallback = null;
    let bridge = null;
    let relayed = false;
    let leg = null;
    let upstreamId = null;
    let virtual = null;
    const skippedLegs = [];
    const onSkip = (x) => {
      skippedLegs.push(x);
      opts.onSkip?.(x);
    };
    for await (const evt of this.complete({ ...opts, onSkip })) {
      if (evt.type === 'relayed') relayed = true;
      else if (evt.type === 'leg') leg = evt.leg;
      else if (evt.type === 'virtual') virtual = evt.virtual;
      else if (evt.type === 'upstream' && evt.upstreamId) upstreamId = evt.upstreamId;
      else if (evt.type === 'retry') retries++;
      else if (evt.type === 'cut') cutAt = evt.tool;
      else if (evt.type === 'delta') text += evt.text;
      else if (evt.type === 'tool_call') toolCalls.push(evt);
      else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
      else if (evt.type === 'reasoning') reasoning += evt.text;
      else if (evt.type === 'usage') usage = mergeUsage(usage, evt.usage);
      else if (evt.type === 'usage_unknown') usageReason ||= evt.reason || null;
      else if (evt.type === 'effort') effort = evt;
      else if (evt.type === 'session') sessionId = sessionId || evt.id;
      else if (evt.type === 'error') err = evt.message;
    }
    if (err && !text && !toolCalls.length) {
      const e = new LlmError(err, { status: 502, provider: leg?.adapter || null });
      if (leg) e.leg = leg;
      if (upstreamId) e.upstreamId = upstreamId;
      if (virtual) e.virtualRoute = virtual;
      throw e;
    }
    return { text, reasoning, usage, usageReason, effort, session: sessionId, retries, cutAt, toolCalls, toolMode, fallback, bridge, relayed, leg, upstreamId, ...(virtual ? { virtual } : {}), ...(skippedLegs.length ? { skippedLegs } : {}) };
  }
}

function snapshotVirtual(v) {
  if (!v) return null;
  return {
    virtual: v.virtual,
    label: v.label,
    tier: v.tier,
    chosen: v.chosen,
    target: v.chosen,
    chosenAdapter: v.chosenAdapter,
    chosenModel: v.chosenModel,
    fallbacks: [...v.fallbacks],
    fallbacksTried: [...v.fallbacks],
    fallbackDetails: v.fallbackDetails.map((d) => ({ ...d })),
    skipped: [...(v.skipped || [])],
    reason: v.reason,
    classifyMs: v.classifyMs,
    congested: v.congested,
    latency: v.latency,
    status: v.status,
    ...(v.error ? { error: v.error } : {}),
  };
}

function recordVirtualFallback(virtualState, leg, err) {
  if (!virtualState || !leg) return;
  const target = leg.target || `${leg.adapter?.id || ''}/${leg.model || ''}`;
  if (!virtualState.fallbacks.includes(target)) {
    virtualState.fallbacks.push(target);
  }
  const status = err?.status || 502;
  const detail = {
    target,
    tier: leg.tier || null,
    status,
    error: redactSecrets(err?.message || String(err)),
  };
  virtualState.fallbackDetails.push(detail);
  const summary = virtualState.fallbackDetails.map((d) => `${d.target}:${d.status}`).join(', ');
  virtualState.reason = `${virtualState.baseReason}; fallthrough (${summary})`;
}

/**
 * A leg's model and effort (src/effort.js): a CLI's checked against its catalogue, an HTTP leg's
 * as it was (its body is keysmith's own on a plain completion, the client's on the relay).
 */
async function effortPlan(leg, effort) {
  if (leg.adapter.kind !== 'cli') return { model: leg.model, effort: null };
  return resolveEffort(leg.adapter, leg.model, effort);
}

/** A leg's events with its effort in front (`{ type: 'effort', effort }`, or `ignored` and why), for the usage row. */
async function* withEffort(events, planned) {
  if (planned.effort) yield { type: 'effort', effort: planned.effort };
  else if (planned.ignored) yield { type: 'effort', ignored: planned.ignored };
  yield* events;
}

export function legMetaOf(adapter, upstreamModel = '') {
  if (!adapter) return null;
  const mapped = typeof adapter.upstreamModel === 'function' ? adapter.upstreamModel(upstreamModel) : upstreamModel;
  return {
    adapter: adapter.id,
    kind: adapter.kind,
    ...(adapter.kind === 'http' && adapter.host ? { host: adapter.host } : {}),
    account: adapter.account ?? null,
    ...(adapter.costBasis ? { costBasis: adapter.costBasis } : {}),
    model: mapped || '',
  };
}

function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) {
    const out = { ...b };
    if (b.cacheInclusive) Object.defineProperty(out, 'cacheInclusive', { value: true, enumerable: false });
    if (b.total != null) Object.defineProperty(out, 'total', { value: b.total, enumerable: false });
    return out;
  }
  // Upstreams sometimes report per-request-usage and cumulative totals; keep the max.
  const out = {
    input: Math.max(a.input || 0, b.input || 0),
    output: Math.max(a.output || 0, b.output || 0),
    cacheRead: Math.max(a.cacheRead || 0, b.cacheRead || 0),
    cacheWrite: Math.max(a.cacheWrite || 0, b.cacheWrite || 0),
    ...(a.reasoning || b.reasoning ? { reasoning: Math.max(a.reasoning || 0, b.reasoning || 0) } : {}),
    ...(a.total || b.total ? { total: Math.max(a.total || 0, b.total || 0) } : {}),
  };
  if (a.cacheInclusive || b.cacheInclusive) {
    Object.defineProperty(out, 'cacheInclusive', { value: true, enumerable: false });
  }
  return out;
}

/**
 * The marks a tool engine puts on its failure (router.js, emulate.js, the bridge), as own fields
 * of `e`: which engine, why (`fallbackReason`), what it spent, and whether it ends the route.
 */
function engineMarks(e) {
  const out = {};
  for (const k of ['toolMode', 'fallback', 'usage', 'retries', 'fallbackReason', 'noFallback', 'routeEnd']) if (e && typeof e === 'object' && e[k] != null) out[k] = e[k];
  return out;
}

/**
 * Whether an untyped failure says, by its type, that it timed out: `ETIMEDOUT`, or the
 * `TimeoutError` an `AbortSignal.timeout()` rejects with. Not a guess from its message.
 */
export function isTimeoutError(e) {
  return !!e && typeof e === 'object' && (e.code === 'ETIMEDOUT' || e.name === 'TimeoutError');
}

/** Why a tool engine failed, as a usage row says it: the bridge's reason code (`foreign_tool`, `ready_timeout`, …), or null. */
export function failureOf(e) {
  const r = e && typeof e === 'object' ? e.fallbackReason : null;
  return typeof r === 'string' && r ? r.slice(0, 40) : null;
}

/**
 * A tool-engine leg that failed before the route's answer, as a usage row names it: its target,
 * the engine, the status, and what it spent. Names and numbers only — never a message, which can
 * quote the model's reply. The error itself rides along unenumerated (never written).
 */
function failedLeg(leg, err) {
  const failure = failureOf(err);
  const entry = {
    target: leg.target,
    toolMode: err.toolMode,
    status: err.status,
    ...(failure ? { failure } : {}),
    ...(err.fallback ? { fallback: err.fallback } : {}),
    ...(err.retries ? { retries: err.retries } : {}),
    ...(err.usage ? { usage: err.usage } : {}),
  };
  Object.defineProperty(entry, 'error', { value: err, enumerable: false });
  return entry;
}

/**
 * The error that ends a tool route, with the tool legs that failed before it (other than itself):
 * named in `failedLegs`, their usage added to its `usage` and their retries to its `retries`.
 * Each run was spent, and a 502 row with no usage would say it was not.
 */
function withFailedLegs(e, failed) {
  if (!e || typeof e !== 'object') return e;
  const others = failed.filter((f) => f.error !== e);
  if (!others.length) return e;
  e._ownUsage = e.usage ?? null;
  e.failedLegs = others.map((f) => ({ ...f }));
  const usage = others.reduce((u, f) => addUsage(u, f.usage), e.usage ?? null);
  if (usage) e.usage = usage;
  const retries = others.reduce((n, f) => n + (f.retries || 0), e.retries || 0);
  if (retries) e.retries = retries;
  return e;
}

/** A request the key's scope does not cover: 403, marked so the usage log says `denied`. */
export function scopeError(reason, _adapterId) {
  const e = new LlmError(reason, { status: 403, type: 'permission_error', provider: null });
  e.scopeDenied = true;
  return e;
}

/** Why an adapter never answers through an alias, in one clause. */
export function keptOutOfAliases(id, adapter) {
  return adapter.unsafeTools
    ? `adapter "${id}" can run commands and edit files (unsafeTools), so it is never an alias leg`
    : `adapter "${id}" is explicit-only: it answers a request that names it, never an alias leg`;
}

/** `name` is an entry of `obj` itself, not something every object inherits (`constructor`, `toString`). */
export function own(obj, name) {
  return !!obj && typeof obj === 'object' && typeof name === 'string' && Object.hasOwn(obj, name);
}

/**
 * The adapter a config entry builds, built the way the gateway builds it — or the error that
 * would keep it from loading (a malformed `modelParams`, an auto-approving argv, a missing
 * `baseUrl`, a `workspaceFiles` path that leaves its cwd). Credentials are not resolved: a key
 * this shell cannot see may well be visible to the gateway, and that is `doctor`'s question.
 */
export function checkAdapter(id, raw) {
  const cfg = { ...raw, _rawKeyRef: raw?.apiKey ?? raw?.key ?? null, _apiKey: null };
  delete cfg.key;
  return cfg.kind === 'cli' ? new CliAdapter(id, cfg) : new HttpAdapter(id, cfg);
}

function adapterOf(target) {
  const i = String(target).indexOf('/');
  return i < 0 ? target : target.slice(0, i);
}

function modelOf(target) {
  const i = String(target).indexOf('/');
  return i < 0 ? '' : target.slice(i + 1);
}

/**
 * The model ids we can check a leg against without touching the network: the `models`
 * the adapter was given in its config, or the catalogue it last actually read (a CLI's
 * `--list-models`, upstream `/models`) while that read is still fresh.
 * Returns null when neither exists — startup, before any listing has been asked for.
 */
function knownModels(adapter) {
  // An effort-suffixed id (`gpt-6-astra-xhigh`) is the catalogue's too, on a CLI that takes an effort.
  const withEfforts = (list) => list.flatMap((m) => [typeof m === 'string' ? m : m?.id, ...(adapter.takesEffort && m && typeof m === 'object' ? suffixedIds(list, m).map((x) => x.id) : [])]).filter(Boolean);
  const declared = adapter._declared ?? adapter.declaredModels ?? null;
  if (Array.isArray(declared)) {
    const ids = withEfforts(declared);
    if (ids.length) return { ids, from: 'declared models' };
  } else if (declared && typeof declared === 'object' && Object.keys(declared).length) {
    return { ids: Object.keys(declared), from: 'declared models' };
  }
  const cached = adapter._modelCache;
  if (Array.isArray(cached?.list) && cached.list.length && Date.now() - (cached.at || 0) < 600_000) {
    return { ids: withEfforts(cached.list), from: 'last-read model list' };
  }
  return null;
}

function newSessionId() {
  return 'kss_' + randomUUID().replace(/-/g, '').slice(0, 20);
}

/**
 * Turn a config entry into adapter constructor args:
 *  - resolves the `apiKey` secret reference onto `_apiKey` (never logged)
 *  - accepts `key: "..."` as a shorter alias for `apiKey`
 */
export function prepareAdapter(id, raw) {
  const cfg = { ...raw };
  const ref = cfg.apiKey ?? cfg.key ?? null;
  cfg._rawKeyRef = ref;
  delete cfg.key;
  if (ref == null || ref === false) {
    cfg._apiKey = null;
  } else if (cfg._apiKeyResolved) {
    cfg._apiKey = cfg._apiKey ?? ref;
  } else {
    let resolved = null;
    try {
      resolved = resolveSecret(ref);
    } catch (e) {
      throw new Error(`apiKey reference: ${e.message}`);
    }
    if (!resolved && cfg.apiKeyEnv) {
      resolved = process.env[cfg.apiKeyEnv] || null;
    }
    if (!resolved) {
      const hint = typeof ref === 'string' && ref.startsWith('{env:') ? ` (env ${ref.slice(5, -1)} is unset)` : ` (${ref})`;
      throw new Error(`no credentials${hint}`);
    }
    cfg._apiKey = resolved;
  }
  if (cfg.apiKeyEnv && !cfg._apiKey) cfg._apiKey = process.env[cfg.apiKeyEnv] || null;
  if (cfg.kind === 'cli' && !which(cfg.bin || id)) cfg._missingBin = cfg.bin || id;
  return cfg;
}

export function kindOf(cfg) {
  return cfg.kind === 'cli' || cfg.bin ? 'cli' : 'http';
}

function countPromptChars(val) {
  if (val == null) return 0;
  if (typeof val === 'string') return val.length;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val).length;
  if (Array.isArray(val)) {
    let n = 0;
    for (const item of val) n += countPromptChars(item);
    return n;
  }
  if (typeof val === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(val)) {
      if (k === 'data' && typeof v === 'string' && v.length > 4096) {
        n += Math.min(v.length, 4096);
      } else {
        n += countPromptChars(v);
      }
    }
    return n;
  }
  return 0;
}
