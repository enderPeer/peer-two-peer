// The account is a wallet address, and this file is the only place the client
// ever touches a key.
//
// ARCHITECTURE §4: every act is signed EIP-191 (`personal_sign`) over the
// canonical act body minus `sig`, and the acting address is RECOVERED from the
// signature rather than trusted from the `as` field. There are no passwords, no
// PINs and no server-held secrets, so that recovery is the entire authentication
// system of this network.
//
// Two ways to hold a key, and they are not equal:
//
//   INJECTED   an EIP-1193 provider (`window.ethereum`). The key never leaves the
//              wallet, the signature comes back over an RPC call, and this file
//              never sees a private byte. This is the path the app prefers and
//              the path it offers first.
//   LOCAL      a key this app generates and keeps in IndexedDB on this device.
//              It exists because a phone with no wallet installed would otherwise
//              be locked out of a network whose whole premise is that anyone can
//              join by destroying bitcoin. It is strictly worse and the app says
//              so in words the user cannot miss: the key is on ONE device, in ONE
//              browser profile, and nobody — not the operator, not the writer,
//              not the network — can restore it. There is no recovery path,
//              because a recovery path would be a party who can sign for you.
//
// What this file never does, in either mode: ask for a seed phrase, ask for a
// private key, accept one pasted in, or send one anywhere. `exportLocalKey` hands
// the user their own generated key back so they can write it down; that is the
// only direction a secret ever moves, and it moves to the person who owns it.
//
// ── WHY THE CRYPTO IS WRITTEN OUT HERE ─────────────────────────────────────
//
// The local path needs secp256k1 and keccak256 in a browser with no build step,
// no bundler and no CDN (ARCHITECTURE §11: the app ships nothing to anybody
// else's server). `ethers` exists in this repository for the contracts and the
// server; it is a bare specifier a browser cannot resolve without an import map
// and a copy of node_modules on the static host, so it is not reachable from
// here. WebCrypto has no secp256k1 and no keccak. That leaves the algorithms
// themselves, which are written below and checked in test/client.test.mjs
// against independent implementations: the point arithmetic and the signatures
// against node:crypto's OpenSSL secp256k1, and keccak256 against its published
// vectors. A crypto implementation nobody checked against a second one is a
// guess.
//
// ── REFUSAL CODES USED HERE ────────────────────────────────────────────────
// This module throws `new Error(code)` with catalogued strings, the same
// convention core/ uses and for the same reason — it must load in a browser with
// nothing behind it.
//
//   BAD_SIGNATURE   a signature does not recover to the address that claims it,
//                   or a provider answered with something that is not one.
//   BAD_ADDRESS     no account is connected, or the provider named none.
//   BAD_REQUEST     an act body cannot be canonically encoded, so it cannot be
//                   signed: whatever would be signed is not what would be sent.

// ── canonical JSON ─────────────────────────────────────────────────────────
//
// Imported, not restated. This block used to carry a second copy of the encoder
// with a note explaining that core/canonical.mjs "cannot be imported here: it
// opens with `import { createHash } from 'node:crypto'`, which no browser
// resolves" — and a byte-identity test defending the copy.
//
// That reason is gone: canonical.mjs no longer imports node:crypto, because the
// shared layer has to run unchanged in a browser for Rule 2 to mean anything.
// So the copy is gone with it. Every signature this file produces is now taken
// over bytes the writer's own encoder produced, rather than over bytes a second
// implementation agreed with as of the last time somebody ran the test.
//
// Signing an encoding that differs from the writer's by one byte produces a
// signature that recovers to a different address, and the refusal
// (BAD_SIGNATURE) says nothing about which byte. One implementation is the only
// arrangement in which that failure cannot arise.

export { canonicalJson } from '../core/canonical.mjs';
import { canonicalJson } from '../core/canonical.mjs';

