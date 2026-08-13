// Canonical encoding: one byte sequence per value, or a refusal.
//
// ARCHITECTURE §9 states the requirement in one sentence — "two verifiers
// either match bits or can attribute the difference, there is no third
// outcome" — and this file is the whole of that promise. Everything the epoch
// chain commits to goes through here first: act hashes, payload hashes, the
// state package, the block itself. If two nodes encode the same world into two
// different byte strings, every root downstream disagrees and nobody can say
// why. So the encoding is fixed, narrow, and refuses anything it cannot
// represent exactly.
//
// The rules, and why each one is here:
//
//   - Object keys are sorted by UTF-16 code unit. Not by locale, not by
//     insertion order. `Array.prototype.sort` with no comparator is exactly
//     this ordering and is specified to the letter in ECMA-262, so every
//     conforming engine produces the same sequence.
//   - Numbers print through Number::toString — the shortest string that round
//     trips back to the same double. Also fully specified, also identical
//     everywhere.
//   - NaN and the infinities are REFUSED rather than nulled. JSON.stringify
//     writes `null` for all three, which would hash two different corruptions
//     to the same digest and lose the fact that anything went wrong.
//   - BigInt is written as a decimal STRING. JSON has one numeric type and it
//     is a double; a wei balance past 2^53 written as a JSON number is a
//     number nobody can read back. Quoting it keeps the digits and makes the
//     type visible to a reader: money in this record is always in quotes.
//   - Inexact numbers are rounded to a published quantum before printing.
//
// The quantum is the honest part. This file can promise that two engines print
// the same double identically; it cannot promise that two engines' Math.exp or
// Math.pow land on the same double in the first place. Rounding every
// non-integer to 1e-9 before it is hashed absorbs that low-bit disagreement,
// and the quantum is published with the roots that depend on it, so the
// residual risk is stated rather than hidden. Every quantity that must be
// exact — balances, reserves, prices, supply — is a BigInt and never touches
// this path at all.

// NO node: IMPORT. This module is the bottom of the shared layer, and the shared
// layer has to run unchanged in a browser — Rule 2 is a claim about bytes, so
// the browser must import THIS file and not a restatement of it.
//
// `import { createHash } from 'node:crypto'` here was doing exactly the damage
// the rule exists to prevent, in two places at once. It made the app fail at its
// first import on any real page ("Access to script at 'node:crypto' has been
// blocked"), which no test caught because every test runs in Node. And because
// it could not be imported, app/wallet.mjs RESTATED the canonical encoder — a
// second implementation of the one encoding every signature is taken over,
// defended by a byte-identity test. That is the arrangement this lineage has
// already paid for twice.
//
// WebCrypto's digest is async and would make sha256Hex return a promise, which
// would turn every hash site in the codebase into an await. So the algorithm
// itself is here: FIPS 180-4, ~70 lines, synchronous, identical in both
// runtimes, and checked against node:crypto in test/canonical.test.mjs.

