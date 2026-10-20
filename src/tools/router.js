import { LlmError } from '../util.js';
import { emulate, renderPrompt } from './emulate.js';

/**
 * Tool routing (design §4, U4): which leg of a route takes a request that offers tools, and how.
 *
 * A route is walked in the order it was declared, as it always is:
 *
 *   an HTTP upstream on the openai wire   the body goes up verbatim (`passthrough`), on the chat face
 *   a CLI with toolMode other than off    a tool engine answers: EMULATE (emulate.js) or the MCP bridge
 *   anything else                         cannot answer with a tool call: left for the plain completion
 *
 * A leg that fails before anything reached the client hands the request to the next one, the
 * gateway's failover rule; a tool call handed to the client counts as an answer. When no leg
 * answered, the route still answers a request whose tool_choice is `auto` or `none` as a plain
 * completion from the legs it did not try (logged, as before); one whose tool_choice asks for a
 * call (`required`, a named tool) is an error — never a text answer in its place — and so is a
 * request offering a tool no CLI can honour (`unsupported`: custom and server tools).
 *
 * toolMode, per CLI adapter:
 *
 *   off      (absent)  never takes a tool request: the route's behaviour from before toolMode
 *   emulate            EMULATE always
 *   mcp                the MCP bridge always; a 503 when it is not there or full, a 400 for a
 *                      tool_choice it cannot honour (MCP cannot make a model call a tool)
 *   auto               the bridge where it can, EMULATE otherwise — and EMULATE in the same
 *                      request when the bridge fails before any call reached the client
 *
 * auto, in order: tool_choice `none` is a plain completion of the history (rendered the EMULATE
 * way, so earlier calls and results read as what they are); `required` or a named tool is
 * EMULATE; a bridge that is absent, full, or cannot carry the tool names is EMULATE, with the
 * reason in the usage row (`fallback`); otherwise the bridge. Both engines run the CLI without
 * tools of its own; neither runs a tool: every call goes back to the client.
 *
 * There is no race mode (both engines at once): it would spend the CLI's quota twice per turn
 * for an answer the fallback gives anyway (design §4, "Sadece yedek").
 */

export const TOOL_MODES = ['off', 'emulate', 'mcp', 'auto'];

/**
 * A CLI entry's toolMode: 'off' when it has none. A value that is not a mode, any mode but off on
 * an adapter marked `unsafeTools` — a CLI that kept its own tools never answers a tool request —
 * and any mode but off on an entry without a `cwd` are load errors. A tool engine runs the CLI in
 * an empty workspace keysmith owns (design §5): without a configured cwd it would run in the
 * gateway's own directory, read whatever project config is there (an opencode.json, an
 * AGENTS.md, an agent of agy's), and the bridge would write its session file into it.
 */
export function checkToolMode(id, cfg) {
  const mode = cfg?.toolMode;
  if (mode === undefined || mode === null) return 'off';
  if (!TOOL_MODES.includes(mode)) throw new Error(`adapter "${id}": toolMode must be one of ${TOOL_MODES.join(', ')} — got ${JSON.stringify(mode)?.slice(0, 40)}`);
  if (mode !== 'off' && cfg.unsafeTools) {
    throw new Error(`adapter "${id}": toolMode ${mode} on an adapter marked unsafeTools — a CLI that kept its own tools could act on a tool request itself; set toolMode off`);
  }
  if (mode !== 'off' && !cfg.cwd) {
    throw new Error(`adapter "${id}": toolMode ${mode} needs a configured cwd — a tool request runs the CLI only in an empty workspace keysmith owns, never in the gateway's own directory (keysmith add <profile> --as ${id} brings one)`);
  }
  return mode;
}

/**
 * How `adapter` takes a tool request that came through `face` ('openai': /v1/chat/completions,
 * 'anthropic': /v1/messages): 'passthrough', 'engine' or 'skip'.
 */
export function toolPath(adapter, spec, face) {
  if (adapter.kind === 'http') {
    // Verbatim is the only way an HTTP leg takes tools, and only the chat face has a body an
    // OpenAI-wire upstream reads as it is.
    return face === 'openai' && (adapter.wire || 'openai') === 'openai' ? 'passthrough' : 'skip';
  }
  const mode = adapter.toolMode || 'off';
  if (mode === 'off') return 'skip';
  // A custom tool, an Anthropic server tool, a tool_choice keysmith cannot read: a CLI has no way
  // to honour them, and dropping them would answer a different request.
  if (spec.unsupported?.length) return 'skip';
  return 'engine';
}

