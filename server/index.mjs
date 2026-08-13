// The writer: node:http, no framework, one act log, one door for writes.
//
// This process decides nothing about what is true. core/replay.mjs decides that,
// and this file imports the same module the browser and the chain builder
// import. What the writer decides is narrower and is the only thing a single
// machine is allowed to decide in this design: WHAT GETS WRITTEN DOWN, AND IN
// WHAT ORDER. Everything a reader wants — balances, feeds, earnings, reserves —
// comes back out of replay over the log it wrote, never out of a cache
// maintained by hand beside it.
//
// ── THE ORDER OF CHECKS, WHICH IS THE WHOLE DESIGN ─────────────────────────
//
// Every write goes through exactly one function, `submit`, and it runs its
// checks in this order for a reason:
//
//   1. SIGNATURE. The address is recovered from an EIP-191 personal_sign over
//      the canonical act body minus `sig` and `i`, and compared with `as`. There
//      are no passwords and no server-held secrets, so this is the entire
//      authentication system: without it `as` is a claim anyone can type.
//
//   2. actError(world, act) — THE RULEBOOK, BEFORE ANY OPINION OF THIS HOST'S.
//      ARCHITECTURE rule 2: a server may not accept what replay would skip. It
//      is checked here, against the live world, with the index the act is about
//      to receive already attached, so that nothing applyAct checks is left for
//      after the append.
//
//   3. THE HOST'S OWN CHECKS, and only then. Whether the picture's bytes are
//      really here, whether two explorers agree about a bitcoin transaction,
//      whether a capacity answer hashes correctly, whether the stamp is near
//      this host's clock. Every one of them is something replay CANNOT do —
//      replay may not read bytes, a network or a clock — and every one of them
//      can only ever refuse an act replay would have accepted. That direction
//      matters: a host is allowed to be stricter than the rulebook and is never
//      allowed to be looser, and putting these after `actError` is what makes
//      the refusal a caller gets for a bad act the RULEBOOK'S refusal rather
//      than an accident of which check happened to run first.
//
//   4. APPEND, then APPLY. The line is on the disk and fsynced before the world
//      moves and before the caller is told anything.
//
// ── ONE DOOR ───────────────────────────────────────────────────────────────
//
// There is a single path into the log and it is `submit`. POST /api/v1/act and
// the convenience alias POST /api/v1/pool/swap both call it, so a bot cannot be
// validated more loosely, authenticated differently or exempted from the
// economy. A second door is how a rule ends up enforced in one place and not the
// other.
//
// ── ONE QUEUE, AND WHAT IS NOT ALLOWED TO HOLD IT ──────────────────────────
//
// Steps 2 to 4 run under a single write queue, because every `await` is a place
// another request interleaves and two submissions between `actError` and
// `append` would validate against a world that no longer exists. That queue is
// therefore a lock on every write this host accepts, and NOTHING THAT DEPENDS ON
// A THIRD PARTY MAY BE AWAITED WHILE IT IS HELD. One check does depend on one —
// a `burnClaim` asks two bitcoin explorers — so it is taken out: the queued pass
// stops at that check, the explorers are asked with the queue released, and the
// act re-enters carrying the answer. What that costs is stated where it happens:
// the only fact that can go stale in the gap is who has already claimed the
// output, and it is re-read under the queue.
//
// ── WHAT THIS HOST HOLDS ───────────────────────────────────────────────────
//
// No wallet and no spendable key. It verifies signatures and makes none of its
// own except the Ed25519 producer key that attests what rate it published, which
// can move no money by construction. The bitcoin burn output has no key at all
// (server/burnwatch.mjs derives it rather than pasting it), so nobody can spend
// what was destroyed — including whoever runs this process.

import { createServer as createHttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PARAMS } from '../core/params.mjs';
import { E, httpFor, list as errorList, refuse } from '../core/errors.mjs';
import { MAX_DEPTH, canonicalBytes, canonicalJson, sha256Hex } from '../core/canonical.mjs';
import { quote as poolQuote, spotSatPerPtp, MINIMUM_LIQUIDITY } from '../core/amm.mjs';
import {
  actionPriceNanoEur,
  formatEur,
  nanoEurToSubSat,
  priceOf,
  ptpWeiToNanoEur,
} from '../core/pricing.mjs';
import {
  EDITION as REPLAY_EDITION,
  MAX_ACT_BYTES,
  MAX_COMMENT_CHARS,
  MAX_PAYLOAD_BYTES,
  SHARD_BYTES,
  actError,
  applyAct,
  replay,
} from '../core/replay.mjs';
import { VERSION as RULES_VERSION } from '../core/rules/v1.mjs';

import { openLog } from './log.mjs';
import { MIME_SERVED, isCid, openStore } from './media.mjs';
import { BURN_SCRIPT_HEX, MIN_CONFIRMATIONS, burnFacts, checkBurn, defaultExplorers } from './burnwatch.mjs';
import { producerKey, publicSources, readOracle, sealOracle } from './oracle.mjs';
import { challengesFor, createChallengeRegister, epochSeed, ledger as capacityLedger, verifyProof } from './capacity.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

// ═══════════════════════════════════════════════════════════════════════════
// keccak256 — FIPS 202's permutation with the original Keccak padding.
//
// Ethereum addresses are the last twenty bytes of keccak256 of an uncompressed
// public key, and EIP-191 hashes with the same function. `ethers` is the
// declared dependency and is used when it loads, but the writer must come up on
// a checkout where it has not been installed — a host that cannot verify a
// signature is a host that accepts forged acts — so the primitive is here in
// full rather than assumed. It is ~60 lines, it is exercised against published
// vectors in test/server.test.mjs, and it is cross-checked against ethers at
// start-up whenever ethers is present.
//
// The padding byte is 0x01 and not 0x06: this is Keccak as Ethereum shipped it,
// before SHA-3 changed the domain separator. The two produce different digests
// for every input, so getting this byte wrong would produce plausible-looking
// addresses that belong to nobody.
// ═══════════════════════════════════════════════════════════════════════════

const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl64(x, n) {
  return n === 0n ? x : ((x << n) | (x >> (64n - n))) & MASK64;
}

function keccakF(A) {
  const C = new Array(5);
  const D = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];

    // rho and pi, walked as one cycle rather than written out as a table of
    // twenty-four offsets — the cycle IS the definition, and a table is a place
    // for a typo nothing would catch.
    let x = 1;
    let y = 0;
    let current = A[1];
    for (let t = 0; t < 24; t++) {
      const r = BigInt((((t + 1) * (t + 2)) / 2) % 64);
      const Y = (2 * x + 3 * y) % 5;
      x = y;
      y = Y;
      const idx = x + 5 * y;
      const held = A[idx];
      A[idx] = rotl64(current, r);
      current = held;
    }

    for (let yy = 0; yy < 5; yy++) {
      const b0 = A[5 * yy], b1 = A[1 + 5 * yy], b2 = A[2 + 5 * yy], b3 = A[3 + 5 * yy], b4 = A[4 + 5 * yy];
      A[0 + 5 * yy] = b0 ^ ((~b1 & MASK64) & b2);
      A[1 + 5 * yy] = b1 ^ ((~b2 & MASK64) & b3);
      A[2 + 5 * yy] = b2 ^ ((~b3 & MASK64) & b4);
      A[3 + 5 * yy] = b3 ^ ((~b4 & MASK64) & b0);
      A[4 + 5 * yy] = b4 ^ ((~b0 & MASK64) & b1);
    }
    A[0] ^= KECCAK_RC[round];
  }
}

export function keccak256(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136;
  const padLen = rate - (bytes.length % rate);
  const padded = Buffer.alloc(bytes.length + padLen);
  bytes.copy(padded);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < 17; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// secp256k1 — public key recovery, and a signer for the tests and for a bot.
//
// Recovery is the half the writer needs: given a message, an (r, s, v) and
// nothing else, work out which address signed. Jacobian coordinates keep it to
// one modular inversion per operation instead of one per bit, which is the
// difference between a signature check costing single-digit milliseconds and
// costing a fifth of a second.
//
// `signMessage` is here so that a test and a bot can produce exactly what this
// server verifies, from one implementation rather than two that might disagree.
// It takes a key from its caller and keeps none: the host still holds no wallet.
// ═══════════════════════════════════════════════════════════════════════════

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  z: 1n,
};
const INF = { x: 0n, y: 0n, z: 0n };

const fmod = (a, m) => ((a % m) + m) % m;

function modPow(base, exp, m) {
  let result = 1n;
  let b = fmod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

// P and N are prime, so Fermat gives the inverse and there is no extended
// Euclid to get the sign of wrong.
const modInv = (a, m) => modPow(a, m - 2n, m);

function jDouble(p) {
  if (p.z === 0n || p.y === 0n) return INF;
  const A = (p.x * p.x) % P;
  const B = (p.y * p.y) % P;
  const C = (B * B) % P;
  const D = fmod(2n * (((p.x + B) * (p.x + B)) % P) - 2n * A - 2n * C, P);
  const Ecoef = (3n * A) % P;
  const F = (Ecoef * Ecoef) % P;
  const x3 = fmod(F - 2n * D, P);
  const y3 = fmod(Ecoef * fmod(D - x3, P) - 8n * C, P);
  const z3 = fmod(2n * p.y * p.z, P);
  return { x: x3, y: y3, z: z3 };
}

function jAdd(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const Z1Z1 = (p.z * p.z) % P;
  const Z2Z2 = (q.z * q.z) % P;
  const U1 = (p.x * Z2Z2) % P;
  const U2 = (q.x * Z1Z1) % P;
  const S1 = (((p.y * q.z) % P) * Z2Z2) % P;
  const S2 = (((q.y * p.z) % P) * Z1Z1) % P;
  const H = fmod(U2 - U1, P);
  const r = fmod(S2 - S1, P);
  if (H === 0n) return r === 0n ? jDouble(p) : INF;
  const HH = (H * H) % P;
  const HHH = (H * HH) % P;
  const V = (U1 * HH) % P;
  const x3 = fmod(r * r - HHH - 2n * V, P);
  const y3 = fmod(r * fmod(V - x3, P) - S1 * HHH, P);
  const z3 = (((p.z * q.z) % P) * H) % P;
  return { x: x3, y: y3, z: z3 };
}

function jMul(k, point) {
  let acc = INF;
  let add = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) acc = jAdd(acc, add);
    add = jDouble(add);
    n >>= 1n;
  }
  return acc;
}

