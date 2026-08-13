// The producer key: Ed25519, generated beside the log it attests, and used for
// exactly one thing.
//
// It signs epoch blocks. It does not authorise an act, does not hold a balance,
// does not control the pool, and cannot alter a sealed block — it makes
// publication attributable, and that is the whole of its authority. This
// codebase holds no wallet and no spendable key: every act is signed by a
// member's own wallet key, the burn address has no key by construction, and the
// only secret any host of this network keeps is the one in this file.
//
// ── WHAT ATTRIBUTION BUYS, AND WHAT IT DOES NOT ────────────────────────────
//
// A signature over a block says who published it. It says nothing about whether
// the block is right: replay decides that, and a verifier who disagrees with a
// block does not argue with its signature — they replay the log and publish the
// discrepancy. So compromise of the machine holding this key is compromise of
// attribution going forward, and not of the record. That is stated in
// docs/DECENTRALIZATION.md as a known limit and it is repeated here because this
// is the file somebody reads when deciding where to put the key.
//
// ── NEVER SERVED, NEVER SYNCED, NEVER EXPORTED ─────────────────────────────
//
// The private half lives at `<data>/chain/producer.key`, which is inside the
// gitignored `data/` tree, and `ops/ipfs-pack.mjs` skips anything under
// `data/chain/` that looks like a key — a snapshot carrying it would hand every
// mirror the ability to sign in the producer's name. This module exports no
// function that returns private key material. `loadProducer` returns a signer
// whose private KeyObject is closed over and never handed out, so there is no
// call in the codebase that can accidentally serialise it into a response, a log
// line or a block.
//
// Verification needs only the public half, which travels in the block as
// `producer`. `verify.mjs` therefore runs against a record it fetched from
// anywhere, on a machine that has never held a key.
//
// ── WHY THE FILE MODE IS NOT THE WHOLE STORY ───────────────────────────────
//
// The key is written 0600 and with an exclusive-create flag so it can never be
// silently overwritten. On Windows the POSIX mode is largely advisory and the
// real control is the ACL of the directory it sits in; that is a fact about the
// platform rather than about this code, and it is written down rather than
// papered over with a mode that reads as a guarantee.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Where the key lives relative to the data directory. The same subdirectory the
 * packer refuses to pack. */
export const KEY_SUBDIR = 'chain';
export const PRIVATE_FILE = 'producer.key';
export const PUBLIC_FILE = 'producer.pub';

const HEX64_RE = /^[0-9a-f]{64}$/;
const SIG_HEX_RE = /^[0-9a-f]{128}$/;

/** The three paths this module touches, and no others. */
export function keyPaths(dir) {
  const home = path.join(dir, KEY_SUBDIR);
  return {
    dir: home,
    private: path.join(home, PRIVATE_FILE),
    public: path.join(home, PUBLIC_FILE),
  };
}

/**
 * The raw 32-byte public key as lowercase hex.
 *
 * A block carries this rather than PEM or DER: it is the key itself with no
 * envelope, it is the same 32 bytes every Ed25519 implementation agrees on, and
 * it reads as an identity in a JSON document instead of as a certificate.
 */
export function publicHexOf(key) {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new Error('CHAIN_KEY_NOT_ED25519');
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}

/** The inverse: a verifying key from the 32 bytes a block published. */
export function publicKeyFromHex(hex) {
  if (typeof hex !== 'string' || !HEX64_RE.test(hex)) throw new Error('CHAIN_KEY_MALFORMED');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Check a signature against a published public key.
 *
 * Returns a boolean and throws nothing: a malformed key, a malformed signature
 * and a wrong signature are all the same answer to the only question a verifier
 * is asking, and a verifier that crashed on hostile input would be a verifier an
 * attacker can stop.
 */
export function verifyBytes(publicHex, bytes, sigHex) {
  try {
    if (typeof sigHex !== 'string' || !SIG_HEX_RE.test(sigHex)) return false;
    return verify(null, bytes, publicKeyFromHex(publicHex), Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * A signer: the public half in the open, the private half closed over.
 *
 * Ed25519 signatures are deterministic (RFC 8032) — the same key over the same
 * bytes produces the same 64 bytes on every machine and every run. That is what
 * makes `build.mjs --rebuild` byte-identical rather than merely equivalent, and
 * it is a property of the curve rather than a choice made here.
 */
function signerFor(privateKey, file) {
  const publicKey = createPublicKey(privateKey);
  const publicHex = publicHexOf(publicKey);
  return Object.freeze({
    publicHex,
    file,
    sign(bytes) {
      return sign(null, bytes, privateKey).toString('hex');
    },
  });
}

/**
 * Load the producer key beside a log, or null if there is none.
 *
 * Null rather than a throw, because "no key here" is the ordinary state of a
 * mirror and of every machine that only verifies. Only the elected writer needs
 * one.
 */
export function loadProducer(dir) {
  const paths = keyPaths(dir);
  if (!existsSync(paths.private)) return null;
  try {
    const privateKey = createPrivateKey(readFileSync(paths.private, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('CHAIN_KEY_NOT_ED25519');
    return signerFor(privateKey, paths.private);
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    throw new Error(`CHAIN_KEY_UNREADABLE: ${paths.private}: ${why}`);
  }
}

/**
 * Generate a producer key, refusing to replace one that exists.
 *
 * The exclusive-create flag is the whole safety here. Overwriting a producer key
 * would orphan every block already signed with it — the chain would still verify
 * block by block, but the producer would have changed silently in the middle of
 * its own record, which is exactly the event `verify.mjs` treats as needing a
 * person.
 */
export function createProducer(dir) {
  const paths = keyPaths(dir);
  mkdirSync(paths.dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  writeFileSync(paths.private, pem, { mode: 0o600, flag: 'wx' });
  writeFileSync(paths.public, publicHexOf(publicKey) + '\n', { mode: 0o644 });
  return signerFor(privateKey, paths.private);
}

/** What a writer calls at startup: the key it already had, or a new one. */
export function loadOrCreateProducer(dir) {
  return loadProducer(dir) || createProducer(dir);
}

/**
 * The public key pinned beside the record, if one was written.
 *
 * `verify.mjs` uses it to hold a chain to the producer it was published under —
 * an internally consistent forgery signed by a different key verifies perfectly
 * on its own terms, and the only thing that distinguishes it is that it is not
 * signed by the key this record was always signed by.
 */
export function pinnedPublicHex(dir) {
  const paths = keyPaths(dir);
  if (!existsSync(paths.public)) return null;
  const text = readFileSync(paths.public, 'utf8').trim();
  return HEX64_RE.test(text) ? text : null;
}