// ── sha256, self-contained and synchronous ─────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// FIPS 180-4 sha256 over a byte array. Returns 32 bytes.
function sha256Bytes(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6; // message + 0x80 + 8-byte length, padded to 64
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  // The bit length is 64 bits big-endian. len * 8 stays exact as a double well
  // past any payload this network carries, so the split is arithmetic, not <<.
  view.setUint32(total - 8, Math.floor((len * 8) / 4294967296), false);
  view.setUint32(total - 4, (len * 8) >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return out;
}

const UTF8 = new TextEncoder();


/**
 * The published rounding quantum for inexact values: 1e-9.
 *
 * Fine enough that nothing user-visible loses meaning — the unit of account is
 * the nanoeuro (ARCHITECTURE §3), which is itself an integer, and weighting
 * math is quantised back to integers before it reaches a balance — and coarse
 * enough to absorb the last bits of a transcendental computed on a foreign
 * engine. It is a constant in this file and a field in the block that carries
 * the hash, so a verifier never has to guess which one was in force.
 */
export const QUANTUM = 1e-9;

/**
 * Round an inexact number to the published quantum.
 *
 * Scaling by 1e9 and dividing back — rather than multiplying by 1e-9, which is
 * not exactly representable — keeps the result the correctly rounded double
 * nearest a decimal with at most nine fractional digits, which is the double
 * whose shortest round-trip form is that decimal.
 *
 * Integers are returned untouched: they are already exact, and rounding them
 * would only risk losing digits above 2^53. Values so large that the scaled
 * form leaves the safe-integer range are also returned untouched, because
 * there the gap between adjacent doubles already exceeds the quantum and
 * rounding to it would be a lie about the precision available.
 */
function quantize(x) {
  if (!Number.isFinite(x)) throw new Error('canonical: non-finite number');
  if (Number.isInteger(x)) return x === 0 ? 0 : x;
  const scaled = Math.round(x * 1e9);
  if (!Number.isSafeInteger(scaled)) return x;
  const r = scaled / 1e9;
  // −0 and 0 print differently ("0" and "0" under JSON.stringify, but they are
  // distinguishable values elsewhere); collapse them so a sign that carries no
  // information cannot change a hash.
  return Object.is(r, -0) ? 0 : r;
}

// Objects that would encode to something misleading are refused rather than
// silently flattened. A Date through Object.keys is `{}`, a Map is `{}`, a
// boxed `new Number(5)` is `{}` — and so is `new Number(6)`, which is a live
// collision between two different values, not merely a lossy encoding.
//
// Naming the exotic types one by one was the first attempt and it leaked:
// boxed primitives, RegExp, Error and anything from Object.create(proto) all
// slipped through to `{}`. So the test is inverted — only a plain object or a
// plain array is admitted, and everything else is refused by default. A new
// exotic type invented tomorrow is refused without this file being touched.
const PLAIN_OBJECT_PROTOS = new Set([Object.prototype, null]);

function refuseExotic(v) {
  const tag = Object.prototype.toString.call(v);
  if (tag !== '[object Object]' && tag !== '[object Array]') {
    throw new Error('canonical: ' + tag + ' — encode a plain object, array, string or integer instead');
  }
  if (tag === '[object Object]' && !PLAIN_OBJECT_PROTOS.has(Object.getPrototypeOf(v))) {
    throw new Error('canonical: object with a prototype — encode a plain object instead');
  }
}

/**
 * How deep a committed structure may nest.
 *
 * Acts arrive from a public append-only log, so the encoder is reachable by
 * anyone. Unbounded recursion made one hostile act — a twenty-thousand-deep
 * array — crash the writer AND every reader replaying the log after it, which
 * turns a cheap message into a network-wide halt. The bound is published the
 * same way QUANTUM is, because a limit that verifiers do not share is a limit
 * that splits them.
 */
export const MAX_DEPTH = 64;

// A bigint and its own decimal string used to encode to identical bytes, so
// 1000000n and "1000000" sealed to one sha256 — two verifiers could agree on a
// stateRoot while holding different worlds, which is exactly the third outcome
// §9 says cannot exist. The sigil separates the domains: a bigint is written
// with a leading "~", and any string that already starts with "~" gets one
// more. The map is injective (strip one "~" to decode, and a value that had
// none was never a bigint), and no identifier this protocol commits to — an
// address, a handle, a hex digest, an act kind — begins with "~", so published
// blocks read exactly as they always did.
const BIGINT_SIGIL = '~';

function encodeString(s) {
  return JSON.stringify(s.startsWith(BIGINT_SIGIL) ? BIGINT_SIGIL + s : s);
}

/**
 * Encode a value to its canonical JSON string.
 *
 * The output is ordinary JSON — any parser reads it — but exactly one byte
 * string corresponds to any given value, which ordinary JSON does not
 * guarantee. Undefined properties are dropped, matching JSON.stringify, so an
 * object that never had a key and one whose key is explicitly undefined encode
 * alike; `undefined` inside an array is refused instead, because JSON.stringify
 * would turn it into `null` and change the length of nothing while changing the
 * meaning of everything.
 *
 * Cycles are refused. Getters are read exactly once, in sorted-key order, so a
 * lazily computed field settles at the moment it is encoded.
 */
export function canonicalJson(value, seen, depth) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'bigint') return JSON.stringify(BIGINT_SIGIL + value.toString(10));
  if (t === 'number') return JSON.stringify(quantize(value));
  if (t === 'string') return encodeString(value);
  if (t === 'undefined') throw new Error('canonical: undefined');
  if (t !== 'object') throw new Error('canonical: cannot encode ' + t);
  refuseExotic(value);
  depth = depth || 0;
  if (depth >= MAX_DEPTH) throw new Error('canonical: nested deeper than ' + MAX_DEPTH);
  seen = seen || new Set();
  if (seen.has(value)) throw new Error('canonical: cycle');
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    const parts = [];
    for (const x of value) {
      if (x === undefined) throw new Error('canonical: undefined in array');
      parts.push(canonicalJson(x, seen, depth + 1));
    }
    out = '[' + parts.join(',') + ']';
  } else {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const x = value[k]; // reading the property settles any getter
      if (x === undefined) continue;
      parts.push(encodeString(k) + ':' + canonicalJson(x, seen, depth + 1));
    }
    out = '{' + parts.join(',') + '}';
  }
  seen.delete(value);
  return out;
}

