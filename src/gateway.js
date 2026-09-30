import { randomUUID } from 'node:crypto';
import { HttpAdapter } from './http-adapter.js';
import { CliAdapter, which } from './cli-adapter.js';
import { LlmError, truncate } from './util.js';
import { resolveSecret } from './config.js';

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
    this.log = log;
    this.adapters = new Map();
    this.loadErrors = {}; // adapter id -> why it never constructed; doctor and /status must say so
    this.sessions = new Map(); // x-keysmith-session id -> {adapter, upstream session}
    this.inFlight = 0;
    for (const [id, raw] of Object.entries(cfg.adapters || {})) {
      try {
        const prepared = prepareAdapter(id, raw);
        const adapter = prepared.kind === 'cli' ? new CliAdapter(id, prepared) : new HttpAdapter(id, prepared);
        this.adapters.set(id, adapter);
      } catch (e) {
        this.loadErrors[id] = e.message;
        this.log(`adapter "${id}" failed to load: ${e.message}`);
      }
    }
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
    const out = {};
    for (const [alias, targets] of Object.entries(this.cfg.aliases || {})) {
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
          const adapter = this.adapters.get(adapterId);
          if (!adapter && slash < 0 && this.cfg.aliases?.[leg]) {
            problems.push(`${leg}: aliases cannot nest — name the adapter/model directly`);
            continue;
          }
          if (!adapter) {
            problems.push(`${leg}: ${this.loadErrors[adapterId] ? `adapter "${adapterId}" is configured but did not load (${this.loadErrors[adapterId]})` : `no adapter named "${adapterId}"`} — that leg 404s on every request`);
            continue;
          }
          if (adapter.disabled) {
            problems.push(`${leg}: adapter "${adapterId}" is disabled`);
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

  get publicAdapters() {
    return [...this.adapters.values()].filter((a) => !a.disabled);
  }

  /** @returns {Promise<{models: Array<object>, errors: Array<string>}>} */
  async listModels({ refresh = false } = {}) {
    const models = [];
    const errors = [];
    for (const [id, msg] of Object.entries(this.loadErrors)) errors.push(`${id}: configured but did not load — ${msg}`);
    await Promise.all(
      this.publicAdapters.map(async (a) => {
        if (refresh) a._modelCache = null;
        try {
          for (const m of await a.models()) {
            if (!m?.id) continue;
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
          errors.push(`${a.id}: ${e.message}`);
        }
      }),
    );
    for (const [alias, targets] of Object.entries(this.cfg.aliases || {})) {
      models.push({
        id: alias,
        object: 'model',
        owned_by: 'keysmith:alias',
        keysmith: { adapter: 'alias', kind: 'alias', routes: targets, priority: -1, ...(this.aliasIssues[alias] ? { warnings: this.aliasIssues[alias] } : {}) },
      });
    }
    // After the fetches above: `knownModels` can only check a dynamic catalogue once the
    // adapter has actually read one, so an alias leg pointing at a wrong evren/CLI model
    // becomes knowable right here — report it in the same call that learned it.
    for (const [alias, problems] of Object.entries(this.aliasIssues)) {
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
   */
  resolve(requested) {
    if (!requested) throw new LlmError('missing "model"', { status: 400 });
    const aliases = this.cfg.aliases || {};
    const isAlias = !!aliases[requested];
    const chain = isAlias ? [...aliases[requested]] : [requested];
    const out = [];
    let firstError = null;
    for (const entry of chain) {
      const slash = entry.indexOf('/');
      const adapterId = slash < 0 ? entry : entry.slice(0, slash);
      const modelName = slash < 0 ? '' : entry.slice(slash + 1);
      const adapter = this.adapters.get(adapterId);
      let err = null;
      if (!adapter) {
        const why = this.loadErrors[adapterId];
        err = new LlmError(why ? `adapter "${adapterId}" is configured but did not load: ${why}` : `no adapter named "${adapterId}" — try one of: ${[...this.adapters.keys()].join(', ')}`, { status: why ? 503 : 404, provider: adapterId });
      } else if (adapter.disabled) {
        err = new LlmError(`adapter "${adapterId}" is disabled`, { status: 503, provider: adapterId });
      }
      if (err) {
        firstError ??= err;
        if (isAlias && chain.length > 1) {
          this.log(`alias "${requested}" skipped a dead leg: ${err.message}`);
          continue;
        }
        throw err;
      }
      out.push({ adapter, model: modelName || adapter.defaultModel || '', target: entry });
    }
    if (!out.length) throw firstError;
    // Declared order wins in an alias: you wrote the chain, you know which leg should
    // be tried first. `priority` only orders the flat model listing.
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
  async *complete({ model, messages, session, signal, maxTokens, temperature, includeReasoning = false }) {
    const chain = this.resolve(model);
    const publicId = session || newSessionId();
    const known = session ? this.sessions.get(publicId) : null;
    let reportedSession = false;
    let lastError = null;

    for (const { adapter, model: upstreamModel } of chain) {
      try {
        const canResume = !!known && known.upstreamSession && adapterOf(known.target) === adapter.id && !!adapter.resumable;
        let emitted = false;
        for await (const evt of adapter.complete({
          model: upstreamModel,
          messages,
          session: canResume ? known.upstreamSession : null,
          signal,
          maxTokens,
          temperature,
          includeReasoning,
        })) {
          // One rule for both adapter kinds: chain-of-thought is only ever forwarded to
          // a client that asked for it. Providers and CLIs emit it freely; a UI that
          // shows it unasked is a surprise, and it costs output tokens.
          if (evt.type === 'reasoning' && !includeReasoning) continue;
          if (evt.type === 'delta') emitted = true;
          if (evt.type === 'error') {
            if (emitted) {
              yield evt;
              return;
            }
            throw new LlmError(evt.message, { status: 502, provider: adapter.id });
          }
          if (evt.type === 'session' && evt.id) {
            this._remember(publicId, { target: `${adapter.id}/${upstreamModel}`, upstreamSession: evt.id });
            if (!reportedSession) {
              reportedSession = true;
              yield { type: 'session', id: publicId, resumed: canResume };
            }
            continue;
          }
          yield evt;
        }
        if (!reportedSession && known) {
          reportedSession = true;
          yield { type: 'session', id: publicId, resumed: true };
        }
        return;
      } catch (e) {
        lastError = e instanceof LlmError ? e : new LlmError(e.message, { status: 502, provider: adapter.id });
        if (signal?.aborted) throw lastError;
        this.log(`${adapter.id}/${truncate(upstreamModel, 60)} failed, ${chain.length > 1 ? 'trying next candidate' : 'giving up'}: ${truncate(e.message, 160)}`);
        if (chain.length === 1) throw lastError;
      }
    }
    throw lastError || new LlmError('no candidate in this route succeeded', { status: 502 });
  }

  /** Non-streaming convenience used by /chat/completions when stream=false. */
  async collect(opts) {
    let text = '';
    let reasoning = '';
    let usage = null;
    let sessionId = null;
    let err = null;
    for await (const evt of this.complete(opts)) {
      if (evt.type === 'delta') text += evt.text;
      else if (evt.type === 'reasoning') reasoning += evt.text;
      else if (evt.type === 'usage') usage = mergeUsage(usage, evt.usage);
      else if (evt.type === 'session') sessionId = sessionId || evt.id;
      else if (evt.type === 'error') err = evt.message;
    }
    if (err && !text) throw new LlmError(err, { status: 502 });
    return { text, reasoning, usage, session: sessionId };
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

function adapterOf(target) {
  const i = String(target).indexOf('/');
  return i < 0 ? target : target.slice(0, i);
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
