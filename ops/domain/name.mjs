#!/usr/bin/env node
// The network's own name, derived from the genesis producer key.
//
//   node ops/domain/name.mjs
//   node ops/domain/name.mjs --pubkey <hex|base64|PEM path> --cid <cid>
//
// Prints three names, all three of which anyone can recompute from public data:
//
//   1. the ptp1 label   — this network's identity, a hash of the genesis
//                         producer public key. Not a DNS name and not an
//                         address; the thing the other two are names FOR.
//   2. the IPNS name    — a mutable pointer the producer key can re-sign, so a
//                         reader who bookmarks it follows the network forward.
//   3. the DNSLink TXT  — the record a real domain publishes to point at the
//                         current CID.
//
// ── Why derive a name at all ────────────────────────────────────────────────
// Every other name in this system belongs to somebody: a domain to a registrar,
// a handle to a registry, an account to an issuer. Each of those is a lever
// somebody else can pull. The ptp1 label is a hash of a public key, so it was
// not issued, cannot be revoked, cannot be transferred, and costs nothing to
// verify — you recompute it. It is the one name that is arithmetic.
//
// What it is NOT is a way to reach anything. A hash resolves nowhere. Reaching
// the network is the CID's job (immutable, exact) or IPNS's (mutable, signed).
// The label's job is to let two people establish they mean the same network,
// which is a different question and the one that keeps being confused with it.
//
// ── Derivation, so a stranger can redo it ───────────────────────────────────
//   label = "ptp1" + base32( sha256( "ptp:name:v1" || pubkey )[0..20] )
//
// Twenty bytes of a domain-separated sha256, lower-case RFC 4648 base32 with no
// padding: 32 characters, a 36-character label that fits DNS's 63-byte limit
// with room to spare and survives being read aloud. The prefix carries a
// version so a future derivation can exist beside this one instead of silently
// replacing it. There is no checksum: the check is recomputation from the key,
// which is stronger than any four-character tail, and a label that verifies
// only against itself would invite exactly the shortcut this design refuses.

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { base32Encode } from '../ipfs-pack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');

/** The domain separator. Changing it changes every derived name, which is why
 *  it carries a version rather than being the bare string "ptp". */
export const NAME_DOMAIN = 'ptp:name:v1';
export const LABEL_BYTES = 20;

/**
 * Generic big-integer base encoding, used for multibase base36.
 *
 * IPNS names are conventionally printed in base36 ("k51qzi…") because base32 of
 * the same bytes overflows the 63-character DNS label limit that subdomain
 * gateways need. Leading zero bytes become leading zero digits rather than
 * disappearing into the integer, which is what makes the encoding reversible.
 */
export function baseEncode(bytes, alphabet) {
  const base = BigInt(alphabet.length);
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = alphabet[Number(n % base)] + out; n /= base; }
  for (const b of bytes) { if (b !== 0) break; out = alphabet[0] + out; }
  return out || alphabet[0];
}

/**
 * Accept a public key in any of the shapes it actually turns up in: raw hex,
 * base64, an `ed25519:`-prefixed string, or a PEM/DER SPKI file.
 *
 * Being permissive here is deliberate. The alternative is an operator pasting
 * a key in the wrong encoding, getting a name that is perfectly well-formed and
 * wrong, and publishing it. Every branch below ends at the same 32 raw bytes or
 * at a refusal that says what was wrong.
 */
export function parsePublicKey(input) {
  let text = String(input).trim();
  if (existsSync(text)) text = readFileSync(text, 'utf8').trim();

  if (text.includes('BEGIN PUBLIC KEY') || text.includes('BEGIN PRIVATE KEY')) {
    const key = createPublicKey(text);
    const jwk = key.export({ format: 'jwk' });
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
      throw new Error(`that key is ${jwk.kty}/${jwk.crv || jwk.alg}; the producer key is Ed25519`);
    }
    return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  }

  text = text.replace(/^ed25519:/i, '').replace(/\s+/g, '');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
    return new Uint8Array(Buffer.from(text.replace(/^0x/, ''), 'hex'));
  }
  const b64 = Buffer.from(text, 'base64');
  if (b64.length === 32) return new Uint8Array(b64);
  throw new Error(
    `cannot read that as an Ed25519 public key: got ${text.length} characters, ` +
    'expected 64 hex digits, 32 bytes of base64, or a PEM file path',
  );
}

