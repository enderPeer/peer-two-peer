// Who stores what, decided by arithmetic instead of by a coordinator.
//
// A picture's bytes are split into fixed-size shards and each shard is held by
// REPLICATION nodes. The hard part is not choosing holders; it is that a browser
// node and a server node must choose the SAME holders, at the same moment, while
// nodes are joining and leaving, with nobody in charge of the answer. That is
// rendezvous hashing (highest random weight): every candidate node scores itself
// against the shard, and the top scorers win. No state, no gossip, no election —
// the placement is a pure function of (live node set, cid, shard index).
//
// The property that makes it the right choice here is stability under churn.
// Adding one node to a set of N steals exactly its own share: for any given
// shard the newcomer either beats an existing holder or it does not, and no
// other node's ranking changes relative to any third node. So one join moves
// about 1/(N+1) of all replica slots and no others — the rest of the network
// keeps serving what it was already serving. `test/placement.test.mjs` asserts
// both the fraction and the stronger invariant behind it.
//
// Why sha256 is implemented here rather than imported: this module runs in the
// browser and on the server unchanged, and it must be synchronous — a scoring
// function that returned a promise would make placement a source of ordering
// bugs. `node:crypto` is not in a browser, and WebCrypto's digest is async, so
// the only isomorphic synchronous option is the algorithm itself. It is ~70
// lines and it is checked against node:crypto in the tests.

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

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

const UTF8 = new TextEncoder();

// Domain-separated preimage. The unit separator between fields is what stops
// ("ab","c") and ("a","bc") from hashing alike; U+001F cannot occur in a hex
// cid, a 0x-address node id or a decimal index, so the encoding is injective
// over the inputs this module accepts.
function digestOf(parts) {
  return sha256Bytes(UTF8.encode(parts.join('')));
}

/**
 * The width of every proof window, in bytes.
 *
 * Fixed rather than configurable: a challenge whose size a node could influence
 * is a challenge a node can make cheap. 4096 is one page — small enough that
 * answering costs nothing honest, large enough that guessing the hash of an
 * unseen range is not a strategy.
 */
export const CHALLENGE_BYTES = 4096;

/**
 * A node's claim on one shard, as a 256-bit integer.
 *
 * The whole digest is used rather than a prefix so that ties are astronomically
 * unlikely and the ranking is effectively total; where a tie does occur,
 * `placeShard` breaks it on the node id, so even that case stays deterministic.
 * BigInt because comparing hex strings would order by ASCII and comparing
 * Numbers would collapse the low 200 bits into float error — this value is not
 * money, but it must be exact for two independent readers to agree.
 */
export function nodeScore(nodeId, cid, shardIndex) {
  if (typeof nodeId !== 'string' || nodeId === '') throw new TypeError('nodeScore: nodeId must be a non-empty string');
  if (typeof cid !== 'string' || cid === '') throw new TypeError('nodeScore: cid must be a non-empty string');
  if (!Number.isInteger(shardIndex) || shardIndex < 0) throw new TypeError('nodeScore: shardIndex must be a non-negative integer');
  return BigInt('0x' + toHex(digestOf([nodeId, cid, String(shardIndex)])));
}

/**
 * The nodes that should hold one shard, best first.
 *
 * Ranked by score descending, ties broken by node id ascending, so the answer is
 * a pure function of the inputs and identical in every reader. Duplicate ids in
 * `nodes` are folded first — a node listed twice would otherwise hold two of the
 * replicas and the picture would be one machine away from being lost.
 *
 * When fewer nodes exist than `replication` asks for, every node is returned
 * rather than throwing. A small network is under-replicated, which is a fact the
 * caller should see in the length of the list; refusing to place at all would
 * mean a network of two cannot store anything.
 */