/**
 * The body that is signed: the act without `sig` and without `i`.
 *
 * `sig` is out because a signature cannot cover itself. `i` is out because the
 * writer assigns it on acceptance (ARCHITECTURE §4) and the signer does not know
 * it yet — a body carrying an index the client guessed would be a body the writer
 * cannot reproduce, and every act would refuse with BAD_SIGNATURE.
 *
 * `t` is IN. It is the client's stamp on its own intent, and leaving it out would
 * make a captured act replayable at any later moment. A writer that overwrites
 * `t` with its own must verify against the body the client sent, not against the
 * body it rewrote; that is the one place where this file and the writer have to
 * mean the same thing, and it is stated here because a mismatch shows up only as
 * BAD_SIGNATURE with nothing to point at.
 */
export function signingBodyOf(act) {
  const body = {};
  for (const k of Object.keys(act)) {
    if (k === 'sig' || k === 'i') continue;
    if (act[k] === undefined) continue;
    body[k] = act[k];
  }
  return body;
}

/** The exact string a wallet is asked to sign for an act. */
export function signingMessage(act) {
  return canonicalJson(signingBodyOf(act));
}

// ── bytes ──────────────────────────────────────────────────────────────────

const UTF8 = new TextEncoder();
const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

export function fromHex(hex) {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error('BAD_REQUEST');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bigToBytes32(v) {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function bytesToBig(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

// ── keccak256 ──────────────────────────────────────────────────────────────
//
// Keccak-f[1600] with the original Keccak padding (0x01), which is what Ethereum
// hashes with — NOT SHA3-256, whose only difference is a 0x06 domain byte and
// which would produce a different address for every key. Lanes are held as
// BigInt because a 64-bit rotate in two 32-bit halves is four times the code and
// the same answer; nothing here is on a money path, so the cost is a hash per
// act and it is not measurable.

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rho offsets, indexed [x][y]
const KECCAK_ROT = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

const LANE_MASK = (1n << 64n) - 1n;

function rotl64(x, n) {
  if (n === 0n) return x;
  return ((x << n) | (x >> (64n - n))) & LANE_MASK;
}

function keccakF(A) {
  const B = new Array(25).fill(0n);
  const C = new Array(5).fill(0n);
  const D = new Array(5).fill(0n);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(A[x + 5 * y], KECCAK_ROT[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & LANE_MASK);
      }
    }
    A[0] ^= KECCAK_RC[round];
  }
  return A;
}

/** sha3-family keccak256 over bytes. Returns 32 bytes. */
export function keccak256(bytes) {
  const RATE = 136; // 1600 bits - 2 x 256 bits of capacity, in bytes
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[len] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

// ── secp256k1 ──────────────────────────────────────────────────────────────
//
// Short Weierstrass y² = x³ + 7 over F_p. Point arithmetic is in Jacobian
// coordinates so a scalar multiplication costs ONE modular inversion at the end
// rather than one per step; the affine form is shorter to write and about four
// hundred times slower, which on a phone is the difference between a signature
// the user does not notice and one they do.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const HALF_N = N >> 1n;

function mod(a, m) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Modular inverse by the extended Euclidean algorithm. Refuses zero rather than
 * returning a plausible number for a value that has no inverse. */
function invMod(a, m) {
  let lo = mod(a, m);
  if (lo === 0n) throw new Error('BAD_REQUEST');
  let hi = m;
  let x = 1n;
  let y = 0n;
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x, y] = [y - q * x, x];
  }
  return mod(x, m);
}

// A Jacobian point is [X, Y, Z] with x = X/Z², y = Y/Z³. Z = 0 is the point at
// infinity, which is the identity and never a valid public key.
const JZERO = [0n, 1n, 0n];

function jDouble(p) {
  const [X, Y, Z] = p;
  if (Y === 0n || Z === 0n) return JZERO;
  const A = mod(X * X, P);
  const B = mod(Y * Y, P);
  const C = mod(B * B, P);
  const D = mod(2n * (mod((X + B) * (X + B), P) - A - C), P);
  const E = mod(3n * A, P);
  const F = mod(E * E, P);
  const X3 = mod(F - 2n * D, P);
  const Y3 = mod(E * (D - X3) - 8n * C, P);
  const Z3 = mod(2n * Y * Z, P);
  return [X3, Y3, Z3];
}