/**
 * The ptp1 label: the network's self-created name.
 *
 * Deterministic from the genesis producer public key and nothing else — not
 * from the CID, which changes at every publication, and not from a domain,
 * which somebody else controls. Two people holding the same public key derive
 * the same label with no coordination, which is the entire requirement.
 */
export function ptpLabel(pubkey) {
  if (pubkey.length !== 32) throw new Error(`Ed25519 public keys are 32 bytes; got ${pubkey.length}`);
  const digest = createHash('sha256')
    .update(Buffer.from(NAME_DOMAIN, 'utf8'))
    .update(Buffer.from(pubkey))
    .digest();
  return 'ptp1' + base32Encode(new Uint8Array(digest.subarray(0, LABEL_BYTES)));
}

/**
 * The IPNS name for the same key: a CIDv1 with the libp2p-key codec over an
 * identity multihash of the key's protobuf encoding.
 *
 * "Identity multihash" means the key is carried literally rather than hashed —
 * an Ed25519 public key is 32 bytes, small enough to inline, so anyone holding
 * the name holds the key that must have signed the record it points at. That
 * is what makes IPNS resolution verifiable without asking anybody who the
 * publisher is.
 *
 * Both encodings are returned. base36 is the customary form and the one that
 * fits in a DNS label; base32 is what a CID library prints by default. They are
 * the same 40 bytes and either works everywhere IPNS does.
 */
export function ipnsName(pubkey) {
  if (pubkey.length !== 32) throw new Error(`Ed25519 public keys are 32 bytes; got ${pubkey.length}`);
  // libp2p PublicKey protobuf: field 1 = KeyType Ed25519 (1), field 2 = key bytes.
  const proto = new Uint8Array([0x08, 0x01, 0x12, 0x20, ...pubkey]);
  // multihash 0x00 = identity, then the length.
  const mh = new Uint8Array([0x00, proto.length, ...proto]);
  // CIDv1 (0x01) with codec libp2p-key (0x72).
  const cid = new Uint8Array([0x01, 0x72, ...mh]);
  return {
    base36: 'k' + baseEncode(cid, '0123456789abcdefghijklmnopqrstuvwxyz'),
    base32: 'b' + base32Encode(cid),
    bytes: cid,
  };
}

/**
 * The DNSLink TXT value for a target.
 *
 * `/ipfs/<cid>` pins the domain to exact bytes: it cannot change under a reader
 * and it goes stale at the next publication. `/ipns/<name>` follows the network
 * forward but requires the producer key to keep re-signing. Publishing the CID
 * form is the honest default — a reader gets what the operator meant on the day
 * they set it, and a name that silently follows a key is a name whose holder
 * can change what a domain says without touching DNS.
 */
export function dnslinkValue(target) {
  const t = String(target).trim();
  if (t.startsWith('/ipfs/') || t.startsWith('/ipns/')) return `dnslink=${t}`;
  if (/^ba[a-z0-9]{20,}$/.test(t)) return `dnslink=/ipfs/${t}`;
  if (/^k[0-9a-z]{20,}$/.test(t)) return `dnslink=/ipns/${t}`;
  throw new Error(`not a CID or IPNS name: ${t}`);
}

/**
 * Everything at once: the label, the IPNS name, and the DNSLink value for a
 * CID. One call so callers cannot derive two of the three from different keys,
 * which is the mistake that produces a domain pointing at a network nobody
 * recognises.
 */
export function derive(pubkey, cid = null) {
  const ipns = ipnsName(pubkey);
  return {
    pubkey: Buffer.from(pubkey).toString('hex'),
    label: ptpLabel(pubkey),
    ipns: ipns.base36,
    ipnsBase32: ipns.base32,
    cid,
    dnslinkCid: cid ? dnslinkValue(cid) : null,
    dnslinkIpns: dnslinkValue(`/ipns/${ipns.base36}`),
  };
}

// ── entry point ─────────────────────────────────────────────────────────────

function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; }

