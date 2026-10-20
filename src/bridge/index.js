import path from 'node:path';
import { createHash } from 'node:crypto';
import { LlmError, truncate } from '../util.js';
import { dataDir, expand } from '../config.js';
import { addUsage, renderPrompt } from '../tools/emulate.js';
import { isPlainObject, newToolCallId } from '../tools/model.js';
import { namesFit } from '../tools/router.js';
import { HUB_DEFAULTS, Hub, SESSION_DEFAULTS } from './hub.js';
import { MAX_INVALID_CALLS, toolListing } from './mcp.js';
import { DRIVERS } from './drivers.js';
import { KILL_GRACE_MS } from './proc.js';
import { startFailure } from '../cli-adapter.js';

/**
 * The MCP bridge (design §3, U6/U7): the tool engine the gateway hands a tool request to on a CLI
 * leg whose toolMode is `mcp` or `auto` (src/tools/router.js), as `{ check, run }`.
 *
 * A CLI with a bridge driver (agy: agy.js; opencode, codex, qoder and — written, never run —
 * claude: clis.js) runs with one MCP server — the hub, through the shim —
 * whose tools are the request's own. The model calls one; the hub checks the call against the
 * client's schema; keysmith hands it to the client as a tool call (its own id, finish_reason
 * `tool_calls`) and the HTTP answer ends there, while the CLI process stays where it is, waiting
 * on its tools/call. The client runs the tool and comes back with the result in its next request:
 *
 *   continuation   the request's last assistant turn holds exactly the call that session waits
 *                  for, followed by its result and nothing else (a user turn after the result is
 *                  the cold path: agy takes a result while it waits, not a user turn), from the
 *                  same gateway key, to the same target, with the same tools and the same
 *                  system/user turns before it, and every call id of the conversation in the
 *                  order the session knows: the result goes to the CLI as the call's MCP result
 *                  (isError from the client's is_error), and what the CLI does next is that
 *                  request's answer — text, or its next call
 *   the same one   a second request for the continuation another one is answering: 409
 *   anything else  a new session, the conversation so far written into its prompt the EMULATE
 *                  way (earlier calls, fenced results): the cold path. A request whose session
 *                  is gone — expired, evicted, broken — comes this way, logged as late
 *
 * How the calls of one model step reach the client is the driver's (`batch`). agy, codex and qoder
 * run them one after another, so a step's second call reaches the hub after the first one's result
 * and is the next request's answer — one call per HTTP turn (`serial`; each call goes out once the
 * CLI's stream shows it, so text written before it goes first). opencode runs them at once
 * (`gather`): the calls that arrive within the driver's `settleMs` of each other go out in one
 * answer, and the next request brings all their results (a request with parallel_tool_calls false
 * is handed one, the rest in the requests after it). A continuation holds exactly the calls its
 * session waits for, each with its result.
 *
 * Nothing reaches the client before the CLI listed the bridge's tools (the readiness gate), so a
 * session that fails before that — an agent agy cannot find, a CLI that never connects, an exit —
 * fails before anything went out, and `auto` answers the same request with EMULATE. A CLI that
 * reaches for a tool of its own (anything but the bridge's, and the harness tool stopAtToolCall
 * knows) is stopped the moment its stream shows it, whatever its session is doing, and the
 * request it was answering — or the one that brings the result of the call it had handed out —
 * is a 502 that no other engine or leg of the route answers in its place: the tripwire.
 *
 * A turn (`timeoutMs`) is the CLI generating: from the start or from the result going back, to a
 * call handed out or the end. The adapter's process slot (`maxConcurrent`) is held for it and let
 * go while the client runs its tool, so waiting sessions never hold up agy's text requests. A
 * client that leaves in the middle of a turn stops the CLI; a turn that ended normally leaves the
 * session to the clock (hub.js), not to the request that started it.
 */

/** How long a call waits for the CLI's stream to show its step (and the usage before it) before it goes out anyway. */
export const STEP_GRACE_MS = 2_000;

