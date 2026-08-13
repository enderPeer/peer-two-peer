// A merkle tree is only worth building if every leaf in it proves and nothing
// else does. Both halves are tested here, at every tree size that has ever
// broken an implementation: one leaf, two, and every odd count where the last
// element rises without a partner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { leafOf, buildTree, verifyProof, rootOf, EMPTY_ROOT } from '../core/merkle.mjs';
import { canonicalBytes, sha256Hex } from '../core/canonical.mjs';

// Acts shaped like ARCHITECTURE §4's, since that is what actually goes in.
const act = (i, k) => ({ i, t: 1786445193465 + i, as: '0x' + i.toString(16).padStart(2, '0'), k });
const acts = (n) => Array.from({ length: n }, (_, i) => act(i, i % 2 ? 'view' : 'like'));

// Both domains recomputed here independently of core/merkle.mjs, so the tests
// are a second implementation of the construction rather than a mirror of it.
// A leaf is 0x00-tagged, an interior node 0x01-tagged; see the header of
// core/merkle.mjs for why the tags exist at all.
function tagLeaf(contentHex) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(contentHex, 'hex')]))
    .digest('hex');
}

function hashPair(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  const [lo, hi] = Buffer.compare(x, y) <= 0 ? [x, y] : [y, x];
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), lo, hi])).digest('hex');
}

test('a leaf is sha256 over canonical bytes, and key order does not change it', () => {
  const l = leafOf(act(7, 'view'));
  assert.match(l, /^[0-9a-f]{64}$/);
  assert.equal(l, sha256Hex(canonicalBytes(act(7, 'view'))));
  assert.equal(l, createHash('sha256').update(canonicalBytes(act(7, 'view'))).digest('hex'));
  // Rebuilt in a different order: same leaf, which is the only reason two
  // nodes holding the same act land on the same root.
  const reordered = { k: 'view', as: '0x07', t: 1786445193472, i: 7 };
  assert.equal(leafOf(reordered), l);
  // Sha256 and not keccak, so a verifier with nothing installed can recompute
  // it. Pinned here so the choice cannot drift silently.
  assert.equal(leafOf('peer'), createHash('sha256').update('"peer"').digest('hex'));
});

test('a one-leaf tree is its tagged leaf, with an empty proof', () => {
  const leaves = [leafOf(act(0, 'like'))];
  const t = buildTree(leaves);
  // Not the content digest itself: the root is the leaf lifted into the leaf
  // domain. That one byte is what stops an interior node re-entering as a leaf.
  assert.equal(t.root, tagLeaf(leaves[0]));
  assert.notEqual(t.root, leaves[0]);
  assert.deepEqual(t.proofOf(0), []);
  assert.equal(verifyProof(leaves[0], [], t.root), true);
  // And nothing else proves against it.
  assert.equal(verifyProof(leafOf(act(1, 'like')), [], t.root), false);
});

test('a two-leaf tree is one sorted, domain-tagged pair', () => {
  const leaves = acts(2).map(leafOf);
  const t = buildTree(leaves);
  assert.equal(t.root, hashPair(tagLeaf(leaves[0]), tagLeaf(leaves[1])));
  assert.deepEqual(t.proofOf(0), [tagLeaf(leaves[1])]);
  assert.deepEqual(t.proofOf(1), [tagLeaf(leaves[0])]);
  // Pair-sorting means the two proofs are the same shape and the order of the
  // pair does not have to be carried alongside them.
  assert.equal(verifyProof(leaves[0], t.proofOf(0), t.root), true);
  assert.equal(verifyProof(leaves[1], t.proofOf(1), t.root), true);
});