function jAdd(p, q) {
  const [X1, Y1, Z1] = p;
  const [X2, Y2, Z2] = q;
  if (Z1 === 0n) return q;
  if (Z2 === 0n) return p;
  const Z1Z1 = mod(Z1 * Z1, P);
  const Z2Z2 = mod(Z2 * Z2, P);
  const U1 = mod(X1 * Z2Z2, P);
  const U2 = mod(X2 * Z1Z1, P);
  const S1 = mod(Y1 * Z2 * Z2Z2, P);
  const S2 = mod(Y2 * Z1 * Z1Z1, P);
  if (U1 === U2) {
    if (S1 !== S2) return JZERO;
    return jDouble(p);
  }
  const H = mod(U2 - U1, P);
  const I = mod(4n * H * H, P);
  const J = mod(H * I, P);
  const r = mod(2n * (S2 - S1), P);
  const V = mod(U1 * I, P);
  const X3 = mod(r * r - J - 2n * V, P);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J, P);
  const Z3 = mod((mod((Z1 + Z2) * (Z1 + Z2), P) - Z1Z1 - Z2Z2) * H, P);
  return [X3, Y3, Z3];
}

function jMul(k, p) {
  let acc = JZERO;
  let add = p;
  let n = k;
  while (n > 0n) {
    if (n & 1n) acc = jAdd(acc, add);
    add = jDouble(add);
    n >>= 1n;
  }
  return acc;
}

function toAffine(p) {
  const [X, Y, Z] = p;
  if (Z === 0n) throw new Error('BAD_SIGNATURE');
  const zi = invMod(Z, P);
  const zi2 = mod(zi * zi, P);
  return { x: mod(X * zi2, P), y: mod(Y * zi2 * zi, P) };
}

const G = [GX, GY, 1n];

/** A private key is a scalar in [1, n-1]. Anything else is not a key. */
function needPrivate(priv) {
  const d = priv instanceof Uint8Array ? bytesToBig(priv) : priv;
  if (typeof d !== 'bigint' || d <= 0n || d >= N) throw new Error('BAD_ADDRESS');
  return d;
}

/** The uncompressed public key, 64 bytes of X‖Y with no 0x04 prefix — which is
 * the form the address is hashed from. */
export function publicKeyOf(priv) {
  const { x, y } = toAffine(jMul(needPrivate(priv), G));
  return concatBytes(bigToBytes32(x), bigToBytes32(y));
}

/** The address of a 64-byte public key: the last twenty bytes of its keccak256,
 * lowercase. Replay folds every address to this spelling (core/replay.mjs
 * `readAddress`), so the client never produces a checksummed one. */
export function addressFromPublicKey(pub64) {
  if (!(pub64 instanceof Uint8Array) || pub64.length !== 64) throw new Error('BAD_ADDRESS');
  return '0x' + toHex(keccak256(pub64).subarray(12));
}

export function addressOfPrivateKey(priv) {
  return addressFromPublicKey(publicKeyOf(priv));
}

// ── the nonce ──────────────────────────────────────────────────────────────

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/**
 * The per-signature nonce, RFC 6979 HMAC-DRBG seeded with the key, the digest
 * AND thirty-two fresh random bytes.
 *
 * Deterministic k is the standard advice because a repeated nonce across two
 * different messages leaks the private key outright. Adding entropy — RFC 6979
 * §3.6 — keeps that property and adds a second one: a mistake in this derivation
 * cannot make two signatures share a nonce, because the random half differs
 * every time. The cost is that two signatures of one message differ, so a test
 * cannot assert determinism; it asserts validity instead, which is the property
 * that matters and the one an independent verifier can check.
 */