export class McpBridge {
  /**
   * `limits`: the config's `limits.bridge` (`maxSessions`, `maxSessionsPerKey`, `socket`).
   * `adapters()`: the gateway's adapters, for the start-up sweep. The rest is for tests.
   */
  constructor({ limits = {}, log = () => {}, adapters = () => [], socketPath = null, timers = globalThis, now = Date.now, drivers = DRIVERS, killGraceMs = KILL_GRACE_MS, stepGraceMs = STEP_GRACE_MS, progressMs = undefined } = {}) {
    const l = isPlainObject(limits) ? limits : {};
    Object.assign(this, { log, adapters, drivers, timers, now, killGraceMs, stepGraceMs });
    this.hub = new Hub({
      socketPath: socketPath || (typeof l.socket === 'string' && l.socket ? path.resolve(expand(l.socket)) : path.join(dataDir(), 'run', 'bridge.sock')),
      maxSessions: count(l.maxSessions, HUB_DEFAULTS.maxSessions),
      maxSessionsPerKey: count(l.maxSessionsPerKey, HUB_DEFAULTS.maxSessionsPerKey),
      log,
      timers,
      now,
      ...(progressMs ? { progressMs } : {}),
    });
    this._listings = new WeakMap();
    this._swept = false;
  }

  /** Listen on the socket, and sweep what an earlier gateway's sessions left behind (once). */
  async start() {
    await this.hub.start();
    if (this._swept) return;
    this._swept = true;
    const keep = new Set([...this.hub.sessions.values()].map((s) => s.server));
    for (const adapter of this.adapters()) {
      const driver = this.driverFor(adapter);
      if (!driver) continue;
      try {
        const n = driver.sweep(adapter, { now: this.now(), keep });
        if (n) this.log(`bridge: removed ${n} agent file(s) and MCP schema dir(s) an earlier gateway's sessions left for ${adapter.id}`);
      } catch (e) {
        this.log(`bridge: sweeping ${adapter.id}'s leftovers failed: ${e.message}`);
      }
    }
  }

  /** Every session stopped, the socket closed. */
  close() {
    return this.hub.close();
  }

  driverFor(adapter) {
    return this.drivers.find((d) => d.supports(adapter)) || null;
  }

  /** An adapter's session limits: its `bridge.*` over SESSION_DEFAULTS. */
  limitsOf(adapter) {
    const b = isPlainObject(adapter?.bridge) ? adapter.bridge : {};
    const out = { ...SESSION_DEFAULTS };
    for (const k of Object.keys(SESSION_DEFAULTS)) if (Number.isFinite(b[k]) && b[k] > 0) out[k] = b[k];
    return out;
  }

  /** The tools/list of a request (mcp.js toolListing), once per request. */
  listing(spec) {
    let l = this._listings.get(spec);
    if (!l) {
      l = toolListing(spec.tools);
      this._listings.set(spec, l);
    }
    return l;
  }

  /**
   * Can the bridge take this request now? `{ ok: true }`, or `{ ok: false, reason, status?,
   * retryAfter? }` — the reason is the usage row's `fallback` when auto turns to EMULATE. A
   * continuation of a live session is always the bridge's.
   */
  check(adapter, spec, { messages = [], caller = '', target = '' } = {}) {
    const driver = this.driverFor(adapter);
    if (!driver) return { ok: false, reason: 'no_bridge' };
    // The older functions/function_call: the call goes out with no id and its result comes back
    // with none, so no later request could continue the session — every turn would leave an agy
    // waiting on a call nobody can answer, until its clock or the next eviction.
    if (spec.legacy) return { ok: false, reason: 'legacy', status: 400, why: 'the older functions/function_call carry no call id, so no later request could continue a session: send tools instead, or use toolMode emulate or auto' };
    const m = this.match(adapter, spec, messages, { caller, target });
    if (m.session) return { ok: true };
    // A session that gives up its place for the new one this request opens (maxTurns, a result with user text).
    if (m.retire) return { ok: true };
    // The result of a call whose run the tripwire stopped: the bridge's to refuse (run()).
    if (m.kind === 'tripped') return { ok: true };
    if (!namesFit(spec, driver.prefix('ks000000').length)) return { ok: false, reason: 'name_too_long' };
    try {
      this.listing(spec);
    } catch {
      return { ok: false, reason: 'schema_too_large' };
    }
    const room = this.hub.room({ adapterId: adapter.id, caller, adapterMax: this.limitsOf(adapter).maxSessions });
    if (!room.ok) return { ok: false, reason: room.reason, status: 503, retryAfter: room.retryAfter };
    return { ok: true };
  }

