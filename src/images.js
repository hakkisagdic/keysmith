import { randomBytes } from 'node:crypto';
import { LlmError, flattenMessages } from './util.js';

/**
 * Images for a CLI that can see them (`vision: true` on its entry; Claude Code's profile).
 *
 * The protocol faces read every message as text and keep its parts beside it when they hold an
 * image (util.js keepImageParts). For a vision CLI the prompt is flattened exactly as for any
 * other, with each image's place marked, and goes to the CLI's stdin as one Claude Code
 * stream-json user message: the text, cut at those marks, with the images as blocks between.
 *
 * Inline images only. A URL is refused, not fetched: the gateway can sit behind a tunnel, and a
 * fetch on a key holder's behalf reaches whatever this machine can (127.0.0.1, the LAN).
 */

/** Per adapter, `maxImages` and `maxImageBytes` (decoded) override these. */
export const IMAGE_LIMITS = { maxImages: 20, maxImageBytes: 5 * 1024 * 1024 };

/** What the Messages API takes, read off the bytes: a declared type that disagrees is corrected, not trusted. */
const SIGNATURES = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/gif', (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

export function sniffImageType(bytes) {
  return SIGNATURES.find(([, test]) => bytes.length >= 12 && test(bytes))?.[0] ?? null;
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

/**
 * One image part as `{ mediaType, data }` (standard base64), or a 400 saying why not. `n` is its
 * place in the request, counted from 1, for the message.
 */
export function readImage(part, { adapterId, n, maxImageBytes = IMAGE_LIMITS.maxImageBytes }) {
  let declared = null;
  let data = null;
  let url = null;
  if (part.type === 'image') {
    const src = part.source || {};
    if (src.type === 'base64') [declared, data] = [src.media_type, src.data];
    else if (src.type === 'url') url = src.url;
    else throw refuse(adapterId, `image ${n} has a ${JSON.stringify(String(src.type ?? 'missing')).slice(0, 40)} source; send it as { "type": "base64", "media_type", "data" }`);
  } else {
    // OpenAI Chat `{ image_url: { url } }` (or the bare string), Responses `{ image_url: "…" }`.
    url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    if (!url && part.file_id) throw refuse(adapterId, `image ${n} names an uploaded file (file_id); keysmith keeps no files — send the image inline, as a data: URL`);
  }
  if (url != null) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(String(url));
    if (!m) {
      const remote = /^https?:/i.test(String(url));
      throw refuse(
        adapterId,
        remote
          ? `image ${n} is a URL (${urlOrigin(url)}/…), and keysmith does not fetch images — send it inline: base64 in a data: URL (/v1/chat/completions) or a base64 source (/v1/messages)`
          : `image ${n} has no image data: expected a data: URL or a base64 source`,
      );
    }
    if (!/;base64$/i.test(m[2])) throw refuse(adapterId, `image ${n} is a data: URL without ;base64 — encode the image as base64`);
    [declared, data] = [m[1], m[3]];
  }
  const b64 = String(data ?? '').replace(/\s+/g, '');
  if (!b64) throw refuse(adapterId, `image ${n} is empty`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw refuse(adapterId, `image ${n} is not valid base64`);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > maxImageBytes) {
    throw refuse(adapterId, `image ${n} is ${size(bytes.length)}, over maxImageBytes=${size(maxImageBytes)} — scale it down, or raise the cap on this adapter`);
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    throw refuse(adapterId, `image ${n}${declared ? ` (declared ${String(declared).slice(0, 40)})` : ''} is not a JPEG, PNG, GIF or WebP image`);
  }
  return { mediaType, data: bytes.toString('base64') };
}

function size(n) {
  if (n < 1024) return `${n} bytes`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Does any message carry an image a vision CLI should see? */
export function hasImages(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.parts));
}

/**
 * The prompt of a vision run: `{ system, prompt }` as flattenMessages writes them, each image's
 * place marked, and `stdin(text)` — the stream-json line for `text` (the prompt as the adapter
 * finally sends it, system turn and any retry instruction included) with the marks replaced by
 * the images. Every image is read here, before any process starts: a bad one is a 400.
 */
export function visionPrompt(messages, { adapterId, maxImages = IMAGE_LIMITS.maxImages, maxImageBytes = IMAGE_LIMITS.maxImageBytes }) {
  // A mark no client can write: the nonce is new for every request.
  const nonce = randomBytes(8).toString('hex');
  const images = [];
  const image = (part) => {
    if (images.length >= maxImages) throw refuse(adapterId, `the request carries more than maxImages=${maxImages} images`);
    images.push(readImage(part, { adapterId, n: images.length + 1, maxImageBytes }));
    return `\u0000ks-image-${nonce}-${images.length - 1}\u0000`;
  };
  const { system, prompt } = flattenMessages(
    messages.map((m) => (m.parts ? { role: m.role, content: m.parts } : m)),
    { image },
  );
  const mark = new RegExp(`\u0000ks-image-${nonce}-(\\d+)\u0000`);
  const stdin = (text) => {
    const pieces = text.split(mark);
    const content = [];
    for (let i = 0; i < pieces.length; i++) {
      if (i % 2) {
        const { mediaType, data } = images[Number(pieces[i])];
        content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
      } else if (pieces[i].trim()) {
        // The Messages API refuses a text block of whitespace alone.
        content.push({ type: 'text', text: pieces[i] });
      }
    }
    return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  };
  return { system, prompt, images: images.length, stdin };
}
