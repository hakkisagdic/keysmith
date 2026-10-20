import { randomUUID } from 'node:crypto';
import { HttpAdapter } from './http-adapter.js';
import { CliAdapter, which } from './cli-adapter.js';
import { LlmError, routeError, truncate } from './util.js';
import { resolveSecret } from './config.js';
import { redactSecrets, registerSecrets } from './redact.js';
import { ThoughtSignatures, limitsFrom } from './thought-signatures.js';
import { adapterReach, aliasDecision, requestDecision } from './keys.js';
import { describeUnsupported, toolEvents, toolPath } from './tools/router.js';
import { addUsage } from './tools/emulate.js';
import { McpBridge } from './bridge/index.js';
import { DRIVERS } from './bridge/agy.js';

/**
 * The gateway: config in, one model catalogue + one streaming `complete()` out.
 *
 * Namespacing rule: `<adapter>/<upstream model>`. Upstream ids may themselves
 * contain slashes (`deepseek/deepseek-v4-flash` on OpenRouter), so only the FIRST
 * slash separates adapter from model. Adapter ids are config keys and therefore
 * slash-free by construction.
 */
export class Gateway {
  constructor(cfg, { log = () => {} } = {}) {
    this.cfg = cfg;
    // Redacted here as well as by the CLI's writer: an embedding's own log function is
    // handed provider errors, and those can quote a key.
    this.log = (m) => log(redactSecrets(m));
    this.adapters = new Map();
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
    for (const [id, raw] of Object.entries(cfg.adapters || {})) {
      try {
        const prepared = prepareAdapter(id, raw);
        // From here on every log line, usage row and error message takes this key out, the
        // way it takes out the gateway's own (redact.js).
        registerSecrets([prepared._apiKey]);
        if (prepared.kind !== 'cli' && prepared.thoughtSignatures) prepared._signatureStore = this._signatureStore(prepared);
        const adapter = prepared.kind === 'cli' ? new CliAdapter(id, prepared) : new HttpAdapter(id, prepared);
        this.adapters.set(id, adapter);
        if (adapter.unsafeTools && !adapter.disabled) this.log(`adapter "${id}" can run commands and edit files (unsafeTools) and is enabled: it answers requests that name it, never an alias`);
      } catch (e) {
        // Shown on /status, /v1/models, /v1/keysmith/routes and by doctor: redacted at the source.
        this.loadErrors[id] = redactSecrets(e.message);
        this.log(`adapter "${id}" failed to load: ${e.message}`);
      }
    }
    // The bridge exists when a CLI with toolMode mcp or auto has a driver for it (agy with a
    // `bridge.args`). Nothing listens until the first request that takes it, or `serve`'s start().
    const bridged = [...this.adapters.values()].some((a) => a.kind === 'cli' && (a.toolMode === 'mcp' || a.toolMode === 'auto') && DRIVERS.some((d) => d.supports(a)));
    if (bridged) this.toolEngines.mcp = new McpBridge({ limits: cfg.limits?.bridge, log: this.log, adapters: () => [...this.adapters.values()] });
  }