test('an interior node cannot be presented as a leaf', () => {
  // This forgery worked before the domain bytes: verifyProof(hashPair(a,b),
  // [c], root) returned true, proving membership of something that was never
  // committed. §9 makes acts[] a list of digests, so the "canonical JSON is
  // printable ASCII" defence never applied here.
  const leaves = acts(3).map(leafOf);
  const t = buildTree(leaves);
  const interior = hashPair(tagLeaf(leaves[0]), tagLeaf(leaves[1]));
  assert.equal(verifyProof(interior, [tagLeaf(leaves[2])], t.root), false);
  assert.equal(verifyProof(interior, [leaves[2]], t.root), false);
});

test('the root fixes the leaf count', () => {
  // Also measured broken before: root([a,b,c]) === root([H(ab),c]), so two
  // different act lists sealed to one commitment. PtpAnchor stores only roots,
  // so "the count is sealed beside it" was not an answer.
  const leaves = acts(3).map(leafOf);
  const t3 = buildTree(leaves);
  const distilled = buildTree([hashPair(tagLeaf(leaves[0]), tagLeaf(leaves[1])), leaves[2]]);
  assert.notEqual(t3.root, distilled.root);

  const four = acts(4).map(leafOf);
  const t4 = buildTree(four);
  const pairs = buildTree([
    hashPair(tagLeaf(four[0]), tagLeaf(four[1])),
    hashPair(tagLeaf(four[2]), tagLeaf(four[3])),
  ]);
  assert.notEqual(t4.root, pairs.root);
});

test('every leaf proves, at every tree size from 1 to 33', () => {
  for (let n = 1; n <= 33; n++) {
    const leaves = acts(n).map(leafOf);
    const t = buildTree(leaves);
    assert.match(t.root, /^[0-9a-f]{64}$/);
    for (let i = 0; i < n; i++) {
      const proof = t.proofOf(i);
      assert.ok(verifyProof(leaves[i], proof, t.root), `leaf ${i} of ${n}`);
      // The proof is a path, so its length is the depth: about log2(n).
      assert.ok(proof.length <= Math.ceil(Math.log2(n)) + 1);
    }
  }
});

test('odd counts promote the last element unchanged', () => {
  // Three leaves: the third has no partner on the bottom level and rises, so
  // its proof is one element shorter than the others'.
  const leaves = acts(3).map(leafOf);
  const t = buildTree(leaves);
  assert.equal(
    t.root,
    hashPair(hashPair(tagLeaf(leaves[0]), tagLeaf(leaves[1])), tagLeaf(leaves[2]))
  );
  assert.equal(t.proofOf(2).length, 1);
  assert.equal(t.proofOf(0).length, 2);
  for (let i = 0; i < 3; i++) assert.ok(verifyProof(leaves[i], t.proofOf(i), t.root));

  // Five and seven, the sizes where the promotion happens on an upper level
  // rather than the bottom one.
  for (const n of [5, 7, 9, 11]) {
    const ls = acts(n).map(leafOf);
    const tree = buildTree(ls);
    for (let i = 0; i < n; i++) assert.ok(verifyProof(ls[i], tree.proofOf(i), tree.root), `${i}/${n}`);
  }
});

test('a tampered leaf does not prove', () => {
  const originals = acts(9);
  const leaves = originals.map(leafOf);
  const t = buildTree(leaves);

  // One field changed in one act — the smallest lie the record can tell.
  const forged = leafOf({ ...originals[4], k: 'view' === originals[4].k ? 'like' : 'view' });
  assert.notEqual(forged, leaves[4]);
  assert.equal(verifyProof(forged, t.proofOf(4), t.root), false);

  // A real leaf with somebody else's proof.
  assert.equal(verifyProof(leaves[4], t.proofOf(5), t.root), false);

  // A real leaf, its own proof, one sibling swapped.
  const bent = t.proofOf(4).slice();
  bent[0] = leaves[8];
  assert.equal(verifyProof(leaves[4], bent, t.root), false);

  // A leaf that was never in the tree.
  assert.equal(verifyProof(leafOf(act(99, 'like')), t.proofOf(0), t.root), false);

  // A proof with a truncated path.
  assert.equal(verifyProof(leaves[4], t.proofOf(4).slice(0, -1), t.root), false);

  // Changing any act changes the root, which is the point of anchoring one.
  const changed = originals.slice();
  changed[4] = { ...changed[4], t: changed[4].t + 1 };
  assert.notEqual(buildTree(changed.map(leafOf)).root, t.root);
});