async function nonces(d, digest) {
  const extra = crypto.getRandomValues(new Uint8Array(32));
  let V = new Uint8Array(32).fill(0x01);
  let K = new Uint8Array(32).fill(0x00);
  const x = bigToBytes32(d);
  const h = bigToBytes32(mod(bytesToBig(digest), N));
  K = await hmacSha256(K, concatBytes(V, Uint8Array.of(0x00), x, h, extra));
  V = await hmacSha256(K, V);
  K = await hmacSha256(K, concatBytes(V, Uint8Array.of(0x01), x, h, extra));
  V = await hmacSha256(K, V);
  return {
    async next() {
      V = await hmacSha256(K, V);
      const k = bytesToBig(V);
      K = await hmacSha256(K, concatBytes(V, Uint8Array.of(0x00)));
      V = await hmacSha256(K, V);
      return k;
    },
  };
}

// ── signing and recovery ───────────────────────────────────────────────────

/**
 * ECDSA over a 32-byte digest. Returns `{ r, s, recid }` with s normalised to the
 * lower half of the order.
 *
 * Low-s is not cosmetic: (r, s) and (r, n−s) are both valid for the same message,
 * so a network that accepted both would accept two distinct signed bodies for one
 * intent — and this network deduplicates acts by signature (DUPLICATE_ACT). The
 * recovery id flips with the normalisation, which is why it is computed before
 * and corrected after.
 */
export async function signDigest(priv, digest) {
  const d = needPrivate(priv);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('BAD_REQUEST');
  const z = mod(bytesToBig(digest), N);
  const drbg = await nonces(d, digest);
  for (let attempt = 0; attempt < 64; attempt++) {
    const k = await drbg.next();
    if (k <= 0n || k >= N) continue;
    const R = toAffine(jMul(k, G));
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(invMod(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let recid = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
    if (s > HALF_N) {
      s = N - s;
      recid ^= 1;
    }
    return { r, s, recid };
  }
  throw new Error('BAD_SIGNATURE');
}

/** The 64-byte public key that produced a signature over this digest. */
export function recoverPublicKey(digest, { r, s, recid }) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('BAD_SIGNATURE');
  const x = recid & 2 ? r + N : r;
  if (x >= P) throw new Error('BAD_SIGNATURE');
  // p ≡ 3 (mod 4), so the square root is a single exponentiation.
  const alpha = mod(x * x * x + 7n, P);
  const beta = powMod(alpha, (P + 1n) / 4n, P);
  if (mod(beta * beta, P) !== alpha) throw new Error('BAD_SIGNATURE');
  const y = (beta & 1n) === BigInt(recid & 1) ? beta : P - beta;
  const R = [x, y, 1n];
  const z = mod(bytesToBig(digest), N);
  const rInv = invMod(r, N);
  // Q = r⁻¹ (sR − zG)
  const Q = jMul(rInv, jAdd(jMul(s, R), jMul(mod(-z, N), G)));
  const { x: qx, y: qy } = toAffine(Q);
  return concatBytes(bigToBytes32(qx), bigToBytes32(qy));
}

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

// ── EIP-191 ────────────────────────────────────────────────────────────────

/**
 * The digest `personal_sign` actually signs:
 *
 *   keccak256("\x19Ethereum Signed Message:\n" ‖ byteLength ‖ message)
 *
 * The prefix is what stops a signature over an act from also being a valid
 * signature over a transaction. The length is the BYTE length of the UTF-8
 * message, not its character count — a comment with one emoji in it differs by
 * three, and the whole signature with it.
 */
export function eip191Hash(message) {
  const bytes = typeof message === 'string' ? UTF8.encode(message) : message;
  return keccak256(concatBytes(UTF8.encode('Ethereum Signed Message:\n' + bytes.length), bytes));
}

/** A 65-byte signature as the hex string a wallet returns: r ‖ s ‖ v, v = 27+recid. */
export function encodeSignature({ r, s, recid }) {
  return '0x' + toHex(bigToBytes32(r)) + toHex(bigToBytes32(s)) + HEX[27 + recid];
}

export function decodeSignature(hex) {
  const bytes = fromHex(hex);
  if (bytes.length !== 65) throw new Error('BAD_SIGNATURE');
  let v = bytes[64];
  // Wallets have shipped 0/1, 27/28 and EIP-155 chain-shifted values. All three
  // mean the same one bit; anything else is not a recovery id.
  if (v >= 27) v -= 27;
  if (v >= 4) v = (v - 35) % 2;
  if (v !== 0 && v !== 1 && v !== 2 && v !== 3) throw new Error('BAD_SIGNATURE');
  return { r: bytesToBig(bytes.subarray(0, 32)), s: bytesToBig(bytes.subarray(32, 64)), recid: v };
}

/** Sign a message with a local key exactly as `personal_sign` would. */
export async function personalSign(priv, message) {
  return encodeSignature(await signDigest(priv, eip191Hash(message)));
}

/** The address that signed this message, lowercase. This is the check the writer
 * performs; the client performs it too, on its own signature, before sending —
 * an act that cannot be verified here would come back as BAD_SIGNATURE with
 * nothing to point at. */
export function recoverPersonalSign(message, signature) {
  return addressFromPublicKey(recoverPublicKey(eip191Hash(message), decodeSignature(signature)));
}

// ── the local key store ────────────────────────────────────────────────────

const DB_NAME = 'ptp-wallet';
const DB_STORE = 'keys';
const DB_KEY = 'local';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('BAD_ADDRESS'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('BAD_ADDRESS'));
  });
}