  /**
   * Which session a request belongs to: `{ kind: 'attach', session, results }` (it continues a
   * waiting session: `results` one `{ id, text, isError }` for each call out, in their order),
   * `{ kind: 'busy', session }` (another request is answering that very
   * continuation), `{ kind: 'tripped' }` (it brings the result of a call this key was handed by a
   * run the tripwire stopped), or `{ kind: 'new', why, late, retire? }` — `why` says why it
   * continues none (null for a conversation with no call in it: the only `new` that is not the
   * cold path), `late` that its session existed and is gone, `retire` the session of this very
   * conversation that gives way to the new one (`{ session, reason }`: run() closes it).
   */
  match(adapter, spec, messages, { caller = '', target = '' } = {}) {
    const tail = continuation(messages);
    if (!tail) return { kind: 'new', why: callIds(messages).length ? 'the request does not end in tool results' : null, late: false };
    const last = tail.ids[tail.ids.length - 1];
    const s = this.hub.sessionForCall(last);
    if (!s) {
      const t = this.hub.tombstone(last);
      // Another key's tombstone says nothing to this one: its request is a new one like any other.
      if (t?.reason === 'foreign_tool' && t.caller === caller) return { kind: 'tripped' };
      return { kind: 'new', why: t ? `its session is gone: ${t.reason}` : 'no live session', late: !!t };
    }
    // Another key's session: this request is a new one, and learns nothing about that one.
    if (s.caller !== caller) return { kind: 'new', why: 'no live session', late: false };
    const differs =
      s.adapterId !== adapter.id || s.target !== target ? 'the target changed'
      : s.toolsHash !== toolsHash(spec.tools) ? 'the tools changed'
      : s.prefixHash !== prefixHash(tail.before) ? 'the system or user turns changed'
      : !sameList(s.idSeq, callIds(messages)) ? 'the calls in the history changed'
      : null;
    if (differs) return { kind: 'new', why: differs, late: false };
    if (s.state === 'generating') return { kind: 'busy', session: s };
    if (s.state !== 'waiting' || !s.outs.length || !sameList(tail.ids, s.outs.map((o) => o.id))) return { kind: 'new', why: 'not the calls its session waits for', late: false };
    // One result for each call out, and none for a call it does not wait for.
    const results = [];
    for (const id of tail.ids) {
      const mine = tail.results.filter((r) => r.toolCallId === id);
      if (mine.length !== 1) return { kind: 'new', why: mine.length ? 'two results for one call' : 'no result for a call its session waits for', late: false };
      results.push({ id, text: String(mine[0].text ?? ''), isError: mine[0].isError === true });
    }
    if (tail.results.some((r) => !tail.ids.includes(r.toolCallId))) return { kind: 'new', why: 'a result for a call its session does not wait for', late: false };
    // The client's own words after the result: agy can be given the call's result, but not a user
    // turn while it waits on the call — and text put into the result would reach the model as a
    // tool's output, which it is told is data, not instructions. The conversation goes on, on a
    // new session that reads it all (run() closes this one).
    if (tail.extra.length) return { kind: 'new', why: "the result came with text of the user's", late: false, retire: { session: s, reason: 'user_text' } };
    // A session that handed out maxTurns calls has had its share: the conversation goes on, on a
    // new one (run() closes this one).
    if (s.turns >= s.limits.maxTurns) return { kind: 'new', why: `its session reached maxTurns (${s.limits.maxTurns})`, late: false, retire: { session: s, reason: 'max_turns' } };
    return { kind: 'attach', session: s, results };
  }