test('the root depends on order, and the tree refuses what it cannot commit to', () => {
  const leaves = acts(4).map(leafOf);
  const swapped = [leaves[1], leaves[0], leaves[2], leaves[3]];
  // Pairs are sorted internally, so swapping WITHIN a pair leaves the root
  // alone — an honest property of this construction, not a bug, and the act
  // index inside each leaf is what fixes the order that matters.
  assert.equal(buildTree(swapped).root, buildTree(leaves).root);
  // Swapping ACROSS pairs changes the root.
  assert.notEqual(buildTree([leaves[2], leaves[1], leaves[0], leaves[3]]).root, buildTree(leaves).root);

  // An empty tree has nothing to commit to and is refused rather than given a
  // conventional digest that two different absences could share.
  assert.throws(() => buildTree([]), /empty tree/);
  assert.throws(() => buildTree(null), /empty tree/);

  // Leaves must be digests. A caller passing raw values instead of leafOf()
  // output finds out immediately.
  assert.throws(() => buildTree(['not a digest']), /lowercase sha256 hex/);
  assert.throws(() => buildTree([leaves[0].toUpperCase()]), /lowercase sha256 hex/);
  assert.throws(() => buildTree([{ i: 1 }]), /lowercase sha256 hex/);

  const t = buildTree(leaves);
  assert.throws(() => t.proofOf(4), /no such leaf/);
  assert.throws(() => t.proofOf(-1), /no such leaf/);

  // verifyProof answers false rather than throwing: it is fed untrusted input
  // by definition, and a verifier that throws on a malformed proof is a
  // verifier somebody can crash.
  assert.equal(verifyProof('short', [], t.root), false);
  assert.equal(verifyProof(leaves[0], ['nope'], t.root), false);
  assert.equal(verifyProof(leaves[0], null, t.root), false);
  assert.equal(verifyProof(leaves[0], t.proofOf(0), 'not a root'), false);
});

test('an epoch that committed nothing still has a root, in its own domain', () => {
  // buildTree stays strict — two different absences must not hash alike — but
  // refusing is not the same as having no answer. PtpAnchor requires each seal
  // to be exactly highestEpoch + 1, so an epoch with no committable acts and
  // therefore no root would block the chain permanently: a quiet day would end
  // the network. rootOf is the one place that case is answered.
  assert.equal(rootOf([]), EMPTY_ROOT);
  assert.match(EMPTY_ROOT, /^[0-9a-f]{64}$/);
  assert.notEqual(EMPTY_ROOT, '0'.repeat(64)); // the anchor's non-zero check must pass

  // With leaves, rootOf is buildTree and nothing else.
  const leaves = acts(5).map(leafOf);
  assert.equal(rootOf(leaves), buildTree(leaves).root);
  assert.equal(rootOf([leaves[0]]), buildTree([leaves[0]]).root);
  assert.notEqual(rootOf(leaves), EMPTY_ROOT);

  // The third domain byte is what makes "nothing" unreachable from any act.
  // Sweeping every tree size confirms no real epoch can be mistaken for empty,
  // which is what lets a verifier tell an empty epoch from a withheld one.
  for (let n = 1; n <= 33; n++) {
    assert.notEqual(buildTree(acts(n).map(leafOf)).root, EMPTY_ROOT, `size ${n}`);
  }

  // And nothing proves into it: the sentinel is a statement, not a tree.
  assert.equal(verifyProof(leaves[0], [], EMPTY_ROOT), false);
  assert.equal(verifyProof(EMPTY_ROOT, [], EMPTY_ROOT), false);

  assert.throws(() => rootOf(null), /must be an array/);
});
