// Merkle roots and proofs over an ordered list of canonical values.
//
// A root carries no normative meaning. It selects nothing, validates nothing,
// and decides nothing — replay decides, hashes only carry (ARCHITECTURE §9).
// What it buys is that a block is a small fixed-size commitment to an ordered
// act range, checkable leaf by leaf, so a member can prove their own act, their
// own earnings or their own picture's tombstone was in the sealed set without
// holding the set.
//
// SHA-256, NOT keccak. Every other merkle tree in this lineage used keccak
// because its verifier was a Solidity contract and keccak is what the EVM
// hashes cheaply. Here the anchor commits sha256 roots, because the same digest
// has to be computable by three readers that share no dependencies: the chain
// builder on node:crypto, the browser on SubtleCrypto, and a verifier with
// nothing installed at all. Solidity has a sha256 precompile, so the contract
// pays a little more gas and the rest of the network pays nothing.
//
// The construction, fixed so a Solidity verifier reproduces it bit for bit:
//
//   content  sha256(canonical bytes of the value)        ← what `leafOf` returns
//   leaf     sha256(0x00 ‖ content)                      ← the tree's own domain
//   node     sha256(0x01 ‖ min(a,b) ‖ max(a,b))          over RAW 32-byte digests
//   odd      a node with no partner rises unchanged
//
// Pair-sorting is the OpenZeppelin convention: because the children are
// ordered by value rather than by position, a proof needs only the sibling
// digests and never a side-bit, which is what makes `verifyProof` four lines in
// Solidity as well as here.
//
// WHY THE DOMAIN BYTES, since the standard verifier has none. Without them a
// leaf and an interior node are drawn from the same set, and three things break
// that an adversarial pass measured rather than theorised:
//
//   * verifyProof(hashPair(a,b), [c], root) returned TRUE — an interior node
//     presented as a leaf, proving membership of something never committed;
//   * root([a,b,c]) === root([H(ab),c]) — the root did not fix the leaf count,
//     so two different act lists sealed to one commitment;
//   * the usual defence ("a leaf is sha256 of canonical JSON, and canonical
//     JSON is printable ASCII, so it cannot BE a pair of raw digests") does not
//     apply here at all, because §9 defines `acts[]` as a list of DIGESTS. The
//     chain builder hands raw digests straight into the leaf domain.
//
// Prefixing costs one byte per hash and one `abi.encodePacked` argument in
// Solidity. It buys injectivity between the two domains, which is the property
// the whole block header rests on. A tree built by the old rule and one built
// by this rule produce different roots; that is intended and is why the block
// seals the edition of this file.

import { canonicalBytes, sha256Hex } from './canonical.mjs';

/**
 * The leaf hash of a value: sha256 over its canonical bytes.
 *
 * Going through core/canonical.mjs rather than JSON.stringify is the whole
 * point — two nodes that hold the same act must produce the same leaf, and
 * plain JSON.stringify makes that depend on the order somebody built an object
 * in. Returns lowercase hex without "0x", the same form core/canonical.mjs
 * uses; a caller passing one to a `bytes32` argument prefixes it there.
 */
export function leafOf(value) {
  return sha256Hex(canonicalBytes(value));
}

/** The domain bytes. They are the whole of the separation; see the header. */
const LEAF_DOMAIN = Buffer.from([0x00]);
const NODE_DOMAIN = Buffer.from([0x01]);
const EMPTY_DOMAIN = Buffer.from([0x02]);

/**
 * The root of an epoch that had nothing to commit.
 *
 * `buildTree` refuses an empty list and that refusal is right: inventing a
 * digest for "no acts" out of the leaf or node domain would let two different
 * absences hash alike. But refusing is not the same as having no answer, and
 * this turned out to be load-bearing rather than academic. PtpAnchor now
 * requires each sealed epoch to be exactly `highestEpoch + 1`, so an epoch that
 * produced no committable acts and therefore posted no root would block the
 * chain permanently — a quiet day would end the network.
 *
 * So absence gets its own domain byte. This value is not reachable as a leaf
 * (0x00), not reachable as an interior node (0x01), and not reachable from any
 * act however chosen; it says exactly "this epoch committed nothing" and
 * nothing else. The anchor's non-zero check passes, the chain advances, and a
 * verifier can tell an empty epoch from a withheld one.
 */
export const EMPTY_ROOT = sha256Hex(Buffer.concat([EMPTY_DOMAIN, Buffer.from('ptp/merkle/empty', 'utf8')]));

/**
 * The root of a list that may be empty — what a chain builder should call.
 *
 * `buildTree` stays strict for every caller that knows it has leaves; this is
 * the one place the empty case is answered, so the sentinel cannot leak into
 * proof checking.
 */
export function rootOf(leaves) {
  if (!Array.isArray(leaves)) throw new Error('merkle: leaves must be an array');
  return leaves.length === 0 ? EMPTY_ROOT : buildTree(leaves).root;
}

/** The fourth domain: a leaf that carries its own position. */
const POSITION_DOMAIN = Buffer.from([0x03]);

/**
 * Bind a content digest to its index in an ordered list.
 *
 *   positional = sha256(0x03 ‖ uint64be(index) ‖ content)
 *
 * WHY THIS EXISTS. Pair-sorting is what makes a proof four lines in Solidity —
 * children are ordered by value, so no side-bit is needed — but it has a
 * consequence that was missed until an adversarial pass measured it: **the root
 * commits to the multiset of leaves, not to their order.** Swap two acts and
 * the root is unchanged. ARCHITECTURE §9 calls `acts[]` an "ordered act range"
 * and replay is order-dependent all the way down — an act's effect depends on
 * every act before it — so a root that does not fix the order is a root that
 * does not commit to the state it claims to.
 *
 * Folding the position into the leaf closes it without giving up pair-sorting:
 * the ordering lives inside the leaf's preimage instead of in the tree's shape.
 * A verifier proving act 7 proves it was act 7.
 */
