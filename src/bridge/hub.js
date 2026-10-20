import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from './mcp.js';
import { forgetSecrets, registerSecrets } from '../redact.js';

/**
 * The bridge's hub (design §3, U6): the MCP server side of every bridge session, inside the
 * gateway process.
 *
 * A CLI reaches it through the shim (shim.js) over one Unix socket — no TCP listener, so no
 * tunnel reaches it either. The socket's directory is 0700 and the socket 0600. Each session has
 * a token of its own (32 random bytes): the shim's hello line carries it, the hub compares it in
 * constant time, and a connection without the right one is closed unanswered. A session takes
 * one connection at a time; a connection that dropped may be replaced by a new one. Every token
 * is registered as a secret (redact.js) while its session lives, so no log line prints it.
 *
 * A session is one CLI process and the calls it made: `generating` while a turn of an HTTP
 * request is reading it (the first turn included, before the CLI is ready), `waiting` while a
 * call it made is with the client, `closed` after. Its clock:
 *
 *   readyTimeoutMs        the CLI's MCP client has listed the tools (shim connected, tools/list)
 *   toolResultTimeoutMs   the client came back with the result of the call it was handed
 *   sessionMaxMs          the whole session, whatever it is doing
 *
 * A session closed by its clock — or for any other reason — leaves a tombstone for each call it
 * handed out (`expired`, `evicted`, `broken`, …), kept an hour, so a request that comes back
 * late is told apart from one that never had a session (src/bridge/index.js answers both the
 * same way: the cold path).
 *
 * Room: at most `maxSessions` sessions in all (limits.bridge.maxSessions, 2), at most an
 * adapter's own `bridge.maxSessions` (2) for one adapter, and at most `maxSessionsPerKey` (1)
 * for one gateway key — a key that opens a session over its share gives up its oldest waiting
 * one (LRU). Each live session holds a CLI process: on a 16 GB machine these stay small.
 */

/**
 * Two sessions in all, not the design's four: a waiting agy session measured about 1 GB RSS on
 * agy 1.4.2 (agy itself ~230 MB, the shim ~50 MB, and ~760 MB of the MCP servers in the user's
 * own agy config, which agy starts for every run whatever the agent says), on a 16 GB machine.
 */
export const HUB_DEFAULTS = { maxSessions: 2, maxSessionsPerKey: 1 };
export const SESSION_DEFAULTS = { maxSessions: 2, toolResultTimeoutMs: 300_000, sessionMaxMs: 1_800_000, maxTurns: 32, readyTimeoutMs: 30_000 };
export const TOMBSTONE_MS = 3_600_000;
export const PROGRESS_MS = 15_000;
/** How long a client is told to wait (`retry-after`, seconds) when there is no room. */
export const RETRY_AFTER_S = 15;

const TOMBSTONES_MAX = 10_000;
const HELLO_MAX = 4096;
const HELLO_TIMEOUT_MS = 10_000;
const LINE_MAX = 32 * 1024 * 1024;
/** sockaddr_un's path on macOS is 104 bytes with its NUL. */
const SUN_PATH_MAX = 103;

/** Events that end a session nobody is reading: the CLI exited, or its MCP side broke. */
const TERMINAL = new Set(['exit', 'broken']);

export class Hub {
  constructor({ socketPath, maxSessions = HUB_DEFAULTS.maxSessions, maxSessionsPerKey = HUB_DEFAULTS.maxSessionsPerKey, log = () => {}, timers = globalThis, now = Date.now, progressMs = PROGRESS_MS } = {}) {
    Object.assign(this, { socketPath, maxSessions, maxSessionsPerKey, log, timers, now, progressMs });
    this.sessions = new Map(); // session id -> Session
    this._calls = new Map(); // a call id handed to a client -> its live session
    this._tombs = new Map(); // a call id -> { reason, at }, oldest first
    this._conns = new Set();
    this.server = null;
    this._starting = null;
    this._listening = false;
  }

  /** Listen on the socket (once; a failed start is tried again on the next call). */
  start() {
    this._starting ??= this._listen().catch((e) => {
      this._starting = null;
      throw e;
    });
    return this._starting;
  }