  /**
   * One HTTP turn on the bridge: a `bridge` event first (which session, how it was reached), then
   * text as it comes, and either a `tool_call` (keysmith's id for `face`) with `done` tool_calls,
   * or the end of the answer — each with the usage of the CLI's steps in this turn. A failure
   * before anything of the answer is thrown with `fallbackReason` (the usage row's `fallback`
   * when auto runs EMULATE instead) and `noFallback` where nothing else may answer.
   */
  async *run(adapter, { model, spec, messages, signal = null, caller = '', target = '', face = 'openai' } = {}) {
    const driver = this.driverFor(adapter);
    if (!driver) throw bridgeError(adapter, 'no_bridge', 503, `adapter "${adapter.id}" has no MCP bridge driver`);
    target ||= `${adapter.id}/${model}`;
    const m = this.match(adapter, spec, messages, { caller, target });
    if (m.kind === 'busy') {
      // The CLI is answering this continuation for another request: two answers to one call are
      // one too many, and no other leg should make a second either.
      throw Object.assign(bridgeError(adapter, 'busy', 409, `bridge ${m.session.server}: this conversation's last tool result is being answered by another request right now`, { noFallback: true, routeEnd: true }), { type: 'invalid_request_error' });
    }
    if (m.kind === 'tripped') {
      // The run that made this call reached for a tool of its own while the client ran it (the
      // tripwire stopped it then): the result goes nowhere, and no other engine or leg carries the
      // conversation on in its place — for as long as the call's tombstone lives.
      throw bridgeError(adapter, 'foreign_tool', 502, `bridge: the session this tool result belongs to was stopped when ${adapter.id} reached for a tool of its own (the tripwire); the conversation is not carried on`, { noFallback: true, routeEnd: true });
    }
    const o = { model, spec, messages, signal, caller, target, face };
    if (m.kind === 'attach') {
      yield* this._attach(adapter, driver, m.session, m.results, o);
      return;
    }
    if (m.retire) {
      const { session: old, reason } = m.retire;
      this.log(
        reason === 'max_turns'
          ? `bridge ${old.server}: closed at maxTurns (${old.limits.maxTurns} calls); the conversation goes on on a new session`
          : `bridge ${old.server}: closed: the result came with text of the user's, which ${adapter.id} cannot be given while it waits on a call; the conversation goes on on a new session (the cold path)`,
      );
      old.close(reason);
    }
    if (m.late) this.log(`bridge: a late result for ${target} (${m.why}); it runs on a new session with the conversation so far (the cold path)`);
    yield* this._open(adapter, driver, { ...o, why: m.why });
  }

  async *_open(adapter, driver, o) {
    adapter.ready();
    const prompt = renderPrompt({ spec: null, messages: o.messages });
    if (prompt.length > adapter.maxPromptChars) {
      throw bridgeError(adapter, 'prompt_too_long', 400, `adapter "${adapter.id}": the conversation is ${prompt.length} chars, over maxPromptChars=${adapter.maxPromptChars}. Trim history, or raise the cap on this adapter.`, { noFallback: true });
    }
    try {
      await this.start();
    } catch (e) {
      throw bridgeError(adapter, 'bridge_unavailable', 503, `the MCP bridge cannot listen: ${e.message}`);
    }
    const limits = this.limitsOf(adapter);
    // The slot first, then room and the session in one step: no other request opens one in between.
    const release = await adapter.acquire(o.signal);
    let s = null;
    try {
      const room = this.hub.room({ adapterId: adapter.id, caller: o.caller, adapterMax: limits.maxSessions });
      if (!room.ok) throw Object.assign(bridgeError(adapter, room.reason, 503, `the MCP bridge has no room for another session of ${adapter.id}`), { retryAfter: String(room.retryAfter) });
      for (const old of room.evict) {
        this.log(`bridge ${old.server}: closed to make room for a new session of the same key (maxSessionsPerKey)`);
        old.close('evicted');
      }
      s = this.hub.open({
        adapterId: adapter.id,
        caller: o.caller,
        target: o.target,
        tools: o.spec.tools,
        listing: this.listing(o.spec),
        toolsHash: toolsHash(o.spec.tools),
        prefixHash: prefixHash(o.messages),
        idSeq: callIds(o.messages),
        limits,
        prefix: (server) => driver.prefix(server),
      });
      // The cleanup first: a spawn that fails after the session's files were written leaves none.
      const opened = s;
      s.onClose(async () => {
        await opened.proc?.stop('session closed');
        driver.cleanup(adapter, opened);
      });
      const proc = driver.spawn(adapter, { session: s, model: o.model, prompt, killGraceMs: this.killGraceMs });
      s.proc = proc;
      this._pump(adapter, driver, s, proc);
    } catch (e) {
      release();
      s?.close('spawn_failed');
      // No room (503), a workspace file that cannot be written (500), a CLI that cannot be started
      // (502): as they are. A request no command line can carry (400) is refused by EMULATE on the
      // same CLI too, so auto does not ask it.
      if (e instanceof LlmError) throw Object.assign(e, { fallbackReason: e.fallbackReason || (e.status === 400 ? 'invalid_request' : 'spawn_failed') }, e.status === 400 ? { noFallback: true } : {});
      // Its code, never its message: an error from starting a process can quote the argv, the prompt in it.
      throw bridgeError(adapter, 'spawn_failed', 502, `bridge: could not start ${adapter.id} (${startFailure(e)})`);
    }
    this.log(`bridge ${s.server}: opened for ${o.target}${o.why ? `, with the conversation so far (${o.why})` : ''}`);
    yield* this._turn(adapter, driver, s, { ...o, release, info: { type: 'bridge', session: s.server, path: o.why ? 'cold' : 'new', turn: 1 } });
  }