export function positionalLeaf(index, contentHex) {
  if (!Number.isInteger(index) || index < 0) throw new Error('merkle: index must be a non-negative integer');
  if (typeof contentHex !== 'string' || !/^[0-9a-f]{64}$/.test(contentHex)) {
    throw new Error('merkle: leaf is not a lowercase sha256 hex digest');
  }
  const pos = Buffer.alloc(8);
  pos.writeBigUInt64BE(BigInt(index));
  return sha256Hex(Buffer.concat([POSITION_DOMAIN, pos, Buffer.from(contentHex, 'hex')]));
}

/**
 * The root of an ORDERED list of content digests — what `actsRoot` and
 * `payloadsRoot` must use.
 *
 * Same empty-case answer as `rootOf`, so a quiet epoch still seals. Use
 * `rootOf` only where the set genuinely carries no order.
 */
export function orderedRootOf(digests) {
  if (!Array.isArray(digests)) throw new Error('merkle: leaves must be an array');
  if (digests.length === 0) return EMPTY_ROOT;
  return buildTree(digests.map((h, i) => positionalLeaf(i, h))).root;
}

/**
 * Lift a content digest into the tree's leaf domain.
 *
 * `leafOf` gives the digest of a value; this gives the digest of "that value,
 * as a leaf of this tree". Keeping the two apart is what stops an interior node
 * from ever being presentable as a leaf, and it is applied in exactly two
 * places — when a tree is built and when a proof is checked — so the two can
 * never drift.
 */
function tagLeaf(contentHex) {
  return sha256Hex(Buffer.concat([LEAF_DOMAIN, Buffer.from(contentHex, 'hex')]));
}

// A hex digest string and its raw bytes sort the same way — lowercase hex is
// order-preserving nibble by nibble across strings of equal length — but the
// bytes are what gets hashed, so the comparison is done on the bytes and the
// equivalence is left as a remark rather than relied on.
function hashPair(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  const [lo, hi] = Buffer.compare(x, y) <= 0 ? [x, y] : [y, x];
  return sha256Hex(Buffer.concat([NODE_DOMAIN, lo, hi]));
}

/**
 * Build the tree over an ordered list of leaf hashes (hex, as returned by
 * `leafOf`).
 *
 * Returns the root and a `proofOf(index)` that yields the sibling digests on
 * the path from that leaf up. Every level is kept, so proofs are handed out
 * without rebuilding anything.
 *
 * An empty list is refused rather than given a conventional root. A block with
 * no acts has nothing to commit to, and inventing a digest for it would let two
 * different absences hash alike.
 *
 * A one-leaf tree has that leaf as its root and an empty proof. That is the
 * correct degenerate case and it is the one most verifiers get wrong, so it is
 * a test.
 */
export function buildTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('merkle: empty tree');
  for (const h of leaves) {
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) {
      throw new Error('merkle: leaf is not a lowercase sha256 hex digest');
    }
  }

  // Level 0 is the leaves lifted into the leaf domain, not the content digests
  // themselves. Everything above is built with the node domain, so the two sets
  // are disjoint and no interior value can re-enter as a leaf.
  const levels = [leaves.map(tagLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      // An odd last element rises without a partner. The duplication attacks
      // this convention is usually accused of are closed by the domain bytes,
      // not by the block's leaf count: a promoted node keeps its 0x01 tag, so
      // a shorter list whose members happen to be interior digests hashes to a
      // different root than the longer list it was distilled from.
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }

  return {
    root: levels[levels.length - 1][0],

    /** The siblings on the path from leaf `index` to the root, bottom up. */
    proofOf(index) {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
        throw new Error('merkle: no such leaf');
      }
      const proof = [];
      let i = index;
      for (let lvl = 0; lvl < levels.length - 1; lvl++) {
        const nodes = levels[lvl];
        const sibling = i ^ 1; // the partner in the pair: 0↔1, 2↔3, …
        if (sibling < nodes.length) proof.push(nodes[sibling]);
        i = i >> 1;
      }
      return proof;
    },
  };
}

/**
 * Recompute a root from a leaf and its proof — the same four lines a Solidity
 * verifier runs, so a proof that passes here passes on chain.
 *
 * Fold the leaf up through the siblings, sorting each pair, and compare with
 * the root. No side-bits are needed and none are accepted: sorting is what
 * makes the path unambiguous.
 *
 * `leaf` is a CONTENT digest — what `leafOf` returns, or an entry of the
 * block's `acts[]`. It is lifted into the leaf domain here, exactly as
 * `buildTree` lifts it, so a caller can never smuggle an interior node in by
 * handing it over pre-hashed.
 */
export function verifyProof(leaf, proof, root) {
  if (typeof leaf !== 'string' || typeof root !== 'string' || !Array.isArray(proof)) return false;
  if (!/^[0-9a-f]{64}$/.test(leaf) || !/^[0-9a-f]{64}$/.test(root)) return false;
  let node = tagLeaf(leaf);
  for (const sib of proof) {
    if (typeof sib !== 'string' || !/^[0-9a-f]{64}$/.test(sib)) return false;
    node = hashPair(node, sib);
  }
  return node === root;
}