  async _listen() {
    const p = this.socketPath;
    if (!p) throw new Error('the bridge has no socket path');
    if (Buffer.byteLength(p) > SUN_PATH_MAX) throw new Error(`the bridge socket path is ${Buffer.byteLength(p)} bytes, over the ${SUN_PATH_MAX} a Unix socket path takes (limits.bridge.socket): ${p}`);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A directory keysmith makes is 0700 from the start; one it finds open to others is not
    // changed behind the owner's back (it could be a home directory): the bridge refuses it.
    if ((fs.statSync(dir).mode & 0o077) !== 0) throw new Error(`the bridge socket's directory ${dir} is open to other users; the bridge needs one only you can enter (0700)`);
    let existing = null;
    try {
      existing = fs.lstatSync(p);
    } catch {}
    if (existing) {
      if (!existing.isSocket()) throw new Error(`${p} exists and is not a socket: keysmith will not replace it`);
      if (await reachable(p)) throw new Error(`another process is listening on the bridge socket ${p} (another keysmith with the same data directory?)`);
      fs.unlinkSync(p);
    }
    const server = net.createServer((c) => this._connection(c));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => this.log(`bridge socket: ${e.message}`));
    fs.chmodSync(p, 0o600);
    this.server = server;
    this._listening = true;
  }

  /** Every session closed (each CLI stopped), the socket closed and removed. */
  async close() {
    const closing = [...this.sessions.values()].map((s) => s.close('shutdown'));
    for (const c of this._conns) c.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(() => r()));
    if (this._listening) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
      this._listening = false;
    }
    this._starting = null;
    await Promise.allSettled(closing);
  }

  /**
   * Is there room for a new session of `adapterId` opened by key `caller`? `{ ok: true, evict }`
   * — the key's own waiting sessions to close first (LRU) — or `{ ok: false, reason, retryAfter }`.
   * Nothing is closed here.
   */
  room({ adapterId, caller = '', adapterMax = SESSION_DEFAULTS.maxSessions }) {
    const full = { ok: false, reason: 'bridge_full', retryAfter: RETRY_AFTER_S };
    const live = [...this.sessions.values()].filter((s) => !s.closed);
    const mine = live.filter((s) => s.caller === caller);
    const over = mine.length - (this.maxSessionsPerKey - 1);
    let evict = [];
    if (over > 0) {
      evict = mine.filter((s) => s.state === 'waiting').sort((a, b) => a.lastActive - b.lastActive).slice(0, over);
      if (evict.length < over) return full;
    }
    const left = live.filter((s) => !evict.includes(s));
    if (left.length >= this.maxSessions || left.filter((s) => s.adapterId === adapterId).length >= adapterMax) return full;
    return { ok: true, evict };
  }

  /** A new session (see Session for `o`), with a server name no live session has. */
  open(o) {
    let rid;
    do rid = randomBytes(6).toString('hex');
    while ([...this.sessions.values()].some((s) => s.rid.slice(0, 6) === rid.slice(0, 6)));
    const s = new Session(this, { ...o, rid });
    this.sessions.set(s.id, s);
    return s;
  }

  /** The live session that handed out call `id`, or null. */
  sessionForCall(id) {
    const s = typeof id === 'string' ? this._calls.get(id) : null;
    return s && !s.closed ? s : null;
  }

  /** What became of a call whose session is gone (`{ reason, at, caller }`), for an hour; null otherwise. */
  tombstone(id) {
    const t = typeof id === 'string' ? this._tombs.get(id) : null;
    if (!t) return null;
    if (this.now() - t.at > TOMBSTONE_MS) {
      this._tombs.delete(id);
      return null;
    }
    return t;
  }

  /** How many sessions there are, and how many of them wait for a client. */
  stats() {
    const live = [...this.sessions.values()];
    return { sessions: live.length, waiting: live.filter((s) => s.state === 'waiting').length };
  }

  _index(id, s) {
    this._calls.set(id, s);
  }

  _closed(s, reason) {
    this.sessions.delete(s.id);
    const now = this.now();
    for (const id of s.emitted) {
      if (this._calls.get(id) === s) this._calls.delete(id);
      this._tombs.delete(id);
      // The key it was handed to: what became of a call is that key's business only.
      this._tombs.set(id, { reason, at: now, caller: s.caller });
    }
    for (const [id, t] of this._tombs) {
      if (this._tombs.size <= TOMBSTONES_MAX && now - t.at <= TOMBSTONE_MS) break;
      this._tombs.delete(id);
    }
  }

  _byToken(token) {
    if (typeof token !== 'string' || !token || token.length > 256) return null;
    const h = sha256(token);
    let found = null;
    // Every session is compared, the right one or not: how long this takes says nothing.
    for (const s of this.sessions.values()) if (timingSafeEqual(h, s._tokenHash) && !s.closed) found = s;
    return found;
  }

  _connection(c) {
    this._conns.add(c);
    c.setEncoding('utf8');
    c.on('error', () => {});
    let buf = '';
    let session = null;
    const refuse = (why) => {
      this.timers.clearTimeout(hello);
      this.log(`bridge: a connection was refused: ${why}`);
      c.destroy();
    };
    const hello = this.timers.setTimeout(() => refuse('it sent no hello'), HELLO_TIMEOUT_MS);
    hello?.unref?.();
    c.on('data', (chunk) => {
      buf += chunk;
      if (!session) {
        const i = buf.indexOf('\n');
        if (i < 0) {
          if (buf.length > HELLO_MAX) refuse('its hello line is too long');
          return;
        }
        let h = null;
        try {
          h = JSON.parse(buf.slice(0, i));
        } catch {}
        buf = buf.slice(i + 1);
        this.timers.clearTimeout(hello);
        const s = this._byToken(h?.token);
        if (!s) return refuse('a wrong or missing token');
        if (s.conn) return refuse(`bridge ${s.server} has a connection already`);
        session = s;
        s.conn = c;
      }
      for (let i = buf.indexOf('\n'); i >= 0 && session.conn === c; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) session._line(line);
      }
      if (buf.length > LINE_MAX) {
        this.log(`bridge ${session.server}: a message over ${LINE_MAX} bytes; the connection is closed`);
        c.destroy();
      }
    });
    c.on('close', () => {
      this._conns.delete(c);
      this.timers.clearTimeout(hello);
      session?._disconnected(c);
    });
  }
}