/**
 * The canonical bytes of a value: its canonical JSON in UTF-8.
 *
 * Hashing goes through bytes, never through a string, so the encoding is named
 * once here instead of being assumed at every call site. Returns a Buffer,
 * which is a Uint8Array — callers that want the plain view already have it.
 */
export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

/**
 * sha256 of bytes, lowercase hex, no prefix.
 *
 * sha256 and not keccak: the anchor contract verifies sha256 roots
 * (ARCHITECTURE §9 seals sha256 hashes, and the same digest is what the chain
 * builder and the browser can both compute with nothing installed). A string
 * argument is hashed as UTF-8, which is only a convenience for hashing a
 * canonical JSON string you already have in hand.
 *
 * The hex carries no "0x": it is a digest in a JSON document, not an EVM word.
 * A caller handing one to a `bytes32` parameter prefixes it there.
 */
export function sha256Hex(bytes) {
  const input = typeof bytes === 'string' ? UTF8.encode(bytes) : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const out = sha256Bytes(input);
  let s = '';
  for (let i = 0; i < out.length; i++) s += HEX[out[i]];
  return s;
}

// ── the canonical sigil, read backwards ────────────────────────────────────
//
// core/canonical.mjs writes a bigint as a string with a leading "~", and gives
// any string that already starts with "~" one more, so the two domains cannot
// collide. The map is injective and this is its inverse. It exists because a
// canonical document that has been through JSON.parse holds strings where the
// value was a bigint, and re-encoding those strings would add a second sigil and
// change every hash downstream. A reader that does not decode the sigil cannot
// read a canonical log or a canonical chain — it can only read something that
// looks like one.

function reviveScalar(s) {
  if (!s.startsWith('~')) return s;
  if (s.startsWith('~~')) return s.slice(1);
  const body = s.slice(1);
  if (/^-?(0|[1-9][0-9]*)$/.test(body)) return BigInt(body);
  // A single sigil followed by something that is not a decimal cannot have been
  // produced by the encoder in either domain. Refusing is the only honest answer:
  // guessing would silently change a value nobody can audit afterwards.
  throw new Error('canonical: malformed sigil ' + JSON.stringify(s));
}

/**
 * A KEY is never a bigint, and decoding it as one is a way to lose a field.
 *
 * Object keys in JavaScript are strings, so the encoder can only ever have
 * produced a key by the string rule: no sigil, or one sigil added to a string
 * that already began with one. A key of the form "~123" is therefore not
 * something this encoder can emit — and reviving it as a bigint would put
 * `123n` in a property position, where it silently becomes the key "123" and
 * re-encodes to different bytes. So a single sigil in a key is refused rather
 * than interpreted.
 */
function reviveKey(k) {
  if (!k.startsWith('~')) return k;
  if (k.startsWith('~~')) return k.slice(1);
  throw new Error('canonical: malformed sigil in key ' + JSON.stringify(k));
}

/**
 * Decode a JSON.parse'd canonical document back into the values it encoded.
 *
 * Objects and arrays are rebuilt rather than mutated in place, so a caller's
 * parsed input is never altered under it. Numbers, booleans and null pass
 * through: they encode as themselves.
 */
export function reviveCanonical(value) {
  if (typeof value === 'string') return reviveScalar(value);
  if (Array.isArray(value)) return value.map(reviveCanonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[reviveKey(k)] = reviveCanonical(value[k]);
    return out;
  }
  return value;
}

/**
 * Parse a line of canonical JSON back into the values it encoded.
 *
 * This is the ONLY correct way to read a canonical log, a canonical block, or
 * anything else this module wrote. `JSON.parse` alone is not: it hands back the
 * sigilled strings, so a bigint balance returns as the string "~1000" and a
 * user's own text that began with "~" comes back with an extra one. Both then
 * re-encode to different bytes, which is how a writer ends up accepting acts
 * that a replay of its own log skips — a Rule 2 violation reached without
 * anybody writing a second rulebook.
 */
export function parseCanonical(text) {
  return reviveCanonical(JSON.parse(text));
}