export function placeShard(nodes, cid, shardIndex, replication) {
  if (!Array.isArray(nodes)) throw new TypeError('placeShard: nodes must be an array');
  if (!Number.isInteger(replication) || replication < 0) throw new TypeError('placeShard: replication must be a non-negative integer');
  if (replication === 0) return [];

  const seen = new Set();
  const ranked = [];
  for (const id of nodes) {
    if (seen.has(id)) continue;
    seen.add(id);
    ranked.push({ id, score: nodeScore(id, cid, shardIndex) });
  }
  ranked.sort((x, y) => {
    if (x.score !== y.score) return x.score > y.score ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return ranked.slice(0, replication).map((r) => r.id);
}

/**
 * Every shard index a picture of this size occupies.
 *
 * The count is ceil(byteLength / shardBytes) — the last shard is short and is
 * never padded, because padding would change the bytes a challenge hashes and
 * the cid commits to the real length anyway. A zero-length payload has no
 * shards; there is nothing to place and nothing to prove.
 *
 * `cid` is taken and validated but does not enter the count: shard boundaries
 * are a function of size alone, which is what lets a node work out what it owes
 * from the post act without ever seeing the bytes.
 */
export function shardsOf(cid, byteLength, shardBytes) {
  if (typeof cid !== 'string' || cid === '') throw new TypeError('shardsOf: cid must be a non-empty string');
  if (!Number.isInteger(byteLength) || byteLength < 0) throw new TypeError('shardsOf: byteLength must be a non-negative integer');
  if (!Number.isInteger(shardBytes) || shardBytes <= 0) throw new TypeError('shardsOf: shardBytes must be a positive integer');
  const n = Math.ceil(byteLength / shardBytes);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * The byte range a holder of this shard is asked to hash this epoch.
 *
 * The offset is derived from sha256(cid, shardIndex, epochSeed), so the writer
 * issues no secret and every reader can recompute the challenge from public
 * data — including the node being challenged, which does not matter: knowing
 * WHICH bytes are wanted is useless without having them. The epoch seed is what
 * moves the window, so an answer memorised last epoch is worth nothing now.
 *
 * `shardBytes` must be the actual length of this shard, which for the final
 * shard of a picture is shorter than the nominal shard size. A window is clamped
 * to fit, so a shard smaller than CHALLENGE_BYTES is challenged whole.
 *
 * Offsets and lengths are Numbers, not BigInt: they index a byte array, they are
 * bounded by the shard size, and no balance is derived from them.
 */
export function challengeFor(cid, shardIndex, epochSeed, shardBytes) {
  if (typeof cid !== 'string' || cid === '') throw new TypeError('challengeFor: cid must be a non-empty string');
  if (!Number.isInteger(shardIndex) || shardIndex < 0) throw new TypeError('challengeFor: shardIndex must be a non-negative integer');
  if (typeof epochSeed !== 'string' || epochSeed === '') throw new TypeError('challengeFor: epochSeed must be a non-empty string');
  if (!Number.isInteger(shardBytes) || shardBytes <= 0) throw new TypeError('challengeFor: shardBytes must be a positive integer');

  const length = Math.min(CHALLENGE_BYTES, shardBytes);
  const span = BigInt(shardBytes - length + 1);
  const h = BigInt('0x' + toHex(digestOf([cid, String(shardIndex), epochSeed])));
  const offset = Number(h % span);
  return { offset, length };
}

/**
 * The answer to a challenge: sha256 of the named byte range, hex.
 *
 * Refuses rather than hashing a short slice when the range runs past the end of
 * what was handed in. A node holding a truncated shard would otherwise produce a
 * confident-looking hash of fewer bytes, and the verifier — which computes the
 * expected answer from a complete copy — would only see a mismatch, not the
 * reason for it. Failing here names the real problem where it can be fixed.
 */
export function answerChallenge(bytes, challenge) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('answerChallenge: bytes must be a Uint8Array');
  if (!challenge || !Number.isInteger(challenge.offset) || !Number.isInteger(challenge.length)) {
    throw new TypeError('answerChallenge: challenge must be { offset, length } integers');
  }
  const { offset, length } = challenge;
  if (offset < 0 || length <= 0 || offset + length > bytes.length) {
    throw new RangeError(
      `answerChallenge: range [${offset}, ${offset + length}) is outside the ${bytes.length} bytes held`,
    );
  }
  return toHex(sha256Bytes(bytes.subarray(offset, offset + length)));
}
