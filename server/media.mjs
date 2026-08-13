// The picture store: content-addressed, sniffed, stripped, and deletable.
//
// A cid is the sha256 of the bytes and nothing else. That single fact is what
// lets a member verify a shard handed to them by a stranger, what lets the epoch
// block prove which bytes existed after they are gone, and what makes an
// immutable cache header honest rather than optimistic — a URL that names a hash
// can never answer with different bytes tomorrow.
//
// ── FOUR RULES, AND THE ORDER THEY RUN IN ──────────────────────────────────
//
// 1. A CEILING FIRST. Replication multiplies an upload onto strangers' devices,
//    so an 8 MB picture is 24 MB of somebody else's storage grant. The cap is
//    checked before anything else touches the bytes, because everything below is
//    work an attacker would otherwise get for free.
//
// 2. MAGIC BYTES, NEVER THE NAME AND NEVER THE HEADER. A file called .jpg is a
//    claim, a Content-Type is a claim, and members agreed to hold pictures. The
//    type is read out of the leading bytes and anything that is not one of the
//    three formats this host can actually strip is refused.
//
// 3. STRIP, THEN HASH. EXIF carries GPS coordinates, camera serial numbers and
//    timestamps, and a network that deletes a picture on a timer while leaving
//    the photographer's home address in a metadata block has deleted nothing
//    that mattered. The strip runs BEFORE the cid is computed, so the cid
//    addresses the bytes this host actually serves. A client that strips before
//    hashing computes the same cid and nothing is surprising; a client that does
//    not is told the canonical cid in the response and publishes under that.
//
// 4. THE BYTES CAN LEAVE. `forget` unlinks the object. That is what a settled
//    post's redaction actually is in this design: the log keeps the structure
//    and the cid — the commitment residue that proves which bytes existed — and
//    the bytes themselves are gone from the disk. server/log.mjs carries the
//    long version of why the deletion lives here and not in the log line.
//
// AVIF is deliberately absent, and the absence is the honest kind.
// core/replay.mjs allows image/avif because a future host may carry it; this
// host does not, because AVIF metadata lives in ISO-BMFF boxes this file does
// not parse, and storing bytes whose metadata cannot be stripped would be a
// promise the strip rule does not keep. A post naming an AVIF cid is refused for
// want of stored bytes, which is a narrower host and not a different rulebook.

import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { MAX_PAYLOAD_BYTES } from '../core/replay.mjs';

/** The types this host will hold, as leading bytes rather than as promises. */
export const MIME_SERVED = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** sha256 of bytes, lowercase hex, no prefix — a cid. */
export function cidOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const HEX64_RE = /^[0-9a-f]{64}$/;

/** Whether a string is shaped like a cid. Case-sensitive: one spelling, so one
 * path on disk and one cache key. */
export function isCid(v) {
  return typeof v === 'string' && HEX64_RE.test(v);
}

// ── sniffing ───────────────────────────────────────────────────────────────