function idbRun(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The IndexedDB-backed key store. Swappable, because a test has no IndexedDB and
 * because a browser in private mode may have none either — in which case the app
 * says the device cannot hold a key rather than pretending it did.
 */
export function idbKeyStore() {
  return {
    async load() {
      const db = await idbOpen();
      const row = await idbRun(db, 'readonly', (store) => store.get(DB_KEY));
      db.close();
      if (!row || !row.priv) return null;
      return { priv: new Uint8Array(row.priv), address: row.address };
    },
    async save(record) {
      const db = await idbOpen();
      await idbRun(db, 'readwrite', (store) =>
        store.put({ priv: Array.from(record.priv), address: record.address, at: Date.now() }, DB_KEY),
      );
      db.close();
    },
    async clear() {
      const db = await idbOpen();
      await idbRun(db, 'readwrite', (store) => store.delete(DB_KEY));
      db.close();
    },
  };
}

/**
 * What the user is told before a local key is created, verbatim.
 *
 * It is a constant rather than markup so that the same sentences appear wherever
 * the choice is offered and so that a test can assert they are still there. The
 * claim in the last line is the one that matters and it is literally true: the
 * network holds no copy of this key and has no mechanism that could produce one.
 */
export const LOCAL_KEY_WARNING = Object.freeze([
  'This key is generated here and stored only in this browser, on this device.',
  'Clearing site data, using a private window, or losing the device loses the account, its balance and its posts.',
  'Nobody can restore it — not the operator, not the writer, not the network. There is no reset, because a reset would be somebody who can sign for you.',
  'Write down the backup below and keep it off this device.',
]);

// ── the wallet ─────────────────────────────────────────────────────────────

/**
 * The one object the client asks to sign things.
 *
 * `mode` is 'none' until something is connected, then 'injected' or 'local'. The
 * app offers the injected path first and only shows the local one when no
 * provider is present, because a key this app can read is strictly worse than a
 * key it cannot.
 */
export function createWallet(options = {}) {
  const provider = options.provider !== undefined ? options.provider : globalThis.ethereum;
  const store = options.store || null;
  let mode = 'none';
  let address = null;
  let local = null; // { priv, address } — only ever in memory and in the store
  const listeners = new Set();

  function announce() {
    for (const fn of listeners) fn({ mode, address });
  }

  function state() {
    return { mode, address, hasProvider: Boolean(provider) };
  }

  async function connectInjected() {
    if (!provider || typeof provider.request !== 'function') throw new Error('BAD_ADDRESS');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const first = Array.isArray(accounts) ? accounts[0] : null;
    if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first)) throw new Error('BAD_ADDRESS');
    mode = 'injected';
    address = first.toLowerCase();
    local = null;
    // A wallet can change accounts under the app at any moment. Following it is
    // the honest behaviour: the alternative is signing the next act as somebody
    // the user is no longer.
    if (typeof provider.on === 'function') {
      provider.on('accountsChanged', (next) => {
        const a = Array.isArray(next) ? next[0] : null;
        address = typeof a === 'string' ? a.toLowerCase() : null;
        if (!address) mode = 'none';
        announce();
      });
    }
    announce();
    return address;
  }

  /** Load a local key that already exists on this device. Returns null when there
   * is none — creating one is a separate, explicit act by the user. */
  async function loadLocal() {
    if (!store) return null;
    const row = await store.load().catch(() => null);
    if (!row) return null;
    local = row;
    mode = 'local';
    address = row.address;
    announce();
    return address;
  }

  /**
   * Generate a key on this device and keep it. The caller must have shown
   * LOCAL_KEY_WARNING first; this function does not enforce that, because a
   * function cannot check that somebody read something, and pretending otherwise
   * would be the kind of ceremony that teaches people to click through.
   */
  async function createLocal() {
    if (!store) throw new Error('BAD_ADDRESS');
    let priv;
    // Rejection sampling: a scalar drawn uniformly from 2²⁵⁶ is out of range with
    // probability about 2⁻¹²⁸, and taking it modulo n instead would bias the key.
    for (;;) {
      priv = crypto.getRandomValues(new Uint8Array(32));
      const d = bytesToBig(priv);
      if (d > 0n && d < N) break;
    }
    const record = { priv, address: addressOfPrivateKey(priv) };
    await store.save(record);
    local = record;
    mode = 'local';
    address = record.address;
    announce();
    return address;
  }

  /** The user's own key, handed back to the user so they can write it down. The
   * only direction a secret ever travels in this file. */
  function exportLocalKey() {
    if (mode !== 'local' || !local) throw new Error('BAD_ADDRESS');
    return '0x' + toHex(local.priv);
  }

  async function forgetLocal() {
    if (store) await store.clear().catch(() => {});
    local = null;
    if (mode === 'local') {
      mode = 'none';
      address = null;
      announce();
    }
  }

  /**
   * Sign an act. Returns the act with `sig` attached — the same object shape the
   * writer is handed and the same one `actError` validated.
   *
   * The signature is verified here before the act leaves, in both modes. In the
   * local mode that catches an arithmetic mistake in this file; in the injected
   * mode it catches a provider that signed as a different account than the one it
   * named, which is a real failure mode when a user switches accounts mid-flight.
   */
  async function signAct(act) {
    if (!address) throw new Error('BAD_ADDRESS');
    const body = signingBodyOf({ ...act, as: address });
    const message = canonicalJson(body);
    let sig;
    if (mode === 'injected') {
      sig = await provider.request({
        method: 'personal_sign',
        params: ['0x' + toHex(UTF8.encode(message)), address],
      });
      if (typeof sig !== 'string') throw new Error('BAD_SIGNATURE');
    } else if (mode === 'local') {
      sig = await personalSign(local.priv, message);
    } else {
      throw new Error('BAD_ADDRESS');
    }
    if (recoverPersonalSign(message, sig) !== address) throw new Error('BAD_SIGNATURE');
    return { ...body, sig };
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    state,
    connectInjected,
    loadLocal,
    createLocal,
    exportLocalKey,
    forgetLocal,
    signAct,
    onChange,
    get address() {
      return address;
    },
    get mode() {
      return mode;
    },
  };
}
