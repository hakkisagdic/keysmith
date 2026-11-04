import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { LlmError, contentToText, declaredKind, flattenMessages, isMediaPart, kindName, mediaOmitted } from './util.js';

/**
 * Media a request carries — images, PDFs, audio, video — for an adapter that takes them
 * (`media` on its entry; `vision: true` is `image` among them).
 *
 * The protocol faces read every message as text and keep its parts beside it when they hold
 * media (util.js keepMediaParts). An adapter that takes none reads the text, where each item is
 * a label naming what it was. One that takes some has them read here, every one before anything
 * is sent or started, so a bad one is a 400 that costs nothing:
 *
 *   a CLI (Claude Code)   the prompt flattened as for any other, on stdin as one stream-json user
 *                         message with the media as blocks where they were (mediaPrompt)
 *   an HTTP upstream      each user turn as a content array in the upstream's wire: OpenAI
 *                         `image_url` / `input_audio` / `file` / `video_url`, Anthropic `image` /
 *                         `document`, UHP/Responses `input_image` / `input_file` (upstreamMessages)
 *
 * Inline data is taken as sent, its kind and type read off the bytes. A URL is fetched by keysmith,
 * http(s) only and only from the public internet (fetchMedia): the gateway can sit behind a
 * tunnel, and a fetch on a key holder's behalf must not reach this machine or its network.
 */

export const MEDIA_KINDS = ['image', 'pdf', 'audio', 'video'];

/** Per adapter, these override the defaults. Images and files (a PDF, audio, video) are counted and capped apart. */
export const MEDIA_LIMITS = { maxImages: 20, maxImageBytes: 5 * 1024 * 1024, maxFiles: 5, maxFileBytes: 20 * 1024 * 1024 };

/** A URL fetch: the time the whole of it may take, and the redirects it follows. */
export const FETCH_LIMITS = { timeoutMs: 20_000, maxRedirects: 3 };

const ascii = (b, from, to) => b.subarray(from, to).toString('latin1');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What is taken, read off the bytes: a declared type that disagrees is corrected, not trusted.
 * An MPEG audio frame is told from noise by its header (a bitrate and a sample rate that exist);
 * an ADTS (AAC) frame is the same sync word with layer 0.
 */