function startsWith(bytes, sig, offset = 0) {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * The media type of these bytes, or null.
 *
 * Read from the leading bytes only. A JPEG starts FF D8 FF, a PNG carries the
 * eight-byte signature that also catches CR/LF mangling by an FTP client, and a
 * WebP is a RIFF container whose form type is "WEBP" four bytes later. Nothing
 * here consults a filename or a declared type, which is the whole point: both of
 * those are written by whoever is uploading.
 */
export function sniff(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

// ── stripping ──────────────────────────────────────────────────────────────

/**
 * Remove the metadata blocks that carry personal data, leaving the picture.
 *
 * Returns `null` when the container does not parse cleanly, and the caller
 * refuses the upload. That is stricter than sniffing and it is deliberate: a
 * file whose chunk walk runs off the end is a file this host cannot promise to
 * have stripped, and stripping what it could and storing the remainder would
 * turn "EXIF is removed" into "EXIF is usually removed". A truncated or crafted
 * container is refused whole.
 *
 * JPEG: every APP1..APP15 segment and every comment is dropped, and APP0/JFIF is
 * kept because it is a decoder hint and carries nothing about a person. Copying
 * stops at the start-of-scan marker: after it the file is entropy-coded data
 * with no segment structure, so it is copied verbatim rather than parsed.
 *
 * PNG: the text and time chunks go — eXIf, tEXt, zTXt, iTXt, tIME. Colour
 * management (iCCP, gAMA, cHRM, sRGB) stays, because dropping it changes what
 * the picture looks like. Each chunk carries its own CRC, so removing whole
 * chunks needs no recomputation.
 *
 * WebP: the EXIF and XMP chunks go, and the RIFF length in the header is
 * rewritten to match. The VP8X flag bits that claim the file has EXIF or XMP are
 * cleared too — a decoder that trusts the flag and finds no chunk is a decoder
 * looking at a file that lies about itself.
 *
 * Returns the original buffer untouched when there was nothing to remove, which
 * is the common case and keeps the cid of an already-clean upload equal to the
 * sha256 the client computed.
 */
export function stripMetadata(bytes, mime) {
  if (mime === 'image/jpeg') return stripJpeg(bytes);
  if (mime === 'image/png') return stripPng(bytes);
  if (mime === 'image/webp') return stripWebp(bytes);
  return bytes;
}

function stripJpeg(bytes) {
  const out = [bytes.subarray(0, 2)];
  let i = 2; // past SOI
  let dropped = false;
  let sawScan = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null; // a marker must be here and is not
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: after it the file is entropy-coded data with no segment
      // structure, so it is copied verbatim rather than parsed.
      sawScan = true;
      break;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (isMetadata) dropped = true;
    else out.push(bytes.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  if (!sawScan) return null;
  if (!dropped) return bytes;
  out.push(bytes.subarray(i));
  return Buffer.concat(out);
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(bytes) {
  const out = [bytes.subarray(0, 8)];
  let i = 8;
  let dropped = false;
  let sawEnd = false;
  while (i + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString('latin1');
    const total = 12 + length;
    if (length > bytes.length || i + total > bytes.length) return null;
    if (PNG_DROP.has(type)) dropped = true;
    else out.push(bytes.subarray(i, i + total));
    i += total;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) return null;
  if (!dropped) return bytes;
  return Buffer.concat(out);
}

function stripWebp(bytes) {
  if (bytes.length < 20) return null;
  const chunks = [];
  let i = 12;
  let dropped = false;
  while (i + 8 <= bytes.length) {
    const type = bytes.subarray(i, i + 4).toString('latin1');
    const size = bytes.readUInt32LE(i + 4);
    const padded = size + (size % 2);
    if (i + 8 + padded > bytes.length) return null;
    const chunk = Buffer.from(bytes.subarray(i, i + 8 + padded));
    if (type === 'EXIF' || type === 'XMP ') {
      dropped = true;
    } else {
      // VP8X byte 8 is the flag field; bit 3 is EXIF and bit 2 is XMP. A file
      // that claims metadata it no longer carries is a file decoders argue
      // about, so the claim is cleared with the chunk.
      if (type === 'VP8X' && chunk.length >= 9) chunk[8] &= ~0b00001100;
      chunks.push(chunk);
    }
    i += 8 + padded;
  }
  if (i !== bytes.length || chunks.length === 0) return null;
  if (!dropped) return bytes;
  const body = Buffer.concat(chunks);
  const head = Buffer.from(bytes.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4); // "WEBP" + the chunks that remain
  return Buffer.concat([head, body]);
}

// ── dimensions ─────────────────────────────────────────────────────────────

/**
 * The picture's pixel size, read out of the bytes.
 *
 * The client sends `w` and `h` in the post act and the app reserves the frame
 * from them before the bytes arrive, which is what makes the feed shift-free.
 * Reading them here is what stops that from being a claim: a post act whose
 * dimensions do not match its picture is refused, so the layout a reader
 * reserves is the layout the picture fills.
 */
export function dimensionsOf(bytes, mime) {
  try {
    if (mime === 'image/png') {
      if (bytes.length < 24) return null;
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') return jpegSize(bytes);
    if (mime === 'image/webp') return webpSize(bytes);
  } catch {
    return null;
  }
  return null;
}

function jpegSize(bytes) {
  let i = 2;
  while (i + 9 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xd0 && marker <= 0xd9) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // Any start-of-frame carries the size; C4, C8 and CC are tables and are not
    // frames, which is the one thing this loop has to get right.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { w: (bytes[i + 7] << 8) | bytes[i + 8], h: (bytes[i + 5] << 8) | bytes[i + 6] };
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = bytes.subarray(i, i + 4).toString('latin1');
    const size = bytes.readUInt32LE(i + 4);
    const body = i + 8;
    if (type === 'VP8X' && bytes.length >= body + 10) {
      const w = 1 + (bytes[body + 4] | (bytes[body + 5] << 8) | (bytes[body + 6] << 16));
      const h = 1 + (bytes[body + 7] | (bytes[body + 8] << 8) | (bytes[body + 9] << 16));
      return { w, h };
    }
    if (type === 'VP8 ' && bytes.length >= body + 10) {
      return {
        w: bytes.readUInt16LE(body + 6) & 0x3fff,
        h: bytes.readUInt16LE(body + 8) & 0x3fff,
      };
    }
    if (type === 'VP8L' && bytes.length >= body + 5) {
      const b = bytes.readUInt32LE(body + 1);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    i += 8 + size + (size % 2);
  }
  return null;
}

// ── the store ──────────────────────────────────────────────────────────────

/** The refusal a store operation throws. The code is from the catalogue and
 * server/index.mjs turns it into the four-field body and the right status. */
function refusal(code, detail) {
  const err = new Error(code);
  err.code = code;
  err.detail = detail || null;
  return err;
}

/**
 * Open the content-addressed store under `dir`.
 *
 * Objects are fanned out one level by the first two hex characters of the cid,
 * so a network with a hundred thousand pictures does not put a hundred thousand
 * entries in one directory.
 */
export async function openStore({ dir, maxBytes = MAX_PAYLOAD_BYTES } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('openStore: dir is required');
  const root = resolve(dir);
  await mkdir(root, { recursive: true });

  const pathOf = (cid) => join(root, cid.slice(0, 2), cid);

  return {
    root,
    maxBytes,

    /**
     * Store bytes and return what they are.
     *
     * `declaredCid` is optional and is checked against the cid of the bytes as
     * stored. When it disagrees the upload is refused whole: a store that
     * accepted a mismatch would let the payload commitment in an epoch block
     * prove the existence of bytes nobody ever served.
     *
     * Writing goes through a temporary file and a rename, so a reader never sees
     * a half-written object under a name that promises a complete one.
     */
    async put(bytes, declaredCid) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (buf.length === 0) throw refusal('BAD_REQUEST', { bytes: 0 });
      if (buf.length > maxBytes) throw refusal('PAYLOAD_TOO_LARGE', { bytes: buf.length, max: maxBytes });

      const mime = sniff(buf);
      if (!mime) throw refusal('MIME_REFUSED', { served: MIME_SERVED, sniffed: null });

      const clean = stripMetadata(buf, mime);
      if (clean === null) {
        throw refusal('MIME_REFUSED', {
          mime,
          why: 'the container does not parse to the end, so this host cannot promise its metadata was removed',
        });
      }
      const cid = cidOf(clean);
      if (declaredCid !== undefined && declaredCid !== null) {
        if (!isCid(declaredCid)) throw refusal('BAD_REQUEST', { cid: String(declaredCid) });
        if (declaredCid !== cid) {
          throw refusal('CID_MISMATCH', {
            declared: declaredCid,
            actual: cid,
            strippedBytes: buf.length - clean.length,
          });
        }
      }

      const size = dimensionsOf(clean, mime);
      if (!size || !size.w || !size.h) throw refusal('MIME_REFUSED', { mime, dimensions: null });

      const target = pathOf(cid);
      await mkdir(join(root, cid.slice(0, 2)), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(clean);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);

      return { cid, bytes: clean.length, mime, w: size.w, h: size.h, strippedBytes: buf.length - clean.length };
    },

    /** Whether these bytes are still here. A settled post answers false. */
    async has(cid) {
      if (!isCid(cid)) return false;
      try {
        await stat(pathOf(cid));
        return true;
      } catch {
        return false;
      }
    },

    /** What the store knows about an object without reading it. */
    async describe(cid) {
      if (!isCid(cid)) return null;
      try {
        const s = await stat(pathOf(cid));
        return { cid, bytes: s.size, path: pathOf(cid) };
      } catch {
        return null;
      }
    },

    /** The bytes, or null. Callers serve these under an immutable header. */
    async get(cid) {
      if (!isCid(cid)) return null;
      try {
        const bytes = await readFile(pathOf(cid));
        return { cid, bytes, mime: sniff(bytes) };
      } catch {
        return null;
      }
    },

    /** One shard of an object, for answering a capacity challenge. */
    async shard(cid, index, shardBytes) {
      const object = await this.get(cid);
      if (!object) return null;
      const start = index * shardBytes;
      if (start >= object.bytes.length) return null;
      return object.bytes.subarray(start, Math.min(start + shardBytes, object.bytes.length));
    },

    /**
     * Delete the bytes. This is what settlement does.
     *
     * Returns whether anything was there, so a caller can tell a redaction that
     * happened from one that had already happened. Deleting twice is not an
     * error: settlement is permissionless and idempotent by design.
     */
    async forget(cid) {
      if (!isCid(cid)) return false;
      try {
        await unlink(pathOf(cid));
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      }
    },

    /** For tests and for a host being decommissioned. */
    async destroy() {
      await rm(root, { recursive: true, force: true });
    },

    /**
     * The headers a cid is served under.
     *
     * Immutable and a year long, which is only honest because the URL names a
     * hash: the bytes at this address cannot change, so there is nothing for a
     * cache to be wrong about. The etag is the cid for the same reason.
     * `no-transform` is there because a proxy that recompresses a picture
     * changes its bytes and therefore breaks its own address.
     */
    headersFor(cid, mime, length) {
      return {
        'content-type': mime || 'application/octet-stream',
        'content-length': String(length),
        'cache-control': 'public, max-age=31536000, immutable, no-transform',
        etag: `"${cid}"`,
        'x-content-type-options': 'nosniff',
      };
    },
  };
}