/**
 * One bridge session. `o`: `adapterId`, `caller` (the gateway key's hash; '' with auth off),
 * `target` (`adapter/model`), `tools` (the ToolSpec's), `listing` (tools/list), `toolsHash`,
 * `prefixHash`, `idSeq` (the call ids of the conversation so far), `limits` (SESSION_DEFAULTS),
 * `prefix(server)` (the name the CLI shows its model for this server's tools).
 *
 * Events for the turn reading it come out of `next()`: the MCP side's `ready`, `call`, `invalid`,
 * `broken`; the clock's `ready_timeout`, `expired`, `session_max`; whatever the engine pushes
 * (the CLI's own stream, its exit); and `closed` once it is closed.
 */
export class Session {
  constructor(hub, o) {
    this.hub = hub;
    this.rid = o.rid;
    this.id = `kb_${o.rid}`;
    this.server = `ks${o.rid.slice(0, 6)}`;
    this.adapterId = o.adapterId;
    this.caller = o.caller ?? '';
    this.target = o.target ?? '';
    this.tools = o.tools || [];
    this.toolsHash = o.toolsHash ?? null;
    this.prefixHash = o.prefixHash ?? null;
    this.idSeq = [...(o.idSeq || [])];
    this.limits = { ...SESSION_DEFAULTS, ...(o.limits || {}) };
    this.token = randomBytes(32).toString('base64url');
    this._tokenHash = sha256(this.token);
    registerSecrets([this.token]);
    this.state = 'generating';
    this.turns = 0; // calls handed to the client
    this.emitted = [];
    this.out = null; // the call with the client: { id, mcpId, name }
    this.openedAt = hub.now();
    this.lastActive = this.openedAt;
    this.inbox = [];
    this._wake = null;
    this.conn = null;
    this.closed = false;
    this.closing = null;
    this.closedReason = null;
    this._onClose = [];
    this.mcp = new McpServer({
      tools: this.tools,
      listing: o.listing || [],
      prefix: typeof o.prefix === 'function' ? o.prefix(this.server) : '',
      send: (m) => this._send(m),
      emit: (e) => {
        if (e.type === 'ready') this._clear('ready');
        this.push(e);
      },
    });
    const t = hub.timers;
    this._timers = {
      ready: t.setTimeout(() => this.mcp.ready || this.push({ type: 'ready_timeout' }), this.limits.readyTimeoutMs),
      max: t.setTimeout(() => this._expire('session_max'), this.limits.sessionMaxMs),
      result: null,
      progress: null,
    };
    for (const h of Object.values(this._timers)) h?.unref?.();
  }

  /** What the shim needs: in the agent file's env for the MCP server. */
  get env() {
    return { KEYSMITH_BRIDGE_SOCK: this.hub.socketPath, KEYSMITH_BRIDGE_TOKEN: this.token };
  }