  async *_attach(adapter, driver, s, results, o) {
    const size = results.reduce((n, r) => n + r.text.length, 0);
    if (size > adapter.maxPromptChars) {
      throw bridgeError(adapter, 'result_too_long', 400, `adapter "${adapter.id}": the tool result${results.length > 1 ? 's are' : ' is'} ${size} chars, over maxPromptChars=${adapter.maxPromptChars}`, { noFallback: true });
    }
    // Claimed now, before the wait for a process slot: a second request for the same result is a 409.
    s.attach();
    let release;
    try {
      release = await adapter.acquire(o.signal);
    } catch (e) {
      s.close('abandoned');
      throw e;
    }
    // A session closed while this request waited for its slot (the tripwire, its clock) is told
    // nothing: the turn below reads why it closed.
    if (!s.closed) {
      const n = results.length;
      s.answer(results);
      this.log(`bridge ${s.server}: ${n > 1 ? `the results of ${n} calls` : `the result of ${s.turns === 1 ? 'its call' : `call ${s.turns}`}`} went back to ${adapter.id}`);
    }
    yield* this._turn(adapter, driver, s, { ...o, release, info: { type: 'bridge', session: s.server, path: 'attached', turn: s.rounds + 1 } });
  }

  /**
   * The CLI's events into its session, then how it ended. The tripwire is here, where the events
   * arrive, so it acts whatever the session is doing — a turn reading it, a call with the client,
   * a result waiting for a process slot: a tool that is neither the bridge's nor one the harness
   * keeps (manage_task) closes the session at once.
   */
  async _pump(adapter, driver, s, proc) {
    try {
      for await (const evt of proc.events) {
        if (evt.type === 'tool' && isForeign(driver, s, evt.name)) {
          this._tripwire(adapter, s, evt.name);
          continue;
        }
        s.push(evt);
      }
    } catch (e) {
      s.push({ type: 'error', message: `the CLI's output could not be read: ${e.message}` });
    }
    s.push({ type: 'exit', ...(await proc.done) });
  }

  /**
   * The CLI reached for a tool of its own: a security event (design §3). The session is closed now —
   * the CLI stopped, its files removed, its calls tombstoned `foreign_tool` — and logged. The
   * request reading it, if one is, fails with the tripwire's 502; a call that was with the client
   * leaves its result nowhere to go (match(): `tripped`). Neither is answered another way.
   */
  _tripwire(adapter, s, name) {
    if (s.closed) return;
    s.foreign = truncate(String(name || ''), 60);
    const when = s.state === 'waiting' ? ' while its call was with the client' : '';
    this.log(`bridge ${s.server}: SECURITY: ${adapter.id} reached for a tool of its own ("${s.foreign}")${when}, which is not one of the bridge's; the run was stopped (foreign tool)`);
    s.close('foreign_tool');
  }