/**
 * Which engine runs a tool request on a CLI leg: `{ engine: 'plain' | 'emulate' | 'mcp',
 * fallback? }`, or a thrown LlmError when this leg cannot take it (the route moves on).
 * `mcp` is the bridge (src/bridge/index.js; null when no adapter has one): `check(adapter, spec,
 * ctx)` says whether it can take this request now — `{ ok: true }` or `{ ok: false, reason,
 * status?, retryAfter? }`. `ctx` (`messages`, `caller`, `target`) lets it see a request that
 * continues one of its sessions, which is always the bridge's.
 */
export function pickEngine(adapter, spec, mcp, ctx = {}) {
  const mode = adapter.toolMode || 'off';
  const choice = spec.choice?.mode || 'auto';
  if (choice === 'none') return { engine: 'plain' };
  if (mode === 'emulate') return { engine: 'emulate' };
  const forced = choice === 'required' || choice === 'named';
  if (mode === 'mcp') {
    if (forced) {
      throw new LlmError(`adapter "${adapter.id}" takes tools over MCP (toolMode mcp), which cannot make a model call a tool: tool_choice ${choice} needs toolMode emulate or auto`, {
        status: 400,
        type: 'invalid_request_error',
        provider: adapter.id,
      });
    }
    if (!mcp) throw new LlmError(`adapter "${adapter.id}": toolMode mcp, and this keysmith has no MCP bridge — set toolMode emulate or auto`, { status: 503, provider: adapter.id });
    const c = mcp.check(adapter, spec, ctx);
    if (!c.ok) {
      const e = new LlmError(`adapter "${adapter.id}": the MCP bridge cannot take this request (${c.reason})`, { status: c.status || 503, provider: adapter.id });
      if (c.retryAfter) e.retryAfter = String(c.retryAfter);
      throw e;
    }
    return { engine: 'mcp' };
  }
  // auto
  if (forced) return { engine: 'emulate' };
  if (!mcp) return { engine: 'emulate', fallback: 'no_bridge' };
  const c = mcp.check(adapter, spec, ctx);
  if (!c.ok) return { engine: 'emulate', fallback: c.reason || 'bridge_refused' };
  return { engine: 'mcp' };
}

/**
 * The events of one CLI leg answering a tool request: the engine pickEngine chose, with a
 * `tool_mode` event (which engine, and why not the one auto picks first) in front of its first
 * answer event. `state.mode` follows the engine as it starts, for a header written before the
 * answer is known. In auto, a bridge that fails before any call or text went out hands the same
 * request to EMULATE — unless the failure is one that must never be retried another way
 * (`noFallback`: the bridge's foreign-tool tripwire is a security event, not a slow engine; a
 * 409 for a result another request is answering).
 *
 * The bridge is told who asks (`caller`, the gateway key's hash), for which leg (`target`) and
 * on which face (`face`: the ids it hands out are that face's); its `bridge` event (which
 * session, reached how) rides on the `tool_mode` event, for the usage row.
 *
 * A failure says which engine failed (`toolMode`, and `fallback` when it was not auto's first
 * pick) next to what the engine spent (`usage`, `retries`: emulate.js), for the usage row.
 */