function toAffine(p) {
  if (p.z === 0n) return null;
  const zi = modInv(p.z, P);
  const zi2 = (zi * zi) % P;
  return { x: (p.x * zi2) % P, y: (((p.y * zi2) % P) * zi) % P };
}

const toBig = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'));
const to32 = (v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex');

/** The address of an uncompressed public key: keccak of x||y, last twenty
 * bytes, one spelling (lowercase) so the world is never keyed two ways. */
function addressFromPoint(point) {
  return '0x' + keccak256(Buffer.concat([to32(point.x), to32(point.y)])).subarray(12).toString('hex');
}

/** The address that owns a private key. Used by tests, bots and the epoch
 * closer; the server itself never calls it. */
export function addressOf(privHex) {
  const d = BigInt(privHex.startsWith('0x') ? privHex : '0x' + privHex);
  if (d <= 0n || d >= N) throw new Error('BAD_ADDRESS');
  return addressFromPoint(toAffine(jMul(d, G)));
}

/**
 * EIP-191's version byte and its label, written as a code point rather than as
 * a literal: 0x19 is a control character that no editor shows, and a prefix
 * nobody can see is a prefix nobody can check.
 */
const EIP191_PREFIX = String.fromCharCode(0x19) + 'Ethereum Signed Message:\n';

/** The EIP-191 personal_sign digest of a message. The length in the prefix is a
 * BYTE length, which is why the message travels as bytes and never as a string
 * that somebody might measure in UTF-16 code units. */
export function personalHash(message) {
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  const prefix = Buffer.from(EIP191_PREFIX + msg.length, 'utf8');
  return keccak256(Buffer.concat([prefix, msg]));
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** Deterministic ECDSA (RFC 6979) over a digest, returning `0x` r‖s‖v. Low-s
 * normalised, because a high-s signature is the same signature with the other
 * sign and accepting both would make one act two distinct signed bodies. */
export function signHash(hash32, privHex) {
  const d = BigInt(privHex.startsWith('0x') ? privHex : '0x' + privHex);
  if (d <= 0n || d >= N) throw new Error('BAD_ADDRESS');
  const x = to32(d);
  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  k = hmac(k, Buffer.concat([v, Buffer.from([0]), x, hash32]));
  v = hmac(k, v);
  k = hmac(k, Buffer.concat([v, Buffer.from([1]), x, hash32]));
  v = hmac(k, v);
  const e = fmod(toBig(hash32), N);
  for (let guard = 0; guard < 64; guard++) {
    v = hmac(k, v);
    const kCand = toBig(v);
    if (kCand > 0n && kCand < N) {
      const R = toAffine(jMul(kCand, G));
      const r = fmod(R.x, N);
      if (r !== 0n) {
        let s = fmod(modInv(kCand, N) * (e + r * d), N);
        if (s !== 0n) {
          let recId = (R.y & 1n) === 1n ? 1 : 0;
          if (R.x >= N) recId |= 2;
          if (s > N / 2n) {
            s = N - s;
            recId ^= 1;
          }
          return '0x' + to32(r).toString('hex') + to32(s).toString('hex') + (27 + recId).toString(16).padStart(2, '0');
        }
      }
    }
    k = hmac(k, Buffer.concat([v, Buffer.from([0])]));
    v = hmac(k, v);
  }
  throw new Error('BAD_SIGNATURE');
}

/** Sign a message the way a wallet's personal_sign would. */
export function signMessage(message, privHex) {
  return signHash(personalHash(message), privHex);
}

/** The address a signature recovers to, or null. Never throws on hostile input:
 * a malformed signature is a refusal, not a crash. */
export function recoverAddressBuiltin(message, sigHex) {
  try {
    const hex = String(sigHex).startsWith('0x') ? String(sigHex).slice(2) : String(sigHex);
    if (hex.length !== 130 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    const sig = Buffer.from(hex, 'hex');
    const r = toBig(sig.subarray(0, 32));
    const s = toBig(sig.subarray(32, 64));
    let recId = sig[64];
    if (recId >= 27) recId -= 27;
    if (recId < 0 || recId > 3) return null;
    if (r <= 0n || r >= N || s <= 0n || s >= N) return null;

    const xr = r + (recId >= 2 ? N : 0n);
    if (xr >= P) return null;
    const ySq = fmod(modPow(xr, 3n, P) + 7n, P);
    let y = modPow(ySq, (P + 1n) / 4n, P);
    if ((y * y) % P !== ySq) return null;
    if ((y & 1n) !== BigInt(recId & 1)) y = P - y;

    const hash = personalHash(message);
    const e = fmod(toBig(hash), N);
    const R = { x: xr, y, z: 1n };
    const sum = jAdd(jMul(s, R), jMul(fmod(N - e, N), G));
    const Q = toAffine(jMul(modInv(r, N), sum));
    return Q ? addressFromPoint(Q) : null;
  } catch {
    return null;
  }
}

// ethers is the declared dependency and is preferred where it loads, because an
// audited curve implementation should be doing this if one is present. The
// built-in is the fallback and the two are cross-checked at start-up on a fixed
// vector: a silent divergence between them would mean one build accepts acts
// another rejects, which is a fork with no fork in it.
let ethersMod = null;
try {
  ethersMod = await import('ethers');
} catch {
  ethersMod = null;
}

export const SIGNATURE_VERIFIER = ethersMod ? 'ethers' : 'built-in';

export function recoverAddress(message, sigHex) {
  if (ethersMod) {
    try {
      return ethersMod.verifyMessage(Buffer.isBuffer(message) ? new Uint8Array(message) : message, sigHex).toLowerCase();
    } catch {
      return null;
    }
  }
  return recoverAddressBuiltin(message, sigHex);
}

/**
 * Check the curve before anything is allowed to use it, at import.
 *
 * core/params.mjs runs its invariants at load for the same reason and it is the
 * right instinct here too: a signature check that is subtly wrong does not fail
 * loudly, it accepts forged acts and writes them into a permanent record. So the
 * smallest private key's address — a value published in every Ethereum test
 * fixture there is — is derived and compared, and a round trip through the
 * signer and the recoverer is run, before this module finishes loading.
 *
 * When ethers IS installed the two implementations are compared on the same
 * vector. A divergence between them would mean one build of this host accepts
 * acts another rejects, which is a fork with no fork in it, and it stops the
 * process rather than being logged.
 */
(function selfCheck() {
  const one = '0x' + '00'.repeat(31) + '01';
  const expected = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
  if (addressOf(one) !== expected) {
    throw new Error(`SIGNATURE_SELFCHECK: keccak or the curve is wrong — key 1 derives ${addressOf(one)}, not ${expected}`);
  }
  const probe = Buffer.from('ptp/signature-self-check', 'utf8');
  const sig = signMessage(probe, one);
  const mine = recoverAddressBuiltin(probe, sig);
  if (mine !== expected) {
    throw new Error(`SIGNATURE_SELFCHECK: a signature does not recover to its own signer (${mine})`);
  }
  if (ethersMod) {
    let theirs = null;
    try {
      theirs = ethersMod.verifyMessage(new Uint8Array(probe), sig).toLowerCase();
    } catch (err) {
      throw new Error(`SIGNATURE_SELFCHECK: ethers rejected a signature this build produced — ${err && err.message}`);
    }
    if (theirs !== mine) {
      throw new Error(`SIGNATURE_SELFCHECK: ethers recovers ${theirs} where the built-in recovers ${mine}`);
    }
  }
})();

/**
 * The exact bytes an act is signed over: the canonical act body without `sig`
 * and without `i`.
 *
 * `sig` is excluded because it cannot cover itself. `i` is excluded because the
 * writer assigns it on acceptance — a client that signed an index would be
 * guessing at a number only the log can know, and would be wrong the moment two
 * acts arrived at once.
 *
 * Canonical JSON, so key order is not a thing two implementations can disagree
 * about. Any change to any field changes what must be signed.
 */
export function signingBytes(act) {
  const body = { ...act };
  delete body.sig;
  delete body.i;
  return canonicalBytes(body);
}

/** Sign an act body. Exported because every caller of this API needs it and
 * there must be exactly one description of what gets signed. */
export function signAct(act, privHex) {
  return { ...act, sig: signMessage(signingBytes(act), privHex) };
}

// ═══════════════════════════════════════════════════════════════════════════
// wire helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * bigint becomes a decimal string on the wire.
 *
 * The convention core/replay.mjs already reads on the way in: a wei balance past
 * 2^53 written as a JSON number is a different number, so money is always in
 * quotes. Applied on the way out for the same reason and in one place, so no
 * endpoint can forget.
 */
function wire(value) {
  return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

function sendJson(res, status, body, headers = {}) {
  const text = wire(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...CORS,
    ...headers,
  });
  res.end(text);
}

/**
 * A refusal, on the wire, with all four fields and the catalogue's status.
 *
 * Never a bare sentence and never only a code. A caller branches on `code`,
 * shows `msg`, learns the mechanism from `why` and knows what to do next from
 * `next` — and the numbers that make it concrete are in `detail`, which is why
 * the catalogue itself can be a constant.
 */
function sendRefusal(res, code, detail, headers = {}) {
  sendJson(res, httpFor(code), refuse(code, detail), headers);
}

async function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('TOO_LARGE'), { size }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A token bucket per address, refilled continuously. Transport-level, in front
 * of the economic gate: fees make spam expensive but they are computed by
 * replay, which is work, and this stops an attacker making the host do that work
 * for free. */
function createLimiter({ perMinute, now }) {
  const buckets = new Map();
  return function take(key, cost = 1) {
    const at = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: perMinute, at };
      buckets.set(key, b);
    }
    b.tokens = Math.min(perMinute, b.tokens + ((at - b.at) / 60000) * perMinute);
    b.at = at;
    if (b.tokens < cost) return Math.ceil(((cost - b.tokens) / perMinute) * 60);
    b.tokens -= cost;
    return 0;
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  // The three vendored typefaces. Browsers sniff the wOF2 magic bytes and
  // honour the format() hint, so these load either way — but the preload links
  // in index.html declare type="font/woff2", and a preload whose declared type
  // disagrees with the served one can be dropped and then fetched again.
  '.woff2': 'font/woff2',
};

/**
 * Headers on every static response.
 *
 * The app makes a promise — no CDN, no remote font, no third-party anything, so
 * a reader's address is never handed to a party that is not part of this
 * network. Until now that promise held because the files happen to contain no
 * remote references, which is a property somebody has to keep re-verifying and
 * which one careless edit undoes silently.
 *
 * `default-src 'self'` makes the browser enforce it instead. A stylesheet that
 * grew a font-CDN import, an <img> pointed at a tracker, a script from
 * anywhere: all refused at the client, visibly, rather than shipped. The one
 * thing deliberately widened is `img-src`, which also allows `data:` and `blob:`
 * — the composer previews a picture the user just chose from a blob URL, and the
 * icons are data URIs.
 *
 * `connect-src` is the exception that has to stay open: the client is SUPPOSED
 * to talk to a host it learns from host.json, and that host is a different
 * origin (a tunnel, a mirror, whatever the address book names today). Pinning it
 * would be pinning the network to one machine, which is the opposite of the
 * design. So this policy stops the page fetching CODE and ASSETS from anywhere
 * but here, and does not pretend to constrain which host it asks for the record.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // the shell carries a few inline styles
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src *", // the writer is wherever the address book says it is
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// ═══════════════════════════════════════════════════════════════════════════
// the server
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One producer key, shared with the chain builder.
 *
 * The epoch block and the published EUR/BTC rate are signed by the same key on
 * purpose: ARCHITECTURE §3's promise is that "a host that showed a different
 * rate for a closed epoch contradicts its own signature", and two keys would
 * make that two unrelated claims that never meet. server/chain/keys.mjs owns the
 * key beside the log, so it is asked first; server/oracle.mjs keeps its own
 * implementation for the case where the chain part is not installed, and the
 * fallback is announced by the file it writes to rather than being silent.
 *
 * The wiring is defensive because these two parts are built separately: an
 * unexpected shape falls back rather than failing to start a writer.
 */
async function resolveProducerKey(dir) {
  try {
    const chainKeys = await import('./chain/keys.mjs');
    if (typeof chainKeys.loadOrCreateProducer === 'function' && typeof chainKeys.verifyBytes === 'function') {
      const signer = chainKeys.loadOrCreateProducer(dir);
      if (signer && typeof signer.sign === 'function' && typeof signer.publicHex === 'string') {
        return {
          path: signer.file,
          shared: true,
          publicKeyHex: signer.publicHex,
          sign: (value) => signer.sign(canonicalBytes(value)),
          verify: (value, sigHex) => {
            try {
              return chainKeys.verifyBytes(signer.publicHex, canonicalBytes(value), sigHex);
            } catch {
              return false;
            }
          },
        };
      }
    }
  } catch {
    /* the chain part is not installed on this host */
  }
  return { ...(await producerKey({ dir: join(dir, 'keys') })), shared: false };
}

/**
 * Build the writer. Nothing binds a port until `listen` is called.
 *
 * Every seam that touches the outside world is injectable, and that is not for
 * the tests' benefit: it is because bitcoin explorers, price feeds and the clock
 * are the three things this process cannot compute, and a design that hard-codes
 * them cannot be run anywhere they are unreachable. The tests use the same seams
 * a deployment does.
 */
export async function createServer(options = {}) {
  const {
    dir = join(ROOT, 'data'),
    appDir = join(ROOT, 'app'),
    now = Date.now,
    explorers = defaultExplorers(),
    oracleSources = null,
    isWriter = () => true,
    maxClockSkewMs = 5 * 60 * 1000,
    rateLimit = { act: 300, read: 1200, upload: 60 },
    minConfirmations = MIN_CONFIRMATIONS,
    params = PARAMS,
  } = options;

  const log = await openLog({ dir });
  const store = await openStore({ dir: join(dir, 'media') });
  const key = await resolveProducerKey(dir);
  const register = createChallengeRegister();

  // The world is a pure function of the log. It is rebuilt from nothing here and
  // then advanced act by act; it is never patched from the side, because a cache
  // maintained by hand beside the log is the second source of truth this design
  // exists to not have.
  let world = replay(log.acts.filter((a) => a !== null), params);

  // Signatures already seen. Acts are deduplicated by signature (DUPLICATE_ACT):
  // the same signed body replayed twice would bill twice for one impression.
  const seenSigs = new Set();
  for (const act of log.acts) if (act && typeof act.sig === 'string') seenSigs.add(act.sig);

  const takeAct = createLimiter({ perMinute: rateLimit.act, now });
  const takeRead = createLimiter({ perMinute: rateLimit.read, now });
  const takeUpload = createLimiter({ perMinute: rateLimit.upload, now });

  let oracleReading = null;
  let oracleSealed = null;
  const startedAt = now();

  // Writes are serialised through one chain. Node is single-threaded but every
  // await is a place another request can interleave, and two submissions
  // interleaving between `actError` and `append` would validate against a world
  // that no longer exists by the time the line is written.
  let writeTail = Promise.resolve();
  function serialiseWrite(fn) {
    const run = writeTail.then(fn, fn);
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── the one door ────────────────────────────────────────────────────────

  /**
   * Accept one signed act, or refuse it with a catalogued code.
   *
   * Returns `{ ok:true, i, act }` or `{ ok:false, code, detail }`. The caller
   * turns the second into the four-field body; this function never writes to a
   * socket, so the same path serves an HTTP request, a script and a test.
   */
  async function submit(act) {
    if (!isWriter()) return { ok: false, code: 'NOT_THE_WRITER' };
    if (act === null || typeof act !== 'object' || Array.isArray(act)) {
      return { ok: false, code: 'BAD_REQUEST', detail: { body: 'an act is a JSON object' } };
    }
    if (typeof act.sig !== 'string' || act.sig.length === 0) {
      return { ok: false, code: 'BAD_SIGNATURE', detail: { sig: null } };
    }

    // 1. The signature, before anything reads the act's own claims about who
    //    sent it. Recovery is CPU work and is deliberately outside the write
    //    queue: it touches no state, so it cannot race with anything.
    //
    //    The canonical encoder runs first and it is allowed to REFUSE — it
    //    encodes only what it can represent exactly. An act nested deeper than
    //    core/canonical.mjs's MAX_DEPTH is the reachable case, because acts
    //    arrive from anybody. Unwrapped, that throw left `submit`, left `handle`,
    //    and was answered as HTTP 500 carrying the code UNCATALOGUED — a code
    //    GET /api/v1/errors does not publish — for an act `actError` refuses with
    //    a published BAD_REQUEST. That is the rule 2 asymmetry in the wrong
    //    direction twice over: the host answered something the catalogue does not
    //    contain, and it blamed itself for what the caller sent. Catching it here
    //    gives the same act the same code the rulebook gives it.
    let message;
    try {
      message = signingBytes(act);
    } catch (err) {
      return {
        ok: false,
        code: 'BAD_REQUEST',
        detail: { act: String(err && err.message), maxDepth: MAX_DEPTH },
      };
    }
    const recovered = recoverAddress(message, act.sig);
    const claimed = typeof act.as === 'string' ? act.as.toLowerCase() : null;
    if (recovered === null || claimed === null || recovered !== claimed) {
      return { ok: false, code: 'BAD_SIGNATURE', detail: { as: claimed, recovered } };
    }

    // 2, 3 and 4 run with the write queue held, and `attemptWrite` is that pass.
    //
    // A `burnClaim` is the one act whose host check is a network round trip, and
    // it used to be awaited with the queue HELD. Two explorers that never
    // answered therefore stopped EVERY write on this host — not merely that
    // claim, and not merely that caller — for as long as they stalled. So the
    // queued pass stops when it reaches that check and says so, the explorers are
    // asked with the queue RELEASED, and the act re-enters carrying the answer.
    //
    // Two passes and no more, because the second carries a proof for exactly this
    // txid:vout and a pass holding a proof never asks for one. Nothing the proof
    // asserts can go stale while the queue is released: whether a bitcoin
    // transaction is confirmed, pays the keyless output and destroyed that many
    // satoshis is a fact about a chain this host does not write. The one thing
    // that CAN change in the gap is whether the output has since been claimed by
    // somebody else, and that is re-read inside the second pass, under the queue.
    // It is the reading under the queue that closes the double-claim race; the
    // reading `checkBurn` does before it ever touches the network is only an
    // optimisation that keeps an already-claimed txid off two public APIs.
    let burnProof = null;
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await serialiseWrite(() => attemptWrite(act, burnProof));
      if (!outcome.needsBurnProof) return outcome;
      burnProof = await verifyBurn(act);
    }
    // Unreachable: the second pass is handed a proof, and a pass holding a proof
    // never asks for another. Answered rather than looped, because a writer that
    // spins is worse than a writer that says it did not settle.
    return { ok: false, code: 'UNCATALOGUED', detail: { why: 'the burn verification pass did not settle' } };
  }

  /**
   * One pass at accepting an act, run with the write queue held.
   *
   * Returns the same `{ ok }` shape `submit` does, or `{ needsBurnProof: true }`
   * to say that it reached a check it may not make while holding the queue.
   */
  async function attemptWrite(act, burnProof) {
    // 2. The rulebook, with the index the act is about to receive already
    //    attached, so nothing applyAct checks is deferred until after the
    //    append. ARCHITECTURE rule 2 lives on this line.
    const candidate = { ...act, i: log.nextIndex };
    const problem = actError(world, candidate);
    if (problem) return { ok: false, code: problem.code, detail: problem.detail };

    // 3. The host's own checks. Every one of them is something replay cannot
    //    do, and every one can only refuse an act replay would have taken.
    //
    //    The signature index is one of them and it belongs here rather than at
    //    the door, which cost a real bug to learn: a resent view act is
    //    byte-identical to the first, and dropping it early answered
    //    DUPLICATE_ACT where the rulebook answers VIEW_SEQ_REPLAY. Two
    //    refusals for one act is exactly the drift rule 2 exists to stop, so
    //    the cheap check waits for the authoritative one. Where replay has
    //    nothing to say — a second identical comment is a lawful second
    //    comment — this is what stops one intent becoming two entries.
    if (seenSigs.has(act.sig)) return { ok: false, code: 'DUPLICATE_ACT', detail: { sig: act.sig } };

    const hostProblem = await hostChecks(candidate, burnProof);
    if (hostProblem) {
      if (hostProblem.needsBurnProof) return { needsBurnProof: true };
      return { ok: false, ...hostProblem };
    }

    // 4. Disk first, then the world, then the answer.
    const written = await log.append(act);
    seenSigs.add(act.sig);
    const applied = applyAct(world, written.act);
    if (!applied.ok) {
      // Unreachable: actError ran over this exact act against this exact
      // world. If it ever happens the line is already durable and replay will
      // skip it, so the honest answer is the refusal plus the fact that the
      // record now contains a line nobody can apply.
      return { ok: false, code: applied.code, detail: { ...applied.detail, wroteUnappliedLine: written.i } };
    }

    await afterApply(written.act);
    return { ok: true, i: written.i, act: written.act };
  }

  /**
   * Ask the two explorers about one claim, with the write queue RELEASED.
   *
   * Returns `{ ok: true }` or the refusal, rather than throwing, so the caller
   * can carry the answer back into the queue as data. server/burnwatch.mjs
   * bounds both how long this can take and how much can arrive; a bound is not
   * zero, which is why it runs out here.
   */
  async function verifyBurn(act) {
    try {
      await checkBurn(
        { txid: act.txid, vout: act.vout, sat: BigInt(act.sat) },
        { explorers, minConfirmations, claimed: (k) => Boolean(world.burns[k]) },
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err.code || 'BURN_EXPLORERS_DISAGREE', detail: err.detail || { error: String(err.message) } };
    }
  }

  /** What replay may not check: bytes, bitcoin, and a clock. */
  async function hostChecks(act, burnProof) {
    // The stamp is inside the signature, so the writer cannot rewrite it; what
    // it can do is refuse one far from its own clock. A far-future stamp would
    // expire posts early and skip cooldowns for everybody replaying afterwards,
    // and nobody could tell later that it had.
    const skew = Math.abs(act.t - now());
    if (skew > maxClockSkewMs) {
      return { code: 'TIMESTAMP_IMPLAUSIBLE', detail: { t: act.t, now: now(), skewMs: skew, maxSkewMs: maxClockSkewMs } };
    }

    if (act.k === 'post') {
      // A post names a picture. Accepting one whose bytes nobody has would
      // publish a lease over nothing and put a permanent entry in the log
      // pointing at an address that never resolved.
      const held = await store.describe(act.cid);
      if (!held) {
        return {
          code: 'CID_MISMATCH',
          detail: { cid: act.cid, stored: false, next: 'POST /api/v1/media with the bytes first; the response carries the cid to publish under' },
        };
      }
      if (held.bytes !== act.bytes) {
        return { code: 'CID_MISMATCH', detail: { cid: act.cid, declaredBytes: act.bytes, storedBytes: held.bytes } };
      }
      const object = await store.get(act.cid);
      if (!object || object.mime !== act.mime) {
        return { code: 'MIME_REFUSED', detail: { declared: act.mime, sniffed: object ? object.mime : null } };
      }
    }

    if (act.k === 'burnClaim') {
      // The uniqueness gate, read HERE, under the write queue. `actError` above
      // holds the same index and gives the same answer, and this second reading
      // is not redundant bookkeeping: the explorers were asked with the queue
      // released, so a claim for the same output could have landed in the gap,
      // and this is the line that runs after that gap has closed. The key is
      // built exactly the way core/replay.mjs builds it — the txid is lowercase
      // hex and the vout a safe integer by the time actError has passed — so the
      // two cannot disagree about what "already claimed" means.
      const key = `${act.txid}:${act.vout}`;
      if (world.burns[key]) {
        return { code: 'BURN_ALREADY_CLAIMED', detail: { txid: act.txid, vout: act.vout, heldBy: world.burns[key] } };
      }
      // No proof yet: hand the queue back so the round trip happens outside it.
      if (burnProof === null) return { needsBurnProof: true };
      if (!burnProof.ok) return { code: burnProof.code, detail: burnProof.detail };
    }

    if (act.k === 'capProof') {
      const wrong = await verifyProof(act, { world, store, register, now });
      if (wrong) return wrong;
    }

    return null;
  }

  /** Side effects that follow an applied act and touch things outside the log. */
  async function afterApply(act) {
    if (act.k === 'settle') {
      // Settlement's deletion, actually performed. The log keeps the structure
      // and the cid — the commitment residue that proves which bytes existed —
      // and the bytes leave this disk. server/log.mjs carries the long note on
      // why the line itself is not mutilated.
      const post = world.posts[act.pid];
      if (post && post.cid) await store.forget(post.cid);
    }
    if (act.k === 'closeEpoch') {
      register.sweep(world.epoch.n);
      // The rate the new epoch prices at is already sealed into the world by
      // replay. Refreshing the published reading is best-effort: a failed read
      // leaves the previous one standing, which is what ORACLE_STALE describes.
      refreshOracle().catch(() => {});
    }
  }

  // ── the oracle ──────────────────────────────────────────────────────────

  /**
   * Read the sources and sign the result.
   *
   * A failed read leaves the previous reading standing rather than replacing it
   * with nothing: the epoch prices at the pair it sealed either way, so a
   * publishing failure is not a pricing failure, and a host that blanked its own
   * published rate on a timeout would look like a host that had stopped
   * observing the market.
   */
  let oracleInFlight = null;

  function refreshOracle() {
    // ONE READ AT A TIME. GET /api/v1/oracle refreshes when the published
    // reading is stale, and it is a public read — so a burst of requests that
    // all find it stale would each start their own round of five outbound calls,
    // turning a cheap endpoint on this host into an amplifier pointed at five
    // other people's APIs. Sharing the in-flight promise makes a burst cost one
    // round of reads, and every caller still gets the reading it waited for.
    //
    // server/oracle.mjs bounds each source with an abort signal and a byte cap,
    // so a stalled feed cannot hold this promise open indefinitely and cannot
    // answer with a body that never ends. Nothing here is on the write path:
    // `afterApply` starts a refresh and does not await it, because the rate the
    // next epoch prices at was already sealed into the world by replay and the
    // published reading is a separate, best-effort claim about the market.
    if (oracleInFlight) return oracleInFlight;
    const sources = oracleSources || (typeof globalThis.fetch === 'function' ? publicSources() : []);
    if (sources.length === 0) return Promise.resolve(null);
    oracleInFlight = (async () => {
      const reading = await readOracle({
        sources,
        prevEurPerBtcNano: world.epoch.oracle.eurPerBtcNano,
        epoch: world.epoch.n,
        now,
      });
      oracleReading = reading;
      oracleSealed = sealOracle(reading, key);
      return reading;
    })().finally(() => {
      oracleInFlight = null;
    });
    return oracleInFlight;
  }

  /** How long a published reading stands before the sources are asked again.
   * Prices do not move under a user mid-epoch, so this only governs how fresh
   * the PUBLISHED number is; making it shorter would ask five public APIs a
   * question whose answer nothing in the economy reads until the next close. */
  const ORACLE_MAX_AGE_MS = 60000;

  // ── read models ─────────────────────────────────────────────────────────

  const rate = () => world.epoch.oracle;

  /** A price in both units, with the dust flag the card's data-dust needs. */
  function pricePair(nanoEur) {
    const p = priceOf(nanoEur, rate());
    return { nanoEur: p.nanoEur, wei: p.wei, dust: p.dust, eur: formatEur(p.nanoEur), subSat: nanoEurToSubSat(p.nanoEur, rate().eurPerBtcNano) };
  }

  function postView(pid) {
    const post = world.posts[pid];
    if (!post) return null;
    const author = world.accounts[post.author];
    return {
      pid,
      author: post.author,
      handle: author ? author.handle : null,
      cid: post.cid,
      bytes: post.bytes,
      mime: post.mime,
      w: post.w,
      h: post.h,
      media: post.redacted ? null : `/media/${post.cid}?exp=${post.expires}`,
      redacted: post.redacted,
      state: post.state,
      created: post.created,
      expires: post.expires,
      settlesAt: post.expires + Number(params.settlementGraceSec) * 1000,
      price: { view: pricePair(post.viewPriceNano), like: pricePair(actionPriceNanoEur(post.viewPriceNano, 'like', params)), comment: pricePair(actionPriceNanoEur(post.viewPriceNano, 'comment', params)) },
      views: post.views,
      uniqueViewers: post.uniqueViewers,
      likes: post.likes,
      comments: post.comments,
      grossNano: post.grossNano,
      grossEur: formatEur(post.grossNano),
      creditWei: post.creditWei,
      creditEur: formatEur(ptpWeiToNanoEur(post.creditWei, rate())),
      paidWei: post.paidWei,
      capUnits: post.capUnits,
      claimedUnits: post.claimedUnits,
      escrow: post.escrow,
      shards: Math.ceil(post.bytes / SHARD_BYTES),
      tombstone: post.tombstone,
    };
  }

  function accountView(address) {
    const addr = typeof address === 'string' ? address.toLowerCase() : '';
    const account = world.accounts[addr];
    if (!account) return null;
    const posts = Object.keys(world.posts).filter((pid) => world.posts[pid].author === addr);
    return {
      address: addr,
      handle: account.handle,
      joined: account.joined,
      acts: account.acts,
      ptp: account.ptp,
      ptpEur: formatEur(ptpWeiToNanoEur(account.ptp, rate())),
      sat: account.sat,
      cap: account.cap,
      shares: account.shares,
      viewSeq: account.viewSeq,
      nextViewSeq: account.viewSeq + 1,
      posts,
      provider: world.capacity.providers[addr] || null,
    };
  }

  function feedView({ limit = 30, before = null, all = false }) {
    const pids = Object.keys(world.posts);
    const rows = [];
    for (let i = pids.length - 1; i >= 0; i--) {
      const pid = pids[i];
      const post = world.posts[pid];
      if (!all && post.state !== 'live') continue;
      if (before !== null && post.created >= before) continue;
      rows.push(postView(pid));
      if (rows.length >= limit) break;
    }
    return rows;
  }

  function poolView() {
    return {
      sat: world.pool.sat,
      ptp: world.pool.ptp,
      shares: world.pool.shares,
      locked: world.pool.locked,
      minimumLiquidity: MINIMUM_LIQUIDITY,
      spotSatPerPtpE18: spotSatPerPtp(world.pool),
      feeBps: params.swapFeeBps,
      eurPerBtcNano: rate().eurPerBtcNano,
      note: 'Fees do not price against these live reserves. They price against the pair sealed at the last epoch close (core/params.mjs FEE_PRICE_SOURCE), which is what stops an actor from converting at a dip they created.',
      sealed: rate(),
    };
  }

  function statusView() {
    return {
      ok: true,
      writer: isWriter(),
      net: 'ptp',
      at: now(),
      uptimeMs: now() - startedAt,
      epoch: { n: world.epoch.n, startedAt: world.epoch.startedAt, closedAt: world.epoch.closedAt, burnedWei: world.epoch.burnedWei, acts: world.epoch.acts.length, opensAt: world.epoch.startedAt + Number(params.epochSeconds) * 1000 },
      log: { path: log.path, count: log.count, bytes: log.bytes, applied: world.log.count, skipped: world.log.skipped, truncatedBytes: log.truncatedBytes, unreadable: log.unreadable.length, lastIndex: world.log.lastIndex, lastAt: world.log.lastAt },
      supply: world.supply,
      pool: { sat: world.pool.sat, ptp: world.pool.ptp },
      treasury: world.treasury,
      capacity: { potPtp: world.capacity.potPtp, bondsPtp: world.capacity.bondsPtp, providers: Object.keys(world.capacity.providers).length },
      accounts: Object.keys(world.accounts).length,
      posts: Object.keys(world.posts).length,
      comments: Object.keys(world.comments).length,
      rules: world.rules,
      oracle: oracleSealed ? { eurPerBtcNano: oracleSealed.eurPerBtcNano, at: oracleSealed.at, clamped: oracleSealed.clamped } : { eurPerBtcNano: rate().eurPerBtcNano.toString(), at: null, clamped: false, note: 'no live read yet; the world is pricing at the rate the last epoch sealed' },
      editions: { replay: REPLAY_EDITION, rules: world.rules.version, signatureVerifier: SIGNATURE_VERIFIER },
    };
  }

  // ── the self-describing document ────────────────────────────────────────

  function apiDoc() {
    return {
      name: 'Peer two Peer — the writer API',
      version: 'v1',
      net: 'ptp',
      what: 'A picture network where every impression is priced in euros, every action destroys PTP, and pictures live on members\' own devices and are deleted when their lease ends. Every number here — balances, feeds, earnings, pool reserves — is a pure function of one append-only act log, computed by core/replay.mjs. This host does not decide what is true; it decides what gets written down and in what order.',
      howItWorks: {
        acts: 'Everything anyone does is a signed act appended to data/acts.jsonl, one canonical-JSON line each. There are no private records.',
        theOneRulebook: 'core/replay.mjs is imported unchanged by this server, by the browser and by the chain builder. This host may not accept an act replay would skip, and it checks that with the same function the browser uses to decide whether to offer you a button.',
        money: 'Prices are euros held as integer nanoeuros (1 EUR = 1e9). Settlement is PTP wei. The conversion is ONE fused rational — nanoEur x 1e8 x poolPtpWei / (eurPerBtcNano x poolSat) — never two hops, because an intermediate integer satoshi truncates every price in this economy to zero. Every amount on this API is a decimal STRING in the asset\'s smallest unit: a JSON number past 2^53 is a different number.',
        theRate: 'Both legs of that conversion are frozen at the epoch close and used unchanged for the whole epoch. A live pool spot would let an actor price their own actions against a dip they created.',
        burn: 'Reserve comes from bitcoin destroyed at a keyless P2WSH output and from nowhere else, verified against two independent explorers that must agree. GET /api/v1/burn has the output and the rules.',
        deletion: 'A post is a lease. When it lapses anybody may settle it: the creator is paid, the picture is deleted from this host and from every device holding a shard, and a tombstone keeps the structure — author, cid, byte length, dimensions, totals — without the bytes.',
      },
      auth: {
        how: 'Every act is signed EIP-191 personal_sign by the wallet key that owns `as`. There are no passwords, no PINs and no server-held secrets.',
        whatIsSigned: 'The canonical JSON of the act body with `sig` and `i` removed, as UTF-8 BYTES. `i` is assigned by this host on acceptance, so you cannot sign it; `sig` cannot cover itself.',
        canonicalJson: 'Object keys sorted by UTF-16 code unit, shortest round-trip numbers, no whitespace. core/canonical.mjs is the reference implementation.',
        recipe: [
          '1. body = { t: <ms since epoch, your clock>, as: "0x…", k: "<kind>", …fields }',
          '2. message = canonicalJson(body) encoded UTF-8',
          '3. sig = personal_sign(message)   // ethers: wallet.signMessage(bytes)',
          '4. POST /api/v1/act with { ...body, sig }',
        ],
        verifier: SIGNATURE_VERIFIER,
        clockSkewMs: maxClockSkewMs,
        note: 'Your stamp is inside the signature so this host cannot rewrite it, but it is refused if it is further than clockSkewMs from this host\'s clock. Timestamps drive cooldowns, expiry and epoch boundaries.',
      },
      quickstart: [
        '1. GET /api/v1/status — see the epoch, the log length and the sealed rate.',
        '2. POST /api/v1/act k="register" {handle} — bind a handle to your address.',
        '3. GET /api/v1/burn — destroy bitcoin at the keyless output, wait for confirmations.',
        '4. POST /api/v1/act k="burnClaim" {txid, vout, sat} — reserve in satoshis.',
        '5. POST /api/v1/act k="swap" {sell:"btc", amt, minOut} — satoshis into PTP. Quote first at GET /api/v1/pool/quote.',
        '6. POST /api/v1/act k="capBuy" {ptp} — PTP into CAP, the storage receipt a post consumes.',
        '7. POST /api/v1/media with the picture bytes — the response carries the cid.',
        '8. POST /api/v1/act k="post" {cid, bytes, mime, w, h, viewPriceNano, days}.',
        '9. GET /api/v1/feed — and pay to look, with k="view".',
      ],
      endpoints: [
        { method: 'GET', path: '/api/v1', purpose: 'this document. A bot should need nothing else.' },
        { method: 'GET', path: '/api/v1/errors', purpose: 'every refusal this host can return: a stable code, the mechanism that produced it, and what to do about it. Branch on `code`, never on the wording.' },
        { method: 'GET', path: '/api/v1/params', purpose: 'the constants edition this host prices with — every number in docs/ECONOMICS.md, plus the burn output and the limits.' },
        { method: 'GET', path: '/api/v1/acts', purpose: 'the act log itself, JSON Lines, verbatim. Rule 1 says every number here is a pure function of this file, and this is where you get it: replay it yourself and you owe nobody any trust. Also answers at /api/v1/acts.jsonl and /api/v1/log.' },
        { method: 'GET', path: '/api/v1/status', purpose: 'epoch, log length, supply, pool, treasury, capacity pot, editions. The cheap poll.' },
        { method: 'GET', path: '/api/v1/feed?limit=N&before=MS&all=1', purpose: 'live posts newest first, each with its euro prices in both units and its dust flag. all=1 includes settled ones.' },
        { method: 'GET', path: '/api/v1/post/:pid', purpose: 'one post with its full economics, its lease, its shard count and its tombstone if it settled.' },
        { method: 'GET', path: '/api/v1/post/:pid/comments', purpose: 'the comments on one post, in the order they landed.' },
        { method: 'GET', path: '/api/v1/wallet/:address', purpose: 'balances in PTP wei, satoshis, CAP units and pool shares, the next view sequence number, and the posts this address authored.' },
        { method: 'GET', path: '/api/v1/pool', purpose: 'the one pool: reserves, shares, spot, fee, and the pair the epoch sealed — which is what fees actually price against.' },
        { method: 'GET', path: '/api/v1/pool/quote?sell=btc|ptp&amt=N&slippageBps=N', purpose: 'what a swap would fill at, with the price impact and a suggested minOut. `sell` names the asset you are GIVING UP.' },
        { method: 'POST', path: '/api/v1/pool/swap', purpose: 'a convenience alias for POST /api/v1/act with k="swap". Identical validation — there is one door.', body: { sell: '"btc" | "ptp"', amt: 'decimal string, smallest unit of the asset sold', minOut: 'decimal string; a fill worse than this is refused, not executed' } },
        { method: 'GET', path: '/api/v1/capacity', purpose: 'the storage ledger: every provider\'s pledge, proven MB-days, bond and pay, the per-post escrows, and whether anything is currently placed on them.' },
        { method: 'GET', path: '/api/v1/capacity/challenges?as=0x…&limit=N', purpose: 'the proof-of-storage challenges put to one node: post, shard, byte window, and the act to answer with. Answers are bounded at ' + Number(params.capProofLatencyBoundMs) + ' ms — that bound is what distinguishes three disks from one disk pretending to be three.' },
        { method: 'GET', path: '/api/v1/oracle', purpose: '{ eurPerBtcNano, at, sources[], sig } — the median of at least five independent sources with a quorum of three, clamped to +/-10% per epoch, every source\'s own value sealed and signed by the epoch producer key.' },
        { method: 'GET', path: '/api/v1/rules', purpose: 'the active distribution module: version, sha256 and full source. Emission is a per-creator rebate on burn actually caused, not a pot divided by weight.' },
        { method: 'GET', path: '/api/v1/rules/:version', purpose: 'any module this build carries, so every past epoch stays recomputable with the module that actually computed it.' },
        { method: 'GET', path: '/api/v1/burn', purpose: 'the keyless output, how it is derived, how many confirmations count, and which explorers must agree.' },
        { method: 'GET', path: '/api/chain', purpose: 'the epoch chain, if server/chain has built any. One signed hash-linked block per closed epoch.' },
        { method: 'GET', path: '/api/chain/head', purpose: 'the last sealed block.' },
        { method: 'POST', path: '/api/v1/act', purpose: 'THE ONE DOOR. One signed act. On refusal you get code, msg, why and next, with the catalogue\'s HTTP status.', body: { t: 'ms since epoch', as: '0x + 40 hex, the signing address', k: 'act kind', '…': 'the kind\'s own fields', sig: '0x + 130 hex, personal_sign over the canonical body minus sig and i' } },
        { method: 'POST', path: '/api/v1/media?cid=…', purpose: 'raw picture bytes in the body. The type is read from the leading bytes, not from the header or a filename; EXIF is stripped BEFORE the cid is computed, so the cid addresses the bytes this host serves. Answers { cid, bytes, mime, w, h } — publish under that cid.', body: 'the bytes themselves' },
        { method: 'GET', path: '/media/:cid', purpose: 'the picture. Immutable for a year, because the URL names a sha256 and the bytes at that address cannot change. Gone the moment its post settles.' },
      ],
      acts: [
        { k: 'register', fields: { handle: '3–24 chars, [a-z0-9_] starting alphanumeric' }, costs: 'nothing', what: 'binds a handle to your address, once and permanently. Every other kind needs it first.' },
        { k: 'burnClaim', fields: { txid: '64 hex', vout: 'integer', sat: 'decimal string' }, costs: 'nothing', what: 'records bitcoin destroyed at the keyless output and credits that many satoshis of reserve. Verified against two independent explorers before it is written.' },
        { k: 'swap', fields: { sell: '"btc" | "ptp"', amt: 'decimal string', minOut: 'decimal string' }, costs: 'the swap fee, ' + params.swapFeeBps + ' bps, which stays in the pool', what: 'trades in the one constant-product pool.' },
        { k: 'liqAdd', fields: { sat: 'decimal string', ptp: 'decimal string' }, costs: 'the proportional part of your offer', what: 'provides liquidity; only the matching part of a skewed deposit is taken.' },
        { k: 'liqRemove', fields: { shares: 'decimal string' }, costs: 'nothing', what: 'withdraws liquidity. The locked minimum belongs to nobody and can never be removed.' },
        { k: 'post', fields: { cid: '64 hex from POST /api/v1/media', bytes: 'integer', mime: MIME_SERVED.join(' | '), w: 'integer', h: 'integer', viewPriceNano: 'decimal string between ' + params.viewPriceMinNanoEur + ' and ' + params.viewPriceMaxNanoEur, days: 'integer 1–365' }, costs: 'publishBaseFeeNanoEur plus the days\' storage rent, both in PTP at the sealed rate, and the CAP the MB-days consume', what: 'publishes a picture with a lease. The publish fee has no creator leg: a poster may not pay themselves.' },
        { k: 'view', fields: { pid: 'post id', dwellMs: 'integer >= ' + params.viewDwellMs, seq: 'integer, must advance', vp: 'optional viewport percent >= ' + params.viewMinViewportPct }, costs: 'the poster\'s view price', what: 'one billable impression. Capped at ' + params.maxViewsPerPairPerEpoch + ' per (viewer, post) per epoch with ' + params.viewCooldownSec + 's between them.' },
        { k: 'like', fields: { pid: 'post id' }, costs: params.likeMultiplierBps / 10000n + 'x the view price', what: 'one like per person per post, ever.' },
        { k: 'comment', fields: { pid: 'post id', text: '1–' + MAX_COMMENT_CHARS + ' characters' }, costs: params.commentMultiplierBps / 10000n + 'x the view price', what: 'a comment. It lives in the log forever and is never deleted by settlement, which is why the length is capped on what everyone else must carry.' },
        { k: 'extend', fields: { pid: 'post id', days: 'integer 1–365' }, costs: 'the days\' rent, plus CAP', what: 'buys further lease days. Author only. Days are added to the lease that was bought, not to the moment of the act.' },
        { k: 'settle', fields: { pid: 'post id' }, costs: 'nothing', what: 'closes a lapsed post: pays the creator, deletes the picture, writes the tombstone. Permissionless after the grace window — a network where deletion depends on the author showing up is a network that never deletes.' },
        { k: 'capBuy', fields: { ptp: 'decimal string' }, costs: 'the PTP named', what: 'converts PTP into CAP at the rent tariff and funds the capacity pot.' },
        { k: 'capPledge', fields: { mb: 'integer megabytes', endpoint: 'string' }, costs: 'a slashable bond on the INCREASE only, ' + params.capPledgeBondNanoEurPerGb + ' n€ per GB', what: 'announces storage you are serving. An announcement earns nothing on its own.' },
        { k: 'capProof', fields: { challenge: '{ pid, shard }', answer: '64 hex' }, costs: 'nothing', what: 'answers a byte-range challenge. Get one from GET /api/v1/capacity/challenges; this host will not accept a proof for a challenge it never issued, because there would be no instant to measure the answer against.' },
        { k: 'capClaim', fields: {}, costs: 'nothing', what: 'mints CAP for proven MB-days and draws your share of each post\'s escrow.' },
        { k: 'rulesSet', fields: { version: 'string', hash: '64 hex', fromEpoch: 'integer strictly above the current epoch' }, costs: 'nothing', what: 'the rule key only. It can change how emission is divided and nothing else — it cannot mint, move a balance, touch the pool or alter a sealed block.' },
        { k: 'closeEpoch', fields: { oracle: 'optional { eurPerBtcNano, sources[] }' }, costs: 'nothing', what: 'seals the epoch: mints the per-creator rebates, seals the next rate, resets the per-pair view counters. Any registered account may send it once the epoch\'s length has elapsed.' },
      ],
      limits: {
        actBytes: MAX_ACT_BYTES,
        payloadBytes: MAX_PAYLOAD_BYTES,
        commentChars: MAX_COMMENT_CHARS,
        shardBytes: SHARD_BYTES,
        actsPerMinute: rateLimit.act,
        readsPerMinute: rateLimit.read,
        uploadsPerMinute: rateLimit.upload,
        mediaTypes: MIME_SERVED,
        mediaTypesNote: 'core/replay.mjs also permits image/avif; this host does not carry it, because it does not parse ISO-BMFF metadata boxes and will not store bytes whose metadata it cannot strip.',
      },
      refusals: {
        shape: '{ ok:false, code, msg, why, next, detail }',
        promise: 'All four fields, always, with the catalogue\'s HTTP status. A bot never has to parse a sentence to learn what happened.',
        catalogue: '/api/v1/errors',
      },
      editions: {
        replay: REPLAY_EDITION,
        rules: world.rules.version,
        params: sha256Hex(canonicalJson(params)),
        note: 'The epoch block seals these, so a verifier can say which rulebook computed a state rather than that some rulebook did.',
      },
      etiquette: 'Bots are welcome as participants. Every act costs money and the meter is public; a loop that views its own pictures loses 31.8% of every euro it spends, by arithmetic rather than by moderation.',
    };
  }

  // ── routing ─────────────────────────────────────────────────────────────

  const appRoot = resolve(appDir);

  // The browser has to be able to FETCH the rulebook, not merely to be told that
  // it shares it.
  //
  // Rule 2 says server, browser and chain builder run the same core/ files, and
  // app/app.mjs imports them with `../core/replay.mjs`. Served from app/ at the
  // root, that specifier resolves to /core/replay.mjs — which was outside the
  // static root and answered 404, so the client failed at its first import and
  // the app did not run at all. Nothing caught it: test/client.test.mjs imports
  // core/ from disk, and every end-to-end check drove the API rather than the
  // page. A rule enforced only where it is convenient to test is not enforced.
  //
  // core/ is therefore its own static root: dependency-free, isomorphic, and
  // already public in the sense that matters — its digest is sealed into every
  // epoch block precisely so anyone can check the copy they were served.
  const coreRoot = resolve(join(ROOT, 'core'));

  /** Resolve a request path under a root, refusing traversal on the RESOLVED
   *  path rather than on the string, so "%2e%2e", backslashes and unicode tricks
   *  all normalise away before the check. Returns null when it escapes. */
  function within(root, rel) {
    const target = resolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) return null;
    return target;
  }

  async function serveStatic(req, res, pathname) {
    // Traversal is refused on the resolved path rather than on the string: "%2e%2e",
    // backslashes and unicode tricks all normalise away before the check, and the
    // only thing that matters afterwards is whether the file is inside the app
    // directory.
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendRefusal(res, 'BAD_REQUEST', { path: pathname });
    }
    if (decoded.includes('\0')) return sendRefusal(res, 'BAD_REQUEST', { path: pathname });
    const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');

    // /core/… is the shared rulebook, and only ever .mjs: this root exists so the
    // browser can import the same modules the host runs, not so the process
    // directory becomes browsable.
    let target;
    if (rel === 'core' || rel.startsWith('core/')) {
      if (!rel.endsWith('.mjs')) return sendRefusal(res, 'NOT_FOUND', { path: decoded });
      target = within(coreRoot, rel.slice('core'.length).replace(/^\/+/, ''));
    } else {
      target = within(appRoot, rel);
    }
    if (target === null) return sendRefusal(res, 'NOT_FOUND', { path: decoded });
    let info;
    try {
      info = await stat(target);
    } catch {
      return sendRefusal(res, 'NOT_FOUND', { path: decoded });
    }
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      return sendRefusal(res, 'NOT_FOUND', { path: decoded });
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': bytes.length,
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
      ...CORS,
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  /**
   * The chain, passed through VERBATIM.
   *
   * server/chain/build.mjs writes `data/chain.json` — the whole chain as a
   * canonical JSON array — and a per-block projection under `data/chain/`. This
   * host serves those bytes exactly as the builder wrote them and re-encodes
   * nothing, because a verifier checking a stateRoot or a signature needs the
   * bytes the producer signed and not a faithful-looking re-serialisation of the
   * values inside them. That is also why this returns text rather than an
   * object: parsing it here would be a step at which this host could differ from
   * the record without anybody being able to say where.
   *
   * This host builds no blocks. It serves what the builder left beside the log,
   * and answers honestly when there is nothing there.
   */
  async function chainRaw(which) {
    const chainDir = join(dir, 'chain');
    if (which === 'head') {
      try {
        return await readFile(join(chainDir, 'head.json'), 'utf8');
      } catch {
        /* fall through to the whole chain's last block */
      }
      try {
        const names = (await readdir(chainDir)).filter((n) => /^\d+\.json$/.test(n)).sort();
        if (names.length > 0) return await readFile(join(chainDir, names[names.length - 1]), 'utf8');
      } catch {
        /* no projection either */
      }
      return null;
    }
    try {
      return await readFile(join(dir, 'chain.json'), 'utf8');
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = req.socket.remoteAddress || 'unknown';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const write = req.method === 'POST';
    const wait = write ? 0 : takeRead(ip);
    if (wait > 0) return sendRefusal(res, 'RATE_LIMIT', { retryAfterSec: wait }, { 'retry-after': String(wait) });

    // ── writes ──
    if (path === '/api/v1/act' && write) {
      const cost = takeAct(ip);
      if (cost > 0) return sendRefusal(res, 'RATE_LIMIT', { retryAfterSec: cost }, { 'retry-after': String(cost) });
      let body;
      try {
        body = await readBody(req, MAX_ACT_BYTES * 2);
      } catch {
        return sendRefusal(res, 'ACT_TOO_LARGE', { max: MAX_ACT_BYTES });
      }
      let act;
      try {
        act = JSON.parse(body.toString('utf8'));
      } catch (err) {
        return sendRefusal(res, 'BAD_REQUEST', { json: String(err.message) });
      }
      const result = await submit(act);
      if (!result.ok) return sendRefusal(res, result.code, result.detail);
      return sendJson(res, 200, {
        ok: true,
        i: result.i,
        act: result.act,
        account: accountView(result.act.as),
        post: result.act.k === 'post' ? postView(`p${world.seq.post}`) : undefined,
        epoch: world.epoch.n,
      });
    }

    if (path === '/api/v1/pool/swap' && write) {
      const cost = takeAct(ip);
      if (cost > 0) return sendRefusal(res, 'RATE_LIMIT', { retryAfterSec: cost }, { 'retry-after': String(cost) });
      let act;
      try {
        act = JSON.parse((await readBody(req, MAX_ACT_BYTES * 2)).toString('utf8'));
      } catch (err) {
        return sendRefusal(res, 'BAD_REQUEST', { json: String(err.message) });
      }
      // The alias forces the kind and changes nothing else, so it cannot become
      // a looser door than the one every other act goes through.
      const result = await submit({ ...act, k: 'swap' });
      if (!result.ok) return sendRefusal(res, result.code, result.detail);
      return sendJson(res, 200, { ok: true, i: result.i, act: result.act, account: accountView(result.act.as), pool: poolView() });
    }

    if (path === '/api/v1/media' && write) {
      const cost = takeUpload(ip);
      if (cost > 0) return sendRefusal(res, 'RATE_LIMIT', { retryAfterSec: cost }, { 'retry-after': String(cost) });
      let bytes;
      try {
        bytes = await readBody(req, MAX_PAYLOAD_BYTES + 1024);
      } catch {
        return sendRefusal(res, 'PAYLOAD_TOO_LARGE', { max: MAX_PAYLOAD_BYTES });
      }
      try {
        const stored = await store.put(bytes, url.searchParams.get('cid') || undefined);
        return sendJson(res, 200, {
          ok: true,
          ...stored,
          url: `/media/${stored.cid}`,
          next: 'POST /api/v1/act with k="post" naming this cid, these bytes, this mime and these dimensions.',
        });
      } catch (err) {
        return sendRefusal(res, err.code || 'BAD_REQUEST', err.detail || { error: String(err.message) });
      }
    }

    if (write) return sendRefusal(res, 'NOT_FOUND', { method: 'POST', path, next: 'GET /api/v1 lists every route this host answers.' });

    // ── reads ──
    if (path === '/api/v1') return sendJson(res, 200, apiDoc());
    if (path === '/api/v1/errors') {
      return sendJson(res, 200, {
        ok: true,
        count: errorList().length,
        note: 'Frozen and cacheable. `detail` carries the numbers; these four fields are constants.',
        errors: errorList(),
      }, { 'cache-control': 'public, max-age=3600' });
    }
    if (path === '/api/v1/params') {
      return sendJson(res, 200, {
        ok: true,
        params,
        edition: sha256Hex(canonicalJson(params)),
        burn: burnFacts({ minConfirmations, explorers }),
        limits: { actBytes: MAX_ACT_BYTES, payloadBytes: MAX_PAYLOAD_BYTES, commentChars: MAX_COMMENT_CHARS, shardBytes: SHARD_BYTES },
        mediaTypes: MIME_SERVED,
        genesisRate: world.epoch.oracle,
      });
    }
    // ── the act log, raw ──────────────────────────────────────────────────
    //
    // THE ENDPOINT RULE 1 IS USELESS WITHOUT, and it was missing.
    //
    // "The act log is the only truth. Every balance, feed, earning and reserve
    // is a pure function of it." A client that cannot GET the log cannot compute
    // any of that and has to believe whatever /api/v1/feed tells it — which is
    // precisely the trust the whole design exists to remove. app/app.mjs asks
    // for this on every refresh and got a 404, so the published app fell through
    // to its archive fallback and announced "No host answered" while the host
    // was answering everything else.
    //
    // Nothing caught it: test/server.test.mjs drives the API and never replays,
    // test/client.test.mjs replays and never crosses a socket, and the two names
    // were only ever compared by a person reading both files.
    //
    // Three spellings because three readers already ask for three: the client
    // wants /api/v1/acts, .github/workflows/archive.yml tries
    // /api/v1/acts.jsonl and /api/v1/log. One handler answers all of them rather
    // than one of them being right and two being 404 — a canonical name nobody
    // uses is not a contract.
    //
    // Served as JSON Lines, verbatim, one canonical act per line, exactly as the
    // writer appended them. Not re-encoded: a verifier checking a root needs the
    // bytes that were hashed, not a faithful-looking re-serialisation of them.
    if (path === '/api/v1/acts' || path === '/api/v1/acts.jsonl' || path === '/api/v1/log') {
      const body = await log.raw();
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        // The log only ever grows, so a reader may cache what it has and ask for
        // the rest; but it grows on every act, so it is never cached BLIND.
        'cache-control': 'no-cache',
        'x-ptp-acts': String(log.acts.length),
        ...CORS,
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (path === '/api/v1/status') return sendJson(res, 200, statusView());
    if (path === '/api/v1/burn') return sendJson(res, 200, { ok: true, ...burnFacts({ minConfirmations, explorers }) });

    if (path === '/api/v1/feed') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null;
      const all = url.searchParams.get('all') === '1';
      return sendJson(res, 200, { ok: true, at: now(), epoch: world.epoch.n, count: Object.keys(world.posts).length, posts: feedView({ limit, before, all }) });
    }

    if (path.startsWith('/api/v1/post/')) {
      const rest = path.slice('/api/v1/post/'.length);
      const [pid, tail] = rest.split('/');
      const view = postView(pid);
      if (!view) return sendRefusal(res, 'POST_NOT_FOUND', { pid });
      if (tail === 'comments') {
        return sendJson(res, 200, { ok: true, pid, comments: commentsOf(pid) });
      }
      if (tail) return sendRefusal(res, 'NOT_FOUND', { path });
      return sendJson(res, 200, { ok: true, post: view, comments: commentsOf(pid) });
    }

    if (path === '/api/v1/comments') {
      const pid = url.searchParams.get('pid');
      if (!pid) return sendRefusal(res, 'BAD_REQUEST', { query: 'pid is required' });
      if (!world.posts[pid]) return sendRefusal(res, 'POST_NOT_FOUND', { pid });
      return sendJson(res, 200, { ok: true, pid, comments: commentsOf(pid) });
    }

    if (path.startsWith('/api/v1/wallet/') || path.startsWith('/api/v1/account/')) {
      const addr = path.slice(path.lastIndexOf('/') + 1);
      const view = accountView(addr);
      if (!view) return sendRefusal(res, 'UNKNOWN_ACCOUNT', { as: addr.toLowerCase() });
      return sendJson(res, 200, { ok: true, account: view, rate: rate() });
    }

    if (path === '/api/v1/pool') return sendJson(res, 200, { ok: true, pool: poolView() });

    if (path === '/api/v1/pool/quote') {
      const sell = url.searchParams.get('sell');
      const amtText = url.searchParams.get('amt');
      // The tolerance is read the way every amount on this API is read: as a
      // decimal integer, never through a Number. Reading it as a double had
      // three separate consequences and all three were wrong. `slippageBps=12.5`
      // reached `BigInt(12.5)`, which throws, so a malformed query was answered
      // with a 500 and the code UNCATALOGUED — a sentence that says this host's
      // refusal path is ahead of its own catalogue, when in fact the caller had
      // simply typed a fraction. `slippageBps=abc` and `slippageBps=0` both
      // became 50 silently, so a bot that asked for no tolerance at all was
      // quietly given half a percent of one. And anything above 10000 produced a
      // NEGATIVE minOut, which this host then published inside a ready-made
      // `act` body that its own door would refuse with BAD_AMOUNT.
      //
      // A suggestion that cannot be taken is worse than a refusal, because the
      // caller finds out at the write and not at the read.
      const slipText = url.searchParams.get('slippageBps');
      const slipGiven = slipText !== null && slipText !== '';
      if (slipGiven && !/^(0|[1-9][0-9]*)$/.test(slipText)) {
        return sendRefusal(res, 'BAD_REQUEST', {
          slippageBps: slipText,
          expected: 'a decimal integer of basis points, 0 to 10000',
        });
      }
      const slippageBps = slipGiven ? BigInt(slipText) : 50n;
      if (slippageBps > 10000n) {
        return sendRefusal(res, 'BAD_REQUEST', {
          slippageBps: slipText,
          max: 10000,
          why: 'a tolerance above 100% asks for a negative minOut, which is not an amount',
        });
      }
      if (sell !== 'btc' && sell !== 'ptp') return sendRefusal(res, 'BAD_REQUEST', { sell, expected: ['btc', 'ptp'] });
      if (!/^(0|[1-9][0-9]*)$/.test(String(amtText))) return sendRefusal(res, 'BAD_AMOUNT', { amt: amtText });
      const amt = BigInt(amtText);
      if (amt === 0n) return sendRefusal(res, 'BAD_AMOUNT', { amt: amtText });
      try {
        const q = poolQuote(world.pool, sell, amt, params.swapFeeBps);
        const minOut = (q.out * (10000n - slippageBps)) / 10000n;
        return sendJson(res, 200, {
          ok: true,
          sell,
          amt,
          out: q.out,
          priceImpactBps: q.priceImpactBps,
          minOut,
          slippageBps,
          feeBps: params.swapFeeBps,
          act: { k: 'swap', sell, amt: amt.toString(), minOut: minOut.toString() },
          note: 'minOut is yours to choose. A fill worse than it is refused, not executed — raising tolerance accepts a worse price, it does not avoid one.',
        });
      } catch (err) {
        return sendRefusal(res, Object.prototype.hasOwnProperty.call(E, err.message) ? err.message : 'BAD_REQUEST', { error: String(err.message) });
      }
    }

    if (path === '/api/v1/capacity') {
      return sendJson(res, 200, { ok: true, ...capacityLedger(world) });
    }

    if (path === '/api/v1/capacity/challenges') {
      const as = (url.searchParams.get('as') || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(as)) return sendRefusal(res, 'BAD_ADDRESS', { as: url.searchParams.get('as') });
      if (!world.accounts[as]) return sendRefusal(res, 'UNKNOWN_ACCOUNT', { as });
      const limit = Math.min(64, Math.max(1, Number(url.searchParams.get('limit')) || 16));
      const challenges = challengesFor(world, as, { limit, at: now() });
      const issuedAt = now();
      for (const c of challenges) register.issue(as, c.pid, c.shard, world.epoch.n, issuedAt);
      return sendJson(res, 200, {
        ok: true,
        as,
        epoch: world.epoch.n,
        seed: epochSeed(world),
        boundMs: Number(params.capProofLatencyBoundMs),
        issuedAt,
        challenges,
        note: challenges.length === 0
          ? 'No shard is placed on this node right now. Rendezvous placement is a pure function of the live node set, so this is not a queue you rise in — it changes when pictures or nodes do. A pledge nobody can challenge earns nothing.'
          : 'Answer within the bound. Concurrent random-range challenges are what distinguish three disks from one disk pretending to be three.',
      });
    }

    if (path === '/api/v1/oracle') {
      const stale = !oracleReading || now() - oracleReading.at > ORACLE_MAX_AGE_MS;
      if (stale) {
        try {
          await refreshOracle();
        } catch (err) {
          if (oracleSealed) {
            return sendJson(res, 200, {
              ok: true,
              live: true,
              ...oracleSealed,
              sealed: world.epoch.oracle,
              refreshFailed: { code: err.code || 'ORACLE_STALE', detail: err.detail || null },
            });
          }
          // The last sealed rate is what prices the epoch either way, so a failed
          // read is reported and the world keeps working. Answering with a rate
          // this host did not sign would be worse than answering with none.
          return sendJson(res, 200, {
            ok: true,
            live: false,
            code: err.code || 'ORACLE_STALE',
            detail: err.detail || null,
            sealed: world.epoch.oracle,
            note: 'No live read succeeded. Prices for this epoch are computed from the pair sealed at the last close, which is shown here.',
          });
        }
      }
      return sendJson(res, 200, { ok: true, live: Boolean(oracleSealed), ...(oracleSealed || {}), sealed: world.epoch.oracle });
    }

    if (path === '/api/v1/rules' || path.startsWith('/api/v1/rules/')) {
      const wanted = path === '/api/v1/rules' ? world.rules.version : path.slice('/api/v1/rules/'.length);
      if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(wanted)) return sendRefusal(res, 'RULES_VERSION_UNKNOWN', { version: wanted });
      try {
        const source = await readFile(join(ROOT, 'core', 'rules', `${wanted}.mjs`), 'utf8');
        return sendJson(res, 200, {
          ok: true,
          version: wanted,
          active: world.rules.version,
          hash: sha256Hex(source),
          shipped: [RULES_VERSION],
          key: world.rules.key,
          next: world.rules.next,
          fromEpoch: world.rules.fromEpoch,
          formula: 'mint_i = min( scheduledCap(epoch), emissionCapBps/10000 x creditedBurnWei_i ), then one uniform scaling if the round exceeds the epoch rail.',
          source,
        });
      } catch {
        return sendRefusal(res, 'RULES_VERSION_UNKNOWN', { version: wanted, shipped: [RULES_VERSION] });
      }
    }

    if (path === '/api/chain' || path === '/api/chain/head') {
      const text = await chainRaw(path.endsWith('head') ? 'head' : 'all');
      if (text === null || text.trim() === '' || text.trim() === '[]') {
        return sendRefusal(res, 'EPOCH_NOT_CLOSED', {
          built: false,
          next: 'Run node server/chain/build.mjs to seal the closed epochs. This host serves what the builder wrote and builds nothing itself.',
        });
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-cache',
        ...CORS,
      });
      res.end(req.method === 'HEAD' ? undefined : text);
      return;
    }

    if (path.startsWith('/media/')) {
      const cid = path.slice('/media/'.length);
      if (!isCid(cid)) return sendRefusal(res, 'BAD_REQUEST', { cid });
      const object = await store.get(cid);
      if (!object) {
        return sendRefusal(res, 'NOT_FOUND', {
          cid,
          why: 'either these bytes were never uploaded here, or the post that leased them settled and the picture was deleted.',
        });
      }
      const headers = store.headersFor(cid, object.mime, object.bytes.length);
      if (String(req.headers['if-none-match'] || '').includes(cid)) {
        res.writeHead(304, { ...headers, ...CORS });
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, ...CORS });
      res.end(req.method === 'HEAD' ? undefined : object.bytes);
      return;
    }

    if (path.startsWith('/api/')) {
      return sendRefusal(res, 'NOT_FOUND', { path, next: 'GET /api/v1 lists exactly what this host answers.' });
    }

    return serveStatic(req, res, url.pathname);
  }

  function commentsOf(pid) {
    return Object.keys(world.comments)
      .filter((cid) => world.comments[cid].pid === pid)
      .map((cid) => {
        const c = world.comments[cid];
        const author = world.accounts[c.author];
        return { cid, pid, author: c.author, handle: author ? author.handle : null, text: c.text, at: c.at };
      });
  }

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      // A throw that reaches here is this host's fault, not the caller's, and it
      // is reported as such rather than as a bad request.
      if (!res.headersSent) sendJson(res, 500, { ...refuse('UNCATALOGUED', { error: String(err && err.message) }), code: 'UNCATALOGUED' });
      else res.end();
    });
  });

  return {
    http: httpServer,
    get world() {
      return world;
    },
    log,
    store,
    register,
    key,
    submit,
    apiDoc,
    refreshOracle,
    get oracle() {
      return oracleSealed;
    },
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((r) => httpServer.listen(port, host, r));
      const a = httpServer.address();
      return { port: a.port, url: `http://${host}:${a.port}` };
    },
    async close() {
      await new Promise((r) => httpServer.close(r));
      await log.close();
    },
  };
}

// ── running it ─────────────────────────────────────────────────────────────

async function main() {
  const port = Number(process.env.PORT || 8787);
  const server = await createServer({});
  const { url } = await server.listen(port, process.env.HOST || '127.0.0.1');
  const w = server.world;
  process.stdout.write(
    [
      `Peer two Peer writer on ${url}`,
      `  log        ${server.log.path}  (${server.log.count} acts${server.log.truncatedBytes ? `, ${server.log.truncatedBytes} bytes of a partial last line truncated on open` : ''})`,
      `  world      epoch ${w.epoch.n}, ${Object.keys(w.accounts).length} accounts, ${Object.keys(w.posts).length} posts, ${w.log.skipped} acts skipped by replay`,
      `  burn       ${BURN_SCRIPT_HEX}  (p2wsh of a bare OP_RETURN — no key exists)`,
      `  signatures ${SIGNATURE_VERIFIER}`,
      `  api        ${url}/api/v1`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`writer failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