  async *_turn(adapter, driver, s, { signal, release, face, info, spec = null }) {
    const t = this.timers;
    const self = this;
    let usage = null;
    let text = false;
    let cut = null;
    let batch = []; // the calls of this turn not yet handed out (one at most on a serial driver)
    let grace = null;
    let settle = null;
    const gather = driver.batch === 'gather';
    let delivered = false;
    let ended = null;
    const held = []; // text before the CLI listed the tools
    const errors = [];
    // This turn's own timer events carry its number: one that fired as the last turn ended is
    // still in the inbox, and is not this turn's.
    const turn = (s.turnSeq = (s.turnSeq || 0) + 1);
    const gen = t.setTimeout(() => s.push({ type: 'gen_timeout', turn }), adapter.timeoutMs);
    gen?.unref?.();
    const onAbort = () => s.push({ type: 'abort', turn });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const fail = (reason, status, message, extra = {}) => bridgeError(adapter, reason, status, `bridge ${s.server}: ${message}`, { usage, ...extra });
    const handOut = function* () {
      if (grace) t.clearTimeout(grace);
      if (settle) t.clearTimeout(settle);
      grace = settle = null;
      // A request with parallel calls off is handed one call; the others wait in the inbox, in
      // their order, for the requests after it.
      const take = spec?.parallel === false ? batch.slice(0, 1) : batch;
      for (const rest of batch.slice(take.length).reverse()) s.inbox.unshift(rest);
      batch = [];
      const outs = take.map((c) => ({ id: newToolCallId(face), mcpId: c.mcpId, name: c.name, args: c.args }));
      // Waiting from here: a consumer that stops reading at any event below leaves the session to its clock.
      s.hold(outs);
      const names = outs.map((o) => truncate(o.name, 64)).join(', ');
      self.log(`bridge ${s.server}: ${outs.length > 1 ? `calls ${s.turns - outs.length + 1}-${s.turns}` : `call ${s.turns}`} (${names}) handed to the client`);
      if (usage) yield { type: 'usage', usage };
      for (const o of outs) yield { type: 'tool_call', id: o.id, name: o.name, arguments: JSON.stringify(o.args), args: o.args };
      delivered = true;
      yield { type: 'done', finishReason: 'tool_calls' };
    };
    try {
      yield info;
      for (;;) {
        const evt = await s.next();
        // The tripwire fired (_tripwire): nothing queued before it goes out — no text, no call — and
        // the request is the 502 of a security event, never answered by EMULATE or another leg.
        if (s.foreign) throw fail('foreign_tool', 502, `${adapter.id} reached for a tool of its own ("${s.foreign}"), not one of the request's; the run was stopped`, { noFallback: true, routeEnd: true });
        const type = evt.type;
        if (evt.turn !== undefined && evt.turn !== turn) continue;
        if (type === 'delta' || type === 'reasoning') {
          if (cut) continue;
          // The readiness gate: nothing goes out before the CLI listed the bridge's tools.
          if (!s.gateOpen) held.push(evt);
          else {
            if (type === 'delta' && evt.text) text = true;
            yield evt;
          }
        } else if (type === 'ready') {
          s.gateOpen = true;
          for (const h of held.splice(0)) {
            if (h.type === 'delta' && h.text) text = true;
            yield h;
          }
        } else if (type === 'usage') {
          usage = addUsage(usage, evt.usage);
        } else if (type === 'tool') {
          const name = String(evt.name || '');
          if (name.startsWith(driver.prefix(s.server))) {
            // The stream shows a call to the bridge as it is made (agy's tool step, codex's
            // item.started, qoder's tool_use block). opencode reports a call only once it has
            // finished: nothing to count there.
            if (!gather) {
              s.steps = (s.steps || 0) + 1;
              if (batch.length && s.steps >= s.taken) return yield* handOut();
            }
          } else if (driver.harnessTools.includes(name)) {
            // A tool the harness keeps that runs nothing (agy's manage_task, which no agent file
            // removes; opencode's invalid; qoder's mcp_get): after text the answer is complete
            // (stopAtToolCall); before, it does nothing (agy's headless mode refuses manage_task)
            // and the model goes on.
            if (adapter.stopAtToolCall && text && !cut) {
              cut = name;
              s.proc?.stop(`answer complete, stopped at a call to ${name}`);
              yield { type: 'cut', reason: 'tool_call', tool: name };
            }
          } else {
            // _pump stops a foreign tool before it reaches the inbox; one that got here all the same
            // is the same event: the session closes, and the next event read is the 502.
            this._tripwire(adapter, s, name);
          }
        } else if (type === 'call') {
          if (cut) continue;
          if (!gather) {
            if (batch.length) {
              // A second call before the first one's step: the first goes out, this one is the next turn's.
              s.inbox.unshift(evt);
              return yield* handOut();
            }
            s.taken = (s.taken || 0) + 1;
            batch.push(evt);
            if ((s.steps || 0) >= s.taken) return yield* handOut();
            grace = t.setTimeout(() => s.push({ type: 'grace', turn }), this.stepGraceMs);
            grace?.unref?.();
            continue;
          }
          // Gathering: counted once (a call handed back to the inbox by parallel false is not new),
          // then the step's calls settle: they go out `settleMs` after the last one came, or at
          // the latest STEP_GRACE_MS after the first.
          if (!evt.counted) {
            evt.counted = true;
            s.taken = (s.taken || 0) + 1;
          }
          batch.push(evt);
          if (settle) t.clearTimeout(settle);
          settle = t.setTimeout(() => s.push({ type: 'settle', turn }), driver.settleMs);
          settle?.unref?.();
          if (!grace) {
            grace = t.setTimeout(() => s.push({ type: 'grace', turn }), this.stepGraceMs);
            grace?.unref?.();
          }
        } else if (type === 'settle') {
          settle = null;
          if (batch.length) return yield* handOut();
        } else if (type === 'grace') {
          if (batch.length) return yield* handOut();
        } else if (type === 'invalid') {
          s.taken = (s.taken || 0) + 1;
          this.log(`bridge ${s.server}: a call ${evt.name ? `to ${truncate(evt.name, 64)}` : 'to a tool the request does not offer'} did not fit the client's schema (${evt.count} of ${MAX_INVALID_CALLS} this turn): ${truncate(evt.reason, 160)}`);
          if (evt.count >= MAX_INVALID_CALLS) throw fail('invalid_calls', 502, `the model made ${evt.count} calls in one turn that the client's schemas refuse`);
        } else if (type === 'error') {
          errors.push(evt);
        } else if (type === 'exit') {
          if (!s.mcp.ready) {
            throw fail(driver.notReadyReason(evt), 502, `${adapter.id} ${evt.code === 0 ? 'ended' : `exited ${evt.code}`} before it listed the bridge's tools: ${truncate(evt.stderr || 'no output', 200)}`);
          }
          const failure = errors.find((e) => e.code !== 'tool_denied') || errors[0] || null;
          if (cut || (!failure && evt.code === 0)) {
            if (usage) yield { type: 'usage', usage };
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
          const why = failure ? failure.message : `${adapter.id} exited ${evt.code}${evt.killed ? ' (killed)' : ''}: ${truncate(evt.stderr || 'no output', 200)}`;
          if (!text) throw fail(failure?.code || 'cli_error', 502, why);
          if (usage) yield { type: 'usage', usage };
          yield { type: 'error', message: why };
          return;
        } else if (type === 'ready_timeout') {
          throw fail('ready_timeout', 502, `${adapter.id} did not list the bridge's tools within readyTimeoutMs (${s.limits.readyTimeoutMs} ms)`);
        } else if (type === 'gen_timeout') {
          throw fail('timeout', 504, `no answer or call within timeoutMs (${adapter.timeoutMs} ms)`, { retriable: true });
        } else if (type === 'session_max') {
          throw fail('session_max', 504, `the session reached sessionMaxMs (${s.limits.sessionMaxMs} ms)`);
        } else if (type === 'broken') {
          throw fail(evt.reason || 'broken', 502, evt.reason === 'cancelled' ? `${adapter.id} cancelled the call it was waiting on` : `${adapter.id}'s MCP connection dropped`);
        } else if (type === 'abort') {
          // What the turn spent before the client left is spent all the same: it rides on the error.
          throw bridgeError(adapter, 'client_left', 499, `adapter "${adapter.id}": client disconnected`, { usage });
        } else if (type === 'closed' || type === 'expired') {
          throw fail(evt.reason || 'closed', evt.reason === 'shutdown' ? 503 : 502, `the session was closed (${evt.reason || 'closed'})`);
        }
        // `session` and `done` are the CLI's own: how the run ended is its exit.
      }
    } catch (e) {
      ended = e?.fallbackReason || 'failed';
      throw e;
    } finally {
      t.clearTimeout(gen);
      if (grace) t.clearTimeout(grace);
      if (settle) t.clearTimeout(settle);
      signal?.removeEventListener('abort', onAbort);
      release();
      if (!(s.state === 'waiting' && delivered)) {
        if (s.state === 'waiting') ended = 'abandoned';
        s.close(ended || 'done');
      }
    }
  }
}

/* -------------------------------------------------------------------- conversations */

/**
 * The tail of a request that may continue a session: the tool results after the last assistant
 * turn that made calls (`ids`, in that turn's order), what came before that turn, and the user
 * turns after the results (`extra`: a Messages API user turn that holds tool_result blocks and
 * then text, which reads as the results and a user turn; a user message after the tool
 * messages). Null when the request does not end in tool results, or in tool results and user
 * turns.
 */
export function continuation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let i = list.length - 1;
  const extra = [];
  while (i >= 0 && list[i]?.role === 'user') extra.unshift(list[i--]);
  const results = [];
  while (i >= 0 && list[i]?.role === 'tool') results.unshift(list[i--]);
  if (!results.length || i < 0 || list[i]?.role !== 'assistant' || !list[i].toolCalls?.length) return null;
  return { ids: list[i].toolCalls.map((c) => c.id), results, before: list.slice(0, i), extra };
}