export async function* toolEvents({ adapter, model, target = null }, { spec, messages, plain, signal, includeReasoning = false, maxTokens, state = null, mcp = null, log = () => {}, caller = '', face = 'openai' }) {
  const ctx = { messages, caller, target: target || `${adapter.id}/${model}` };
  const pick = pickEngine(adapter, spec, mcp, ctx);
  if (pick.engine === 'plain') {
    // tool_choice none: the model may not call a tool, so the CLI answers in text — with the
    // history (earlier calls, fenced results) rendered the EMULATE way, and no session resumed.
    if (state) state.mode = 'emulate';
    const rendered = { system: '', prompt: renderPrompt({ spec, messages }) };
    const events = adapter.complete({ model, messages: plain, session: null, signal, maxTokens, includeReasoning, rendered });
    yield* withMode(dropSessions(events), 'emulate', null);
    return;
  }
  let fallback = pick.fallback || null;
  let carried = null;
  if (pick.engine === 'mcp') {
    if (state) state.mode = 'mcp';
    const held = [];
    let started = false;
    let bridge = null;
    const said = () => ({ type: 'tool_mode', mode: 'mcp', ...(bridge ? { bridge } : {}) });
    try {
      for await (const evt of mcp.run(adapter, { model, spec, messages, signal, includeReasoning, ...ctx, face })) {
        if (evt.type === 'bridge') {
          bridge = { session: evt.session, path: evt.path, turn: evt.turn };
          continue;
        }
        // An error before any answer is the bridge failing, whether it threw or said so.
        if (!started && evt.type === 'error') throw Object.assign(new LlmError(evt.message, { status: 502, provider: adapter.id }), { fallbackReason: evt.code || null, noFallback: !!evt.noFallback });
        if (!started && evt.type !== 'delta' && evt.type !== 'tool_call') {
          held.push(evt);
          continue;
        }
        if (!started) {
          started = true;
          yield said();
          yield* held.splice(0);
        }
        yield evt;
      }
      if (!started) {
        yield said();
        yield* held.splice(0);
      }
      return;
    } catch (e) {
      // What the bridge's run spent is spent: it goes into EMULATE's usage, or onto the error. The
      // bridge reports a turn's spend on its failure (`usage`: every model step of the turn so
      // far), or in a usage event before it: two reports of one turn, so per field the larger
      // (the gateway's rule for one run), never their sum.
      for (const evt of held) if (evt.type === 'usage') carried = sumUsage(carried, evt.usage);
      if (e && typeof e === 'object' && e.usage) carried = maxUsage(carried, e.usage);
      if (started || (adapter.toolMode || 'off') !== 'auto' || signal?.aborted || e?.noFallback) {
        if (carried && e && typeof e === 'object') e.usage = carried;
        throw engineFailed(e, 'mcp', fallback);
      }
      fallback = typeof e?.fallbackReason === 'string' && e.fallbackReason ? e.fallbackReason.slice(0, 40) : 'bridge_failed';
      log(`${adapter.id}/${model}: the MCP bridge failed before any call (${fallback}: ${String(e?.message || e).slice(0, 160)}); this request runs as EMULATE`);
    }
  }
  if (state) state.mode = 'emulate';
  yield* withMode(emulate(adapter, { model, spec, messages, signal, carried }), 'emulate', fallback);
}

/** `tool_mode` in front of the first event that is part of the answer (or its end); a failure marked with the engine's mode. */
async function* withMode(events, mode, fallback) {
  let said = false;
  try {
    for await (const evt of events) {
      if (!said && !['reasoning', 'retry', 'cut'].includes(evt.type)) {
        said = true;
        yield { type: 'tool_mode', mode, ...(fallback ? { fallback } : {}) };
      }
      yield evt;
    }
  } catch (e) {
    throw engineFailed(e, mode, fallback);
  }
}

/** `e`, marked with the engine that failed (and why it was not auto's first pick). */
function engineFailed(e, mode, fallback) {
  if (!e || typeof e !== 'object') return e;
  e.toolMode ??= mode;
  if (fallback) e.fallback ??= fallback;
  return e;
}

async function* dropSessions(events) {
  for await (const evt of events) if (evt.type !== 'session') yield evt;
}

function sumUsage(a, b) {
  if (!b) return a;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = (out[k] || 0) + v;
  return out;
}

function maxUsage(a, b) {
  if (!b) return a;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = Math.max(out[k] || 0, v);
  return out;
}

/**
 * Whether every tool name still fits a model's function-name limit behind a bridge's prefix
 * (agy shows a bridge tool as `mcp_ks<rid6>_<tool>`, and Gemini takes at most 64 characters).
 * For a bridge's `check`: a name that does not fit is EMULATE's (`name_too_long`).
 */
export function namesFit(spec, prefixLength, max = 64) {
  return (spec.tools || []).every((t) => prefixLength + String(t.name).length <= max);
}

/** The unsupported entries of a spec, named for an error message (no more than four). */
export function describeUnsupported(spec) {
  const list = (spec.unsupported || []).map((u) => (u.name ? `${u.type} "${String(u.name).slice(0, 40)}"` : u.reason ? `${u.type} (${u.reason})` : u.type));
  return list.slice(0, 4).join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
}