  /** Stop what the gateway runs on its own: the MCP bridge's sessions (each CLI stopped) and its socket. */
  async close() {
    await this.toolEngines.mcp?.close?.();
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

  /** May a key with `scope` name `requested` at all — an alias it may use, or a target it may reach? */
  mayName(requested, scope) {
    if (!scope) return true;
    if (typeof requested !== 'string' || !requested) return false;
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
        try {
          for (const m of await a.models()) {
            if (!m?.id) continue;
            if (scope && !this.checkTarget(a.id, m.id, scope).ok) continue;
            models.push({
              id: `${a.id}/${m.id}`,
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
              },
            });
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
  resolve(requested, { exclude = null, scope = null } = {}) {
    if (!requested) throw new LlmError('missing "model"', { status: 400 });
    if (typeof requested !== 'string') throw new LlmError('"model" must be a string', { status: 400 });
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
        err = new LlmError(why ? `adapter "${adapterId}" is configured but did not load: ${why}` : `no adapter named "${adapterId}" — try one of: ${live.join(', ')}`, { status: why ? 503 : 404, provider: adapterId });
      } else if (adapter.disabled) {
        err = new LlmError(`adapter "${adapterId}" is disabled`, { status: 503, provider: adapterId });
      } else if (isAlias && adapter.explicitOnly) {
        // An alias is a route the gateway picks legs from on its own; this adapter is only
        // ever run by a request that names it. A hand-edited leg is a dead leg, not a route.
        err = new LlmError(`alias "${requested}": ${keptOutOfAliases(adapterId, adapter)}`, { status: 403, provider: adapterId });
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
   * Stream one completion. Fails over to the next candidate in the chain only while
   * nothing has reached the client yet — a half-delivered answer is never restarted.
   *
   * Sessions: an OpenAI client is stateless, but a CLI has a real conversation on
   * disk. `x-keysmith-session` carries an opaque keysmith id that we map onto the
   * upstream session, so a chat app gets genuine multi-turn (and prompt-cache)
   * behaviour out of a tool that was never meant to answer HTTP.
   */
  async *complete({ model, messages, session, signal, maxTokens, temperature, includeReasoning = false, exclude = null, scope = null, tools = null }) {
    const chain = this.resolve(model, { exclude, scope });
    const publicId = session || newSessionId();
    const known = session ? this.sessions.get(publicId) : null;
    const run = { publicId, known, reportedSession: false, includeReasoning, signal };
    const args = { messages, maxTokens, temperature, includeReasoning, signal };
    if (tools) return yield* this._toolRoute(model, chain, args, run, tools);
    yield* this._failover(chain, args, run, null);
  }

  /**
   * The legs of `chain` in order as plain completions, each tried only while nothing of an answer
   * reached the client. `carried` is a failure from before (the tool walk's), kept by the rule
   * routeError() states: a 429/503 is the answer over a later leg's other refusal.
   */
  async *_failover(chain, args, run, carried) {
    let lastError = carried;
    for (const leg of chain) {
      const { adapter, model: upstreamModel } = leg;
      const canResume = !!run.known && run.known.upstreamSession && adapterOf(run.known.target) === adapter.id && !!adapter.resumable;
      // Outside the try: a leg that throws after part of its answer went out (text, or a tool
      // call the client may already be running) is not restarted on the next leg either.
      const state = { emitted: false };
      try {
        const events = adapter.complete({
          model: upstreamModel,
          messages: args.messages,
          session: canResume ? run.known.upstreamSession : null,
          signal: args.signal,
          maxTokens: args.maxTokens,
          temperature: args.temperature,
          includeReasoning: args.includeReasoning,
        });
        yield* this._leg(leg, events, run, state, { canResume, sessions: true });
        return;
      } catch (e) {
        const err = this._legFailed(leg, e, state, args.signal, chain.length > 1 ? 'trying next candidate' : 'giving up');
        if (chain.length === 1) throw lastError ? routeError(lastError, err) : err;
        lastError = routeError(lastError, err);
      }
    }
    throw lastError || new LlmError('no candidate in this route succeeded', { status: 502 });
  }

  /**
   * One leg's events on their way to a face. Throws when the leg fails before any text or call of
   * its answer went out (`state.emitted` says whether one did). `sessions`: a tool leg resumes no
   * CLI session and maps none.
   */
  async *_leg({ adapter, model: upstreamModel }, events, run, state, { canResume = false, sessions = true } = {}) {
    for await (const evt of events) {
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
        throw new LlmError(message, { status: 502, provider: adapter.id });
      }
      if (evt.type === 'session') {
        if (!sessions) continue;
        if (evt.id) {
          this._remember(run.publicId, { target: `${adapter.id}/${upstreamModel}`, upstreamSession: evt.id });
          if (!run.reportedSession) {
            run.reportedSession = true;
            yield { type: 'session', id: run.publicId, resumed: canResume };
          }
          continue;
        }
      }
      yield evt;
    }
    if (sessions && !run.reportedSession && run.known) {
      run.reportedSession = true;
      yield { type: 'session', id: run.publicId, resumed: true };
    }
  }

  /** A leg's failure as the LlmError the route keeps, logged; rethrown when it must end the route. */
  _legFailed({ adapter, model: upstreamModel }, e, state, signal, next) {
    // Wrapped, a failure keeps what a tool engine marked it with: which engine, and what it spent.
    const err = e instanceof LlmError ? e : Object.assign(new LlmError(e.message, { status: 502, provider: adapter.id }), engineMarks(e));
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
   * taking the tools the way it can — an HTTP upstream verbatim through `tools.relay` (the face's,
   * which writes the upstream's answer itself), a CLI with a toolMode through a tool engine — and
   * failing over while nothing went out. When none answered: a plain completion from the legs not
   * tried, for tool_choice auto or none; an error for one that asks for a call, or for tools no
   * CLI can honour. `tools`: `{ spec, messages (canonical), face, relay, state }`.
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
    const tried = new Set();
    const refused = [];
    for (let i = 0; i < chain.length; i++) {
      const leg = chain[i];
      const path = toolPath(leg.adapter, spec, face);
      if (path === 'skip' || (path === 'passthrough' && !relay)) continue;
      tried.add(i);
      const more = chain.slice(i + 1).some((l) => toolPath(l.adapter, spec, face) !== 'skip') ? 'trying the next leg that takes tools' : 'no other leg takes tools';
      if (path === 'passthrough') {
        try {
          if (await relay(leg)) {
            yield { type: 'relayed', target: leg.target };
            return;
          }
        } catch (e) {
          const err = e instanceof LlmError ? e : new LlmError(`${leg.adapter.id}: ${e.message}`, { status: /abort|timeout/i.test(e.message ?? '') ? 504 : 502, provider: leg.adapter.id });
          if (args.signal?.aborted) throw err;
          lastError = routeError(lastError, err);
          refused.push({ target: leg.target, status: err.status });
          this.log(`passthrough via ${leg.adapter.id} failed: ${truncate(e.message, 300)}`);
        }
        continue;
      }
      const st = { emitted: false };
      try {
        const events = toolEvents(leg, {
          spec,
          messages: tools.messages,
          plain: args.messages,
          signal: args.signal,
          includeReasoning: args.includeReasoning,
          maxTokens: args.maxTokens,
          state,
          mcp: this.toolEngines.mcp,
          log: this.log,
          caller,
          face,
        });
        yield* this._leg(leg, events, run, st, { sessions: false });
        return;
      } catch (e) {
        const err = this._legFailed(leg, e, st, args.signal, more);
        // A 409 from the bridge (another request is answering this very tool result): no other
        // leg makes a second answer to it.
        if (err.routeEnd) throw err;
        if (err.toolMode) failed.push(failedLeg(leg, err));
        lastError = routeError(lastError, err);
        refused.push({ target: leg.target, status: err.status });
      }
    }
    // No leg answered with tools.
    if (spec.unsupported?.length) {
      throw lastError || new LlmError(`"${requested}" has no leg that can take ${describeUnsupported(spec)}: only an HTTP upstream relays those (on /v1/chat/completions), and a CLI leg takes plain function tools only`, { status: 400, type: 'invalid_request_error' });
    }
    const choice = spec.choice?.mode;
    if (choice === 'required' || choice === 'named') {
      // A text answer is not what was asked for: say so, never hand one over in its place.
      throw lastError || new LlmError(`tool_choice ${choice === 'named' ? `names "${String(spec.choice.name).slice(0, 64)}"` : 'is required'}: the request needs a tool call, and no leg of "${requested}" takes tools — an HTTP upstream on the openai wire does, and so does a CLI with a toolMode (keysmith set <adapter> toolMode auto)`, {
        status: 400,
        type: 'invalid_request_error',
      });
    }
    const rest = chain.filter((_, i) => !tried.has(i));
    // Every leg could take the tools, and each one refused. Running the route again as a plain
    // completion would ask the same upstream a second time, drop the tools without a word and turn
    // a 429 into a 502: answer with what the leg said instead.
    if (!rest.length) throw lastError || new LlmError(`every leg of "${requested}" has already refused this request`, { status: 502 });
    if (refused.length) {
      // Those legs already said no to this very request: asking them again without the tools
      // spends their quota twice and can turn their refusal into a tool-less answer.
      this.log(`tools requested; ${refused.map((r) => `${r.target} refused (${r.status})`).join(', ')} — the rest of "${requested}" runs as a plain completion, without tools`);
    } else {
      this.log(`tools requested but no leg of "${requested}" takes them (an HTTP upstream on the openai wire, or a CLI with a toolMode) — running as a plain completion`);
    }
    // No tool engine answers from here: a stream that opens now names none.
    if (state) state.mode = null;
    yield* this._failover(rest, args, run, lastError);
  }

  /**
   * Non-streaming convenience used by the faces when stream=false: the text, and the tool calls
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
    let sessionId = null;
    let err = null;
    let retries = 0;
    let cutAt = null;
    const toolCalls = [];
    let toolMode = null;
    let fallback = null;
    let bridge = null;
    let relayed = false;
    for await (const evt of this.complete(opts)) {
      if (evt.type === 'relayed') relayed = true;
      else if (evt.type === 'retry') retries++;
      else if (evt.type === 'cut') cutAt = evt.tool;
      else if (evt.type === 'delta') text += evt.text;
      else if (evt.type === 'tool_call') toolCalls.push(evt);
      else if (evt.type === 'tool_mode') [toolMode, fallback, bridge] = [evt.mode || null, evt.fallback || null, evt.bridge || null];
      else if (evt.type === 'reasoning') reasoning += evt.text;
      else if (evt.type === 'usage') usage = mergeUsage(usage, evt.usage);
      else if (evt.type === 'session') sessionId = sessionId || evt.id;
      else if (evt.type === 'error') err = evt.message;
    }
    if (err && !text && !toolCalls.length) throw new LlmError(err, { status: 502 });
    return { text, reasoning, usage, session: sessionId, retries, cutAt, toolCalls, toolMode, fallback, bridge, relayed };
  }
}

function mergeUsage(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  // Upstreams sometimes report per-request-usage and cumulative totals; keep the max.
  return {
    input: Math.max(a.input || 0, b.input || 0),
    output: Math.max(a.output || 0, b.output || 0),
    cacheRead: Math.max(a.cacheRead || 0, b.cacheRead || 0),
    cacheWrite: Math.max(a.cacheWrite || 0, b.cacheWrite || 0),
    ...(a.total || b.total ? { total: Math.max(a.total || 0, b.total || 0) } : {}),
  };
}

/** The marks a tool engine puts on its failure (router.js, emulate.js), as own fields of `e`. */
function engineMarks(e) {
  const out = {};
  for (const k of ['toolMode', 'fallback', 'usage', 'retries']) if (e && typeof e === 'object' && e[k] != null) out[k] = e[k];
  return out;
}

/**
 * A tool-engine leg that failed before the route's answer, as a usage row names it: its target,
 * the engine, the status, and what it spent. Names and numbers only — never a message, which can
 * quote the model's reply. The error itself rides along unenumerated (never written).
 */
function failedLeg(leg, err) {
  const entry = {
    target: leg.target,
    toolMode: err.toolMode,
    status: err.status,
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
  e.failedLegs = others.map((f) => ({ ...f }));
  const usage = others.reduce((u, f) => addUsage(u, f.usage), e.usage ?? null);
  if (usage) e.usage = usage;
  const retries = others.reduce((n, f) => n + (f.retries || 0), e.retries || 0);
  if (retries) e.retries = retries;
  return e;
}

/** A request the key's scope does not cover: 403, marked so the usage log says `denied`. */
export function scopeError(reason, adapterId) {
  const e = new LlmError(reason, { status: 403, type: 'permission_error', provider: adapterId || null });
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
  const cfg = { ...raw, _apiKey: null };
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
  const declared = adapter._declared ?? adapter.declaredModels ?? null;
  if (Array.isArray(declared)) {
    const ids = declared.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    if (ids.length) return { ids, from: 'declared models' };
  } else if (declared && typeof declared === 'object' && Object.keys(declared).length) {
    return { ids: Object.keys(declared), from: 'declared models' };
  }
  const cached = adapter._modelCache;
  if (Array.isArray(cached?.list) && cached.list.length && Date.now() - (cached.at || 0) < 600_000) {
    return { ids: cached.list.map((m) => m?.id || m).filter(Boolean), from: 'last-read model list' };
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
  delete cfg.key;
  if (ref == null || ref === false) {
    cfg._apiKey = null;
  } else if (cfg._apiKeyResolved) {
    cfg._apiKey = ref;
  } else {
    let resolved = null;
    try {
      resolved = resolveSecret(ref);
    } catch (e) {
      throw new Error(`apiKey reference: ${e.message}`);
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