/** Every call id of a conversation, in order. */
export function callIds(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((m) => (m?.role === 'assistant' && m.toolCalls?.length ? m.toolCalls.map((c) => c.id) : []));
}

/** The system and user turns of a conversation, hashed: what a continuation must not have changed. */
export function prefixHash(messages) {
  const turns = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'system' || m?.role === 'user').map((m) => [m.role, String(m.text ?? '')]);
  return createHash('sha256').update(JSON.stringify(turns)).digest('hex');
}

/** A request's tools, hashed: name, description and schema, as sent. */
export function toolsHash(tools) {
  return createHash('sha256').update(JSON.stringify((tools || []).map((t) => [t.name, t.description ?? '', t.parameters ?? null]))).digest('hex');
}

/** A tool in the CLI's stream that is neither the bridge's (`mcp_<server>_…`) nor one its harness keeps: the tripwire's. */
function isForeign(driver, s, name) {
  const n = String(name || '');
  return !n.startsWith(driver.prefix(s.server)) && !driver.harnessTools.includes(n);
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function count(v, fallback) {
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * A bridge failure: `fallbackReason` (the usage row's `failure`, and its `fallback` when auto runs
 * EMULATE instead), `noFallback` (EMULATE does not answer in its place), `routeEnd` (no other leg
 * of the route does either: gateway._toolWalk), and what the turn spent (`usage`).
 */
function bridgeError(adapter, reason, status, message, { noFallback = false, routeEnd = false, usage = null, retriable = false } = {}) {
  const e = new LlmError(message, { status, provider: adapter.id, retriable });
  e.fallbackReason = reason;
  if (noFallback) e.noFallback = true;
  if (routeEnd) e.routeEnd = true;
  if (usage) e.usage = usage;
  return e;
}
