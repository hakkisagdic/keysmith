import { deref, validateCall } from '../tools/jsonschema.js';
import { isPlainObject } from '../tools/model.js';

/**
 * The MCP server side of the bridge (design §3, U6): one per bridge session, JSON-RPC 2.0 over
 * newline-delimited JSON — what the CLI's MCP client sends through the shim, as it sent it.
 *
 * It answers what an MCP client asks before it can call a tool, and turns a tool call into a call
 * the hub hands to the HTTP client:
 *
 *   server/discover, any unknown method   -32601 (agy 1.4.2 asks server/discover first, and moves
 *                                          on to initialize when it is refused: seen in its probe)
 *   initialize                            the client's protocol version when it is one of
 *                                          PROTOCOL_VERSIONS, the latest otherwise; tools only,
 *                                          listChanged false
 *   notifications/initialized, ping       noted, answered
 *   tools/list                            the request's tools, their schemas written out (deref);
 *                                          the first one answered is the session being ready
 *   tools/call                            checked against the client's own schema: a call that
 *                                          fits waits for the client's result (`call`), one that
 *                                          does not is answered at once with isError and the
 *                                          reason, so the model can correct itself (`invalid`)
 *   notifications/cancelled               for a call that is waiting: the session is broken
 *
 * Nothing here runs a tool. A call's arguments and result pass through, and are never put in an
 * event a log line is made of: an `invalid` event carries the validator's reason, which names a
 * place and a type, never a value.
 */

export const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

/** A turn whose model made this many calls the client's schemas refuse is a failed turn. */
export const MAX_INVALID_CALLS = 3;

/**
 * Arguments a harness adds to every tool it shows its model: agy 1.4.2 shows an MCP tool's
 * parameters with `toolSummary` (and its own tools with `toolAction`) next to the server's own
 * (read off a probe in which the model listed its tools). They are taken off a call before it is
 * checked, unless the client's own schema has a property of that name.
 */
export const INJECTED_ARGS = ['toolSummary', 'toolAction'];

const METHOD_NOT_FOUND = -32601;

/**
 * A request's tools as an MCP tools/list: each schema with its local $refs written out (deref:
 * a CLI that lists them may not follow one; ucmdb's pydantic schemas are full of them), as the
 * object schema MCP asks for. A call is still checked against the schema as the client sent it.
 * Throws when one is too large written out (ERR_SCHEMA_TOO_LARGE): such a request is EMULATE's.
 */
export function toolListing(tools) {
  return (tools || []).map((t) => ({ name: t.name, description: t.description || '', inputSchema: objectSchema(deref(t.parameters)) }));
}

function objectSchema(s) {
  if (!isPlainObject(s)) return { type: 'object' };
  return s.type === undefined ? { type: 'object', ...s } : s;
}

export class McpServer {
  /**
   * `tools`: the ToolSpec's list (a call is checked against these schemas, as the client sent
   * them). `listing`: the tools/list entries. `prefix`: the name the CLI shows its model for this
   * server's tools (`mcp_ks<rid6>_`), taken off a call's name that carries it. `send(msg)` writes
   * one message to the client; `emit(evt)` hands an event to the session.
   */
  constructor({ tools = [], listing = [], prefix = '', send = () => {}, emit = () => {}, serverInfo = { name: 'keysmith-bridge', version: '1' } } = {}) {
    Object.assign(this, { tools, listing, prefix, send, emit, serverInfo });
    this.ready = false;
    this.initialized = false;
    this.version = null;
    this.invalid = 0; // calls refused in this turn
    this.awaiting = new Map(); // key(mcp id) -> { id, progressToken, progress }
  }

  /** One message from the client. */
  handle(msg) {
    // A response (keysmith asks the client nothing) or something that is not JSON-RPC at all.
    if (!isPlainObject(msg) || typeof msg.method !== 'string') return;
    const request = isId(msg.id);
    const params = isPlainObject(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        if (!request) return;
        const asked = params.protocolVersion;
        this.version = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
        return this._result(msg.id, { protocolVersion: this.version, capabilities: { tools: { listChanged: false } }, serverInfo: this.serverInfo });
      }
      case 'notifications/initialized':
        this.initialized = true;
        return;
      case 'ping':
        if (request) this._result(msg.id, {});
        return;
      case 'tools/list':
        if (!request) return;
        this._result(msg.id, { tools: this.listing });
        if (!this.ready) {
          this.ready = true;
          this.emit({ type: 'ready' });
        }
        return;
      case 'tools/call':
        if (request) this._call(msg.id, params);
        return;
      case 'notifications/cancelled':
        return this._cancelled(params);
      default:
        // server/discover among them: agy takes the refusal and goes on with initialize.
        if (request) this.send({ jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${String(msg.method).slice(0, 64)}` } });
    }
  }

  /** The client's result for call `mcpId`: false when that call is not waiting (any more). */
  answer(mcpId, { text = '', isError = false } = {}) {
    const k = key(mcpId);
    if (!this.awaiting.has(k)) return false;
    this.awaiting.delete(k);
    this._result(mcpId, { content: [{ type: 'text', text: String(text ?? '') }], isError: !!isError });
    return true;
  }

  /**
   * A progress notification for every waiting call that came with a progressToken. A client that
   * resets its call timeout on progress keeps waiting; one that does not (agy, unmeasured) is
   * no worse off.
   */
  progress(message = 'waiting for the client to run the tool and send its result') {
    for (const a of this.awaiting.values()) {
      if (!isId(a.progressToken)) continue;
      a.progress++;
      this.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: a.progressToken, progress: a.progress, message } });
    }
  }

  /** A new turn: the count of refused calls starts again. */
  resetTurn() {
    this.invalid = 0;
  }

  _call(id, params) {
    let name = typeof params.name === 'string' ? params.name : '';
    if (this.prefix && name.startsWith(this.prefix)) name = name.slice(this.prefix.length);
    let args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    if (isPlainObject(args)) args = this._clean(name, args);
    const r = validateCall(this.tools, { name, args });
    if (!r.ok) {
      this.invalid++;
      this._result(id, { content: [{ type: 'text', text: `keysmith: this call was not run: ${r.reason}. Call the tool again with arguments that fit its input schema.` }], isError: true });
      const known = this.tools.some((t) => t.name === name);
      this.emit({ type: 'invalid', name: known ? name : null, count: this.invalid, reason: r.reason });
      return;
    }
    const progressToken = isPlainObject(params._meta) && isId(params._meta.progressToken) ? params._meta.progressToken : null;
    this.awaiting.set(key(id), { id, progressToken, progress: 0 });
    this.emit({ type: 'call', mcpId: id, name, args: r.args });
  }

  /** `args` without the arguments a harness injects, where the tool's own schema does not name them. */
  _clean(name, args) {
    const tool = this.tools.find((t) => t.name === name);
    const props = isPlainObject(tool?.parameters?.properties) ? tool.parameters.properties : {};
    const drop = INJECTED_ARGS.filter((k) => Object.hasOwn(args, k) && !Object.hasOwn(props, k));
    if (!drop.length) return args;
    const out = { ...args };
    for (const k of drop) delete out[k];
    return out;
  }

  _cancelled(params) {
    const k = isId(params.requestId) ? key(params.requestId) : null;
    if (!k || !this.awaiting.has(k)) return;
    this.awaiting.delete(k);
    this.emit({ type: 'broken', reason: 'cancelled' });
  }

  _result(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }
}

function isId(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** A JSON-RPC id as a map key: `1` and `"1"` are two ids. */
function key(id) {
  return `${typeof id}:${id}`;
}