  /** An event for the turn reading this session. Nobody reads a waiting session: an exit or a break closes it. */
  push(evt) {
    if (this.closed) return;
    if (this.state === 'waiting' && TERMINAL.has(evt.type)) {
      this.close(evt.reason || (evt.type === 'exit' ? 'exited' : evt.type));
      return;
    }
    this.inbox.push(evt);
    this._notify();
  }

  /** The next event, when there is one. */
  async next() {
    while (!this.inbox.length) await new Promise((r) => (this._wake = r));
    return this.inbox.shift();
  }

  /** Call `out` went to the client: the session waits for its result, on the clock. */
  hold({ id, mcpId, name }) {
    this.out = { id, mcpId, name };
    this.emitted.push(id);
    this.idSeq.push(id);
    this.hub._index(id, this);
    this.turns++;
    this.state = 'waiting';
    this.lastActive = this.hub.now();
    const t = this.hub.timers;
    this._timers.result = t.setTimeout(() => this._expire('expired'), this.limits.toolResultTimeoutMs);
    this._timers.progress = t.setInterval(() => this.mcp.progress(), this.hub.progressMs);
    this._timers.result?.unref?.();
    this._timers.progress?.unref?.();
    // Something that broke while the call went out has nobody to read it now.
    const end = this.inbox.find((e) => TERMINAL.has(e.type));
    if (end) this.close(end.reason || (end.type === 'exit' ? 'exited' : end.type));
  }

  /**
   * A request continues this session: off the clock, generating again (so a second request for
   * the same result finds it taken). Its result goes to the CLI with answer(), once the request
   * has a process slot.
   */
  attach() {
    this._clear('result');
    this._clear('progress');
    this.state = 'generating';
    this.lastActive = this.hub.now();
    this.mcp.resetTurn();
  }

  /** The client's result for the call it was handed, as that call's MCP result. False when the CLI can no longer be told. */
  answer({ text = '', isError = false } = {}) {
    const ok = !!this.out && this.mcp.answer(this.out.mcpId, { text, isError });
    this.out = null;
    return ok;
  }

  /** Run `fn(reason)` when the session closes (the CLI stopped, its files removed). */
  onClose(fn) {
    this._onClose.push(fn);
  }

  /** Close: the clock stopped, the calls tombstoned, the connection dropped, the token forgotten, then each onClose. */
  close(reason = 'closed') {
    if (this.closing) return this.closing;
    this.closed = true;
    this.state = 'closed';
    this.closedReason = reason;
    for (const k of Object.keys(this._timers)) this._clear(k);
    this.hub._closed(this, reason);
    this.inbox.push({ type: 'closed', reason });
    this._notify();
    try {
      this.conn?.destroy();
    } catch {}
    this.conn = null;
    this.mcp.awaiting.clear();
    forgetSecrets([this.token]);
    this.closing = (async () => {
      for (const fn of this._onClose) {
        try {
          await fn(reason);
        } catch (e) {
          this.hub.log(`bridge ${this.server}: cleanup after close failed: ${e?.message || e}`);
        }
      }
    })();
    return this.closing;
  }

  _expire(reason) {
    if (this.closed) return;
    // A turn reading the session ends with it; a session nobody reads just closes.
    if (this.state === 'generating') this.push({ type: reason === 'session_max' ? 'session_max' : 'expired' });
    else this.close(reason);
  }

  _clear(name) {
    const h = this._timers[name];
    if (h == null) return;
    this.hub.timers.clearTimeout(h);
    this.hub.timers.clearInterval(h);
    this._timers[name] = null;
  }

  _notify() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }

  _send(msg) {
    if (this.conn && !this.conn.destroyed) this.conn.write(JSON.stringify(msg) + '\n');
  }

  _line(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    this.mcp.handle(msg);
  }

  _disconnected(c) {
    if (this.conn !== c) return;
    this.conn = null;
    if (this.closed) return;
    // A call the CLI is waiting on cannot be answered on another connection.
    if (this.mcp.awaiting.size) {
      this.mcp.awaiting.clear();
      this.push({ type: 'broken', reason: 'disconnected' });
    }
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest();
}

/** Does something answer on socket `p`? (A stale socket file refuses the connection.) */
function reachable(p) {
  return new Promise((resolve) => {
    const c = net.connect(p);
    const done = (v) => {
      clearTimeout(timer);
      c.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 1000);
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}