const SIGNATURES = [
  ['image', 'image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image', 'image/png', (b) => b.subarray(0, 8).equals(PNG_MAGIC)],
  ['image', 'image/gif', (b) => /^GIF8[79]a$/.test(ascii(b, 0, 6))],
  ['image', 'image/webp', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
  ['pdf', 'application/pdf', (b) => ascii(b, 0, 5) === '%PDF-'],
  ['audio', 'audio/wav', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE'],
  ['audio', 'audio/mpeg', (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0 && b[2] >> 4 !== 0xf && ((b[2] >> 2) & 3) !== 3)],
  ['audio', 'audio/aac', (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0],
  ['audio', 'audio/flac', (b) => ascii(b, 0, 4) === 'fLaC'],
  ['audio', 'audio/ogg', (b) => ascii(b, 0, 4) === 'OggS'],
  ['audio', 'audio/mp4', (b) => ascii(b, 4, 8) === 'ftyp' && /^M4[AB] $/.test(ascii(b, 8, 12))],
  ['video', 'video/quicktime', (b) => ascii(b, 4, 8) === 'ftyp' && ascii(b, 8, 12) === 'qt  '],
  ['video', 'video/mp4', (b) => ascii(b, 4, 8) === 'ftyp'],
  ['video', 'video/webm', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
];

const KNOWN = 'a JPEG, PNG, GIF or WebP image, a PDF, WAV, MP3, AAC, FLAC, Ogg or M4A audio, or MP4, QuickTime or WebM video';

/** OpenAI's `input_audio.format` for each audio type (OpenAI itself takes wav and mp3; Gemini more). */
const AUDIO_FORMATS = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

/** `{ kind, mediaType }` of what the bytes are, or null. */
export function sniffMedia(bytes) {
  if (bytes.length < 12) return null;
  const hit = SIGNATURES.find(([, , test]) => test(bytes));
  return hit ? { kind: hit[0], mediaType: hit[1] } : null;
}

function refuse(adapterId, message) {
  return new LlmError(`adapter "${adapterId}": ${message}`, { status: 400, type: 'invalid_request_error', provider: adapterId });
}

/** A URL as an error message may show it: scheme and host, never a path or query that may be a signed token. */
function urlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'a URL';
  }
}

function size(n) {
  if (n < 1024) return `${n} bytes`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An entry's media settings, checked: `{ kinds, limits }`. `media` lists the kinds the adapter
 * takes, and `vision: true` puts `image` among them. `wire` is what it writes them in: an
 * Anthropic message (an `anthropic` upstream, a CLI's stream-json) has blocks for images and PDFs
 * only, so audio or video there is a load error rather than a request that fails every time.
 */
export function checkMedia(id, cfg, { wire, where }) {
  if (cfg.vision != null && typeof cfg.vision !== 'boolean') throw new Error(`adapter "${id}": vision must be true or false`);
  const media = cfg.media ?? [];
  if (!Array.isArray(media) || media.some((k) => !MEDIA_KINDS.includes(k))) {
    throw new Error(`adapter "${id}": media must be a list of ${MEDIA_KINDS.join(', ')} (e.g. ["image", "pdf"])`);
  }
  if (cfg.vision === false && media.includes('image')) {
    throw new Error(`adapter "${id}": vision is false and media lists image — \`keysmith vision ${id} off\` takes image out of media too`);
  }
  const kinds = MEDIA_KINDS.filter((k) => media.includes(k) || (k === 'image' && cfg.vision === true));
  const none = wire === 'anthropic' ? kinds.filter((k) => k === 'audio' || k === 'video') : [];
  if (none.length) throw new Error(`adapter "${id}": ${none.join(' and ')} cannot go ${where}: an Anthropic message has blocks for images and PDFs only`);
  for (const k of Object.keys(MEDIA_LIMITS)) {
    if (cfg[k] != null && !(Number.isInteger(cfg[k]) && cfg[k] > 0)) throw new Error(`adapter "${id}": ${k} must be a whole number above 0`);
  }
  return { kinds, limits: Object.fromEntries(Object.entries(MEDIA_LIMITS).map(([k, v]) => [k, cfg[k] ?? v])) };
}

/** Does any message carry media an adapter could take? */
export function hasMedia(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.parts));
}

/* ------------------------------------------------------------------ reading one part */

/**
 * Where a part's bytes are: `{ url }` (a data: URL among them), or `{ declared, data }` (base64,
 * as sent). A reference to an upload is refused: keysmith keeps no files.
 */
function sourceOf(part, what, adapterId) {
  const upload = () => refuse(adapterId, `${what} names an uploaded file (file_id); keysmith keeps no files — send it inline (base64), or as a URL`);
  switch (part.type) {
    case 'image':
    case 'document': {
      const src = part.source || {};
      if (src.type === 'base64') return { declared: src.media_type, data: src.data };
      if (src.type === 'url') return { url: src.url };
      if (src.type === 'file' || src.file_id) throw upload();
      throw refuse(adapterId, `${what} has a ${JSON.stringify(String(src.type ?? 'missing')).slice(0, 40)} source; send it as { "type": "base64", "media_type", "data" } or { "type": "url", "url" }`);
    }
    case 'input_audio': {
      const a = part.input_audio || {};
      return { declared: a.format, data: a.data };
    }
    case 'file':
    case 'input_file': {
      const f = part.type === 'file' ? part.file || {} : part;
      // `file_data` is a data: URL in OpenAI's own examples, and bare base64 in some.
      if (f.file_data != null) return /^data:/i.test(String(f.file_data)) ? { url: f.file_data } : { data: f.file_data };
      if (f.file_url != null) return { url: f.file_url };
      if (f.file_id != null) throw upload();
      return { data: '' };
    }
    default: {
      // Chat `{ image_url: { url } }` (or the bare string), Responses `{ image_url: "…" }`, `{ video_url: { url } }`.
      const key = part.type === 'video_url' ? 'video_url' : 'image_url';
      const url = typeof part[key] === 'string' ? part[key] : part[key]?.url;
      if (!url && part.file_id) throw upload();
      return url ? { url } : { data: '' };
    }
  }
}

/** What a part calls itself (a file name, a document title) and the detail an image asked for. */
function nameOf(part) {
  const name = part.type === 'file' ? part.file?.filename : part.type === 'document' ? part.title : part.filename;
  return typeof name === 'string' && name ? name.slice(0, 200) : null;
}

function detailOf(part) {
  const detail = part.type === 'input_image' ? part.detail : part.image_url?.detail;
  return typeof detail === 'string' && detail ? detail : null;
}

/** The cap a kind is held to: `[bytes, its field's name]`. A kind not known yet may be either. */
function capOf(kind, limits) {
  if (kind === 'image') return [limits.maxImageBytes, 'maxImageBytes'];
  if (kind !== 'file' || limits.maxFileBytes >= limits.maxImageBytes) return [limits.maxFileBytes, 'maxFileBytes'];
  return [limits.maxImageBytes, 'maxImageBytes'];
}

/** A URL's bytes, fetched once per part: every leg of a route reads the same part. `cap` is part of the key. */
const fetched = new WeakMap();

function fetchOnce(part, cap, fetch) {
  let byCap = fetched.get(part);
  if (!byCap) fetched.set(part, (byCap = new Map()));
  if (!byCap.has(cap)) byCap.set(cap, fetch());
  return byCap.get(cap);
}

/**
 * One media part, read: `{ kind, mediaType, data (standard base64), name, detail }`, or a 400
 * saying why not. `n` is its place among the media read for this request, counted from 1.
 */
export async function readPart(part, { adapterId, n, limits = MEDIA_LIMITS, fetchUrls = true, allowed = isPublicAddress, signal } = {}) {
  const declaredAs = declaredKind(part);
  const what = `${kindName(declaredAs)} ${n}`;
  const [cap, capName] = capOf(declaredAs, limits);
  let { url, declared, data } = sourceOf(part, what, adapterId);
  let bytes = null;
  if (url != null) {
    const s = String(url);
    const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(s);
    if (m) {
      if (!/;base64$/i.test(m[2])) throw refuse(adapterId, `${what} is a data: URL without ;base64 — encode it as base64`);
      [declared, data] = [m[1], m[3]];
    } else if (/^https?:/i.test(s)) {
      if (!fetchUrls) {
        throw refuse(adapterId, `${what} is a URL (${urlOrigin(s)}/…), and this gateway does not fetch media (fetchMedia is false) — send it inline: base64 in a data: URL (/v1/chat/completions) or a base64 source (/v1/messages)`);
      }
      bytes = await fetchOnce(part, cap, () => fetchMedia(s, { adapterId, what, cap, capName, signal, allowed }));
    } else {
      throw refuse(adapterId, `${what} has no data: expected a data: URL, an http(s) URL or a base64 source`);
    }
  }
  if (!bytes) {
    const b64 = String(data ?? '').replace(/\s+/g, '');
    if (!b64) throw refuse(adapterId, `${what} is empty`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw refuse(adapterId, `${what} is not valid base64`);
    bytes = Buffer.from(b64, 'base64');
  }
  if (bytes.length > cap) throw refuse(adapterId, `${what} is ${size(bytes.length)}, over ${capName}=${size(cap)} — make it smaller, or raise the cap on this adapter`);
  const found = sniffMedia(bytes);
  if (!found) throw refuse(adapterId, `${what}${declared ? ` (declared ${String(declared).slice(0, 40)})` : ''} is none of what keysmith takes: ${KNOWN}`);
  const [max, maxName] = capOf(found.kind, limits);
  if (bytes.length > max) throw refuse(adapterId, `${what} is ${size(bytes.length)} of ${kindName(found.kind)}, over ${maxName}=${size(max)} — make it smaller, or raise the cap on this adapter`);
  return { kind: found.kind, mediaType: found.mediaType, data: bytes.toString('base64'), name: nameOf(part), detail: detailOf(part) };
}

/**
 * The media of `messages` an adapter takes, read: `Map(part -> media)`. A part of a kind the
 * adapter takes none of is left unread (it stays a label); one that does not say its kind (a file
 * with no type and no name) is read, and what it turns out to be decides. All are read side by side.
 */
async function readMedia(messages, { adapterId, kinds, limits, fetchUrls, allowed }, signal) {
  const todo = [];
  let images = 0;
  let files = 0;
  for (const m of messages) {
    for (const part of m.parts || []) {
      if (!isMediaPart(part)) continue;
      const declared = declaredKind(part);
      if (declared !== 'file' && !kinds.includes(declared)) continue;
      if (declared === 'image' ? ++images > limits.maxImages : ++files > limits.maxFiles) {
        throw refuse(adapterId, declared === 'image' ? `the request carries more than maxImages=${limits.maxImages} images` : `the request carries more than maxFiles=${limits.maxFiles} files (PDF, audio, video)`);
      }
      todo.push(part);
    }
  }
  const read = await Promise.all(todo.map((part, i) => readPart(part, { adapterId, n: i + 1, limits, fetchUrls, allowed, signal })));
  return new Map(todo.map((part, i) => [part, read[i]]));
}

/** What an adapter's options say about one read part: taken as media, or its label. */
function taken(part, read, kinds) {
  const m = read.get(part);
  return m && kinds.includes(m.kind) ? m : null;
}

const dataUrl = (m) => `data:${m.mediaType};base64,${m.data}`;

/** One read item as a content block of `wire`: `anthropic` (also a CLI's stream-json), `uhp` (Responses), or `openai`. */
function wireBlock(m, wire) {
  if (wire === 'anthropic') {
    if (m.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: m.mediaType, data: m.data } };
    return { type: 'document', source: { type: 'base64', media_type: m.mediaType, data: m.data }, ...(m.name ? { title: m.name } : {}) };
  }
  if (wire === 'uhp') {
    if (m.kind === 'image') return { type: 'input_image', image_url: dataUrl(m), ...(m.detail ? { detail: m.detail } : {}) };
    return { type: 'input_file', filename: m.name || 'document.pdf', file_data: dataUrl(m) };
  }
  switch (m.kind) {
    case 'image':
      return { type: 'image_url', image_url: { url: dataUrl(m), ...(m.detail ? { detail: m.detail } : {}) } };
    case 'audio':
      return { type: 'input_audio', input_audio: { data: m.data, format: AUDIO_FORMATS[m.mediaType] } };
    case 'pdf':
      return { type: 'file', file: { filename: m.name || 'document.pdf', file_data: dataUrl(m) } };
    default:
      return { type: 'video_url', video_url: { url: dataUrl(m) } };
  }
}

/* ------------------------------------------------------------------ a CLI */

/**
 * The prompt of a CLI run that carries media: `{ system, prompt }` as flattenMessages writes them,
 * each item's place marked, `media` (how many items it carries), and `stdin(text)` — the stream-json
 * line for `text` (the prompt as the adapter finally sends it, system turn and any retry
 * instruction included) with the marks replaced by the items. A kind the CLI does not take reads as
 * its label. Every item is read here, before any process starts: a bad one is a 400.
 */
export async function mediaPrompt(messages, opts, { signal } = {}) {
  const read = await readMedia(messages, opts, signal);
  // A mark no client can write: the nonce is new for every request.
  const nonce = randomBytes(8).toString('hex');
  const items = [];
  const media = (part) => {
    const m = taken(part, read, opts.kinds);
    if (!m) return mediaOmitted(read.get(part)?.kind ?? declaredKind(part));
    items.push(m);
    return `\u0000ks-media-${nonce}-${items.length - 1}\u0000`;
  };
  const { system, prompt } = flattenMessages(
    messages.map((m) => (m.parts ? { role: m.role, content: m.parts } : m)),
    { media },
  );
  const mark = new RegExp(`\u0000ks-media-${nonce}-(\\d+)\u0000`);
  const stdin = (text) => {
    const pieces = text.split(mark);
    const content = [];
    for (let i = 0; i < pieces.length; i++) {
      if (i % 2) content.push(wireBlock(items[Number(pieces[i])], 'anthropic'));
      // The Messages API refuses a text block of whitespace alone.
      else if (pieces[i].trim()) content.push({ type: 'text', text: pieces[i] });
    }
    return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  };
  return { system, prompt, media: items.length, stdin };
}

/* ------------------------------------------------------------------ an HTTP upstream */

/**
 * `messages` as an HTTP upstream of `opts.wire` takes them: each user turn that carries media as a
 * content array — its text and its media in their order, a kind the upstream does not take as its
 * label — and every other message as it was. Media goes up in a user turn only: neither API takes
 * it in a system or assistant turn, where it stays the label.
 */
export async function upstreamMessages(messages, opts, { signal } = {}) {
  const turns = messages.filter((m) => m.role === 'user' && Array.isArray(m.parts));
  if (!turns.length) return messages;
  const read = await readMedia(turns, opts, signal);
  return messages.map((m) => {
    if (!turns.includes(m)) return m;
    const content = contentBlocks(m.parts, read, opts);
    // A turn whose media all became labels is text again, as it is for an upstream that takes none.
    return { role: m.role, content: content.every((b) => b.type === 'text' || b.type === 'input_text') ? content.map((b) => b.text).join('\n') : content };
  });
}

function contentBlocks(parts, read, { wire, kinds }) {
  const blocks = [];
  let text = [];
  const textType = wire === 'uhp' ? 'input_text' : 'text';
  // Text between two items is one block, joined as contentToText joins it; one of whitespace alone is dropped.
  const flush = () => {
    const t = text.join('\n');
    text = [];
    if (t.trim()) blocks.push({ type: textType, text: t });
  };
  for (const part of parts) {
    if (!isMediaPart(part)) {
      const t = contentToText([part]);
      if (t) text.push(t);
      continue;
    }
    const m = taken(part, read, kinds);
    if (!m) {
      text.push(mediaOmitted(read.get(part)?.kind ?? declaredKind(part)));
      continue;
    }
    flush();
    blocks.push(wireBlock(m, wire));
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ fetching a URL */

/**
 * Addresses a fetch never connects to: this machine, private and shared networks, link-local
 * (169.254.169.254 is a cloud's metadata service), documentation, multicast and reserved ranges,
 * and the IPv6 forms that embed an IPv4 address (NAT64, 6to4, Teredo). An IPv4-mapped address
 * (`::ffff:127.0.0.1`) needs no rule of its own: BlockList checks it against the IPv4 rules —
 * and a `::ffff:0:0/96` rule would match every IPv4 address there is.
 */
const NOT_PUBLIC = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NOT_PUBLIC.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NOT_PUBLIC.addSubnet(a, p, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

class NotPublic extends Error {}

/**
 * dns.lookup that answers only with addresses `allowed` passes (isPublicAddress): the socket
 * connects to what this returns, so the address checked is the address used — a name that
 * resolves anew between a check and the connection (DNS rebinding) changes nothing. Every address
 * a name has is checked, not the first.
 */
function checkedLookup(allowed) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'number' ? { family: options } : options || {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || addresses.some((a) => !allowed(a.address))) return callback(new NotPublic(hostname));
      if (opts.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function get(href, { allowed, signal }) {
  const u = new URL(href);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NotPublic(u.protocol);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // An address written as one is never looked up, so it is checked here.
  if (net.isIP(host) && !allowed(host)) throw new NotPublic(host);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        // Nothing of the client's goes along: no key, no cookie, no credentials from the URL.
        headers: { 'user-agent': 'keysmith', accept: '*/*' },
        lookup: checkedLookup(allowed),
        agent: false,
        signal,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * The bytes at an http(s) URL, for a client that sent the URL rather than the data — at most
 * `cap` of them, counted as they arrive, within FETCH_LIMITS.timeoutMs; redirects followed up to
 * FETCH_LIMITS.maxRedirects, each one checked as the first was. Only from addresses `allowed`
 * passes, public ones (see checkedLookup). A failure is a 400 that names the URL's host and no more.
 */
export async function fetchMedia(url, { adapterId, what, cap, capName, signal, allowed = isPublicAddress, timeoutMs = FETCH_LIMITS.timeoutMs, maxRedirects = FETCH_LIMITS.maxRedirects }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await get(current, { allowed, signal: abort });
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hop >= maxRedirects) throw refuse(adapterId, `${what} at ${urlOrigin(url)} redirects more than ${maxRedirects} times`);
        current = new URL(res.headers.location, current).href;
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw refuse(adapterId, `${what} could not be fetched: ${urlOrigin(current)} answered ${res.statusCode}`);
      }
      const length = Number(res.headers['content-length']);
      const over = () => refuse(adapterId, `${what} at ${urlOrigin(current)} is over ${capName}=${size(cap)} — make it smaller, or raise the cap on this adapter`);
      if (length > cap) {
        res.destroy();
        throw over();
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of res) {
        total += chunk.length;
        if (total > cap) {
          res.destroy();
          throw over();
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof NotPublic) {
      throw refuse(adapterId, `${what} is at ${urlOrigin(current)}, which is not on the public internet — keysmith fetches media only from public addresses (not this machine, its network, or link-local)`);
    }
    if (deadline.aborted) throw refuse(adapterId, `${what} could not be fetched from ${urlOrigin(current)} within ${timeoutMs / 1000} s`);
    throw refuse(adapterId, `${what} could not be fetched from ${urlOrigin(current)} (${e.code || e.name || 'error'})`);
  }
}