// Where a producer public key plausibly lives, in the order to try. All of
// these are public by construction — the SIGNING key is never read here, never
// packed by ipfs-pack.mjs and never leaves the machine that seals blocks.
function findPublicKey() {
  const explicit = arg('--pubkey') || process.env.PTP_GENESIS_PUBKEY;
  if (explicit) return { source: arg('--pubkey') ? '--pubkey' : 'env PTP_GENESIS_PUBKEY', text: explicit };
  const dataDir = process.env.PTP_DATA_DIR || join(REPO, 'data');
  for (const p of [
    join(dataDir, 'chain', 'producer.pub'),
    join(dataDir, 'chain', 'genesis.pub'),
    join(REPO, 'ops', 'domain', 'producer.pub'),
  ]) {
    if (existsSync(p)) return { source: p, text: readFileSync(p, 'utf8') };
  }
  return null;
}

function findCid() {
  const explicit = arg('--cid') || process.env.PTP_SITE_CID;
  if (explicit) return explicit.trim();
  for (const p of [join(REPO, 'dist', 'site.cid'), join(REPO, 'dist', 'ptp-site.cid')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return null;
}

function main() {
  const found = findPublicKey();
  if (!found) {
    console.error('no genesis producer public key found.');
    console.error('');
    console.error('The name is derived from that key and from nothing else, so there is no name');
    console.error('without it. Supply it any of these ways:');
    console.error('');
    console.error('    node ops/domain/name.mjs --pubkey <64 hex digits>');
    console.error('    node ops/domain/name.mjs --pubkey path/to/producer.pem');
    console.error('    PTP_GENESIS_PUBKEY=<hex> node ops/domain/name.mjs');
    console.error('    put it at data/chain/producer.pub');
    console.error('');
    console.error('It is the PUBLIC half of the epoch chain\'s producer key — the one every block');
    console.error('already carries in its `producer` field. Nothing here reads a signing key.');
    process.exit(1);
  }

  let pubkey;
  try { pubkey = parsePublicKey(found.text); }
  catch (e) { console.error(`${found.source}: ${e.message}`); process.exit(1); }

  const cid = findCid();
  const d = derive(pubkey, cid);

  console.log(`key       ${d.pubkey}`);
  console.log(`          from ${found.source}`);
  console.log('');
  console.log('── 1. the ptp1 label — the network\'s own name ──────────────────────────');
  console.log(`  ${d.label}`);
  console.log('  Derived, not issued. Recompute it from the public key above:');
  console.log(`    "ptp1" + base32( sha256( "${NAME_DOMAIN}" || pubkey )[0..${LABEL_BYTES}] )`);
  console.log('  It resolves nowhere by itself. It is how two people agree they mean the');
  console.log('  same network, not how either of them reaches it.');
  console.log('');
  console.log('── 2. the IPNS name — the pointer that moves ───────────────────────────');
  console.log(`  ${d.ipns}`);
  console.log(`  ${d.ipnsBase32}   (base32, same bytes)`);
  console.log('  https://<gateway>/ipns/' + d.ipns + '/');
  console.log(`  https://${d.ipns}.ipns.<gateway>/`);
  console.log('  Republish it whenever the CID changes:');
  console.log('    ipfs name publish --key=ptp /ipfs/<cid>');
  console.log('  Only the producer key can. A record expires — republish before it does, or');
  console.log('  the pointer goes quiet while the CID underneath is still perfectly reachable.');
  console.log('');
  console.log('── 3. the DNSLink TXT — for a domain, if there is one ──────────────────');
  if (d.dnslinkCid) {
    console.log(`  _dnslink   TXT   "${d.dnslinkCid}"`);
    console.log('    Exact bytes. Cannot change under a reader; goes stale at the next publish.');
  } else {
    console.log('  (no CID known — run `node ops/ipfs-pack.mjs` first, or pass --cid)');
    console.log('  _dnslink   TXT   "dnslink=/ipfs/<cid>"');
  }
  console.log(`  _dnslink   TXT   "${d.dnslinkIpns}"`);
  console.log('    Follows the network forward, as long as the key keeps re-signing.');
  console.log('');
  console.log('  Publish ONE of those two, not both: two _dnslink values on one name is a');
  console.log('  resolver picking for you, differently on different days.');
  console.log('');
  console.log('The name is not the network. Every one of these can be taken, lost or left to');
  console.log('expire, and the network is still at its CID. See ops/domain/README.md.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
