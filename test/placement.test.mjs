// Placement is only useful if two machines that never speak reach the same
// answer, and only affordable if that answer barely changes when a machine
// joins. These tests assert exactly those two things, plus the arithmetic
// underneath them.
//
// The sha256 in core/placement.mjs is hand-written so the module can run in a
// browser synchronously. That is a liability unless it is checked, so the first
// suite compares it against node:crypto — the tests run in Node, where the real
// implementation is available, even though the module may not use it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CHALLENGE_BYTES,
  nodeScore,
  placeShard,
  shardsOf,
  challengeFor,
  answerChallenge,
} from '../core/placement.mjs';

// A cheap deterministic generator, so every run of this file tests the same
// network. A random seed here would make a churn failure unreproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

const rnd = lcg(20260812);

const NODES_10 = Array.from({ length: 10 }, (_, i) => `node-${String(i).padStart(2, '0')}-${(rnd() >>> 0).toString(16)}`);
const NEWCOMER = 'node-10-thelatecomer';
const NODES_11 = [...NODES_10, NEWCOMER];

const CIDS = Array.from({ length: 100 }, () => {
  let h = '';
  for (let i = 0; i < 8; i++) h += (rnd() >>> 0).toString(16).padStart(8, '0');
  return h;
});

const SHARDS_PER_CID = 4;
const REPLICATION = 3;

function everyKey() {
  const keys = [];
  for (const cid of CIDS) for (let s = 0; s < SHARDS_PER_CID; s++) keys.push([cid, s]);
  return keys;
}

// ── the hand-written sha256 ────────────────────────────────────────────────

test('answerChallenge hashes byte ranges exactly as node:crypto does', () => {
  const cases = [0, 1, 55, 56, 63, 64, 65, 1000, 4096, 8191];
  for (const n of cases) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = rnd() & 0xff;
    if (n === 0) continue; // an empty range is refused by design; see below
    const got = answerChallenge(bytes, { offset: 0, length: n });
    const want = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    assert.equal(got, want, `sha256 mismatch over ${n} bytes`);
  }
});

test('answerChallenge hashes only the challenged window', () => {
  const bytes = new Uint8Array(10000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = rnd() & 0xff;
  const challenge = { offset: 1234, length: CHALLENGE_BYTES };
  const got = answerChallenge(bytes, challenge);
  const want = createHash('sha256')
    .update(Buffer.from(bytes.subarray(1234, 1234 + CHALLENGE_BYTES)))
    .digest('hex');
  assert.equal(got, want);
});

test('answerChallenge refuses a range the holder cannot cover', () => {
  const bytes = new Uint8Array(100);
  assert.throws(() => answerChallenge(bytes, { offset: 50, length: 100 }), RangeError);
  assert.throws(() => answerChallenge(bytes, { offset: -1, length: 10 }), RangeError);
  assert.throws(() => answerChallenge(bytes, { offset: 0, length: 0 }), RangeError);
});

// ── scoring ────────────────────────────────────────────────────────────────

test('nodeScore is deterministic and fills the 256-bit range', () => {
  const a = nodeScore(NODES_10[0], CIDS[0], 0);
  const b = nodeScore(NODES_10[0], CIDS[0], 0);
  assert.equal(a, b);
  assert.equal(typeof a, 'bigint');
  assert.ok(a >= 0n && a < (1n << 256n));
});

test('nodeScore separates its fields', () => {
  // Without a separator in the preimage these two would collide. The digest is
  // sha256(nodeId ‖ cid ‖ shardIndex) only in the sense that it is injective
  // over the triple; concatenation alone is not.
  assert.notEqual(nodeScore('ab', 'c', 0), nodeScore('a', 'bc', 0));
  assert.notEqual(nodeScore('n', 'cid', 1), nodeScore('n', 'cid', 11));
});

// ── placement ──────────────────────────────────────────────────────────────

test('placeShard returns exactly the replication count, deduplicated', () => {
  for (const [cid, s] of everyKey().slice(0, 40)) {
    const got = placeShard(NODES_10, cid, s, REPLICATION);
    assert.equal(got.length, REPLICATION);
    assert.equal(new Set(got).size, REPLICATION);
    for (const id of got) assert.ok(NODES_10.includes(id));
  }
  assert.deepEqual(placeShard(NODES_10, CIDS[0], 0, 0), []);
  assert.equal(placeShard(NODES_10, CIDS[0], 0, 10).length, 10);
  // More replicas than nodes returns every node rather than throwing: an
  // under-replicated network is a fact to observe, not an error to raise.
  assert.equal(placeShard(NODES_10, CIDS[0], 0, 25).length, 10);
  // A node listed twice must not hold two of the three replicas.
  assert.equal(placeShard([...NODES_10, NODES_10[0]], CIDS[0], 0, REPLICATION).length, REPLICATION);
});

test('placeShard is a pure function of the node SET, not of its order', () => {
  const shuffled = [...NODES_10];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const [cid, s] of everyKey()) {
    assert.deepEqual(placeShard(shuffled, cid, s, REPLICATION), placeShard(NODES_10, cid, s, REPLICATION));
  }
});

test('placeShard ranks by descending score', () => {
  const got = placeShard(NODES_10, CIDS[7], 2, 10);
  const scores = got.map((id) => nodeScore(id, CIDS[7], 2));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] > scores[i]);
});

// ── the churn property ─────────────────────────────────────────────────────

test('adding one node to ten moves about 1/11 of replica slots and nothing else', () => {
  const keys = everyKey(); // 100 cids x 4 shards = 400 shards
  let slotsTotal = 0;
  let slotsMoved = 0;
  let setsChanged = 0;

  for (const [cid, s] of keys) {
    const before = placeShard(NODES_10, cid, s, REPLICATION);
    const after = placeShard(NODES_11, cid, s, REPLICATION);

    assert.equal(after.length, REPLICATION);
    slotsTotal += REPLICATION;

    const beforeSet = new Set(before);
    const afterSet = new Set(after);

    // The invariant that makes rendezvous hashing worth using: the only node
    // that can APPEAR in a placement after a join is the node that joined.
    // Every displacement is therefore one slot, and no shard is ever handed
    // between two incumbents.
    for (const id of afterSet) {
      if (!beforeSet.has(id)) assert.equal(id, NEWCOMER, `${id} appeared without joining`);
    }
    // And the only node that can DISAPPEAR is one the newcomer outranked.
    const gone = before.filter((id) => !afterSet.has(id));
    assert.ok(gone.length <= 1, 'more than one holder was displaced by a single join');
    if (gone.length === 1) assert.ok(afterSet.has(NEWCOMER));

    if (gone.length === 1) {
      slotsMoved += 1;
      setsChanged += 1;
    }
  }

  const movedFraction = slotsMoved / slotsTotal;
  // Expectation is exactly 1/(N+1) = 1/11 ≈ 0.0909 of replica slots. The band
  // is wide enough that binomial noise over 400 shards does not flake and tight
  // enough that a coordinator-shaped bug (rehash everything) fails loudly.
  assert.ok(
    movedFraction > 0.04 && movedFraction < 0.16,
    `moved ${(movedFraction * 100).toFixed(2)}% of replica slots, expected ~9.1%`,
  );
  // Sanity in the other direction: something must move, or the newcomer is
  // storing nothing and the network has not grown.
  assert.ok(setsChanged > 0);
});

test('removing a node moves only the shards it held', () => {
  const shrunk = NODES_10.slice(0, 9);
  const leaver = NODES_10[9];
  for (const [cid, s] of everyKey()) {
    const before = placeShard(NODES_10, cid, s, REPLICATION);
    const after = placeShard(shrunk, cid, s, REPLICATION);
    if (!before.includes(leaver)) {
      assert.deepEqual(after, before, 'a placement changed although its holders all stayed');
    } else {
      const kept = before.filter((id) => id !== leaver);
      for (const id of kept) assert.ok(after.includes(id), 'a surviving holder lost its shard');
    }
  }
});

// ── shard arithmetic ───────────────────────────────────────────────────────

test('shardsOf covers the payload and no more', () => {
  const cid = CIDS[0];
  assert.deepEqual(shardsOf(cid, 0, 1024), []);
  assert.deepEqual(shardsOf(cid, 1, 1024), [0]);
  assert.deepEqual(shardsOf(cid, 1024, 1024), [0]);
  assert.deepEqual(shardsOf(cid, 1025, 1024), [0, 1]);
  assert.equal(shardsOf(cid, 1024 * 1024, 65536).length, 16);
  assert.throws(() => shardsOf(cid, 10, 0), TypeError);
  assert.throws(() => shardsOf(cid, -1, 1024), TypeError);
});

// ── challenges ─────────────────────────────────────────────────────────────

test('challengeFor is deterministic, in range, and moves with the epoch seed', () => {
  const cid = CIDS[3];
  const shardBytes = 65536;
  const a = challengeFor(cid, 2, 'epoch-seed-41', shardBytes);
  const b = challengeFor(cid, 2, 'epoch-seed-41', shardBytes);
  assert.deepEqual(a, b);
  assert.equal(a.length, CHALLENGE_BYTES);
  assert.ok(a.offset >= 0 && a.offset + a.length <= shardBytes);

  const c = challengeFor(cid, 2, 'epoch-seed-42', shardBytes);
  assert.notDeepEqual(a, c, 'the window did not move between epochs');

  // Across many epochs the window must actually roam, or a node could cache one
  // answer and pass forever.
  const seen = new Set();
  for (let e = 0; e < 200; e++) seen.add(challengeFor(cid, 0, `seed-${e}`, shardBytes).offset);
  assert.ok(seen.size > 150, `only ${seen.size} distinct offsets over 200 epochs`);
});

test('challengeFor clamps to a short final shard', () => {
  const small = challengeFor(CIDS[1], 9, 'seed', 1000);
  assert.equal(small.offset, 0);
  assert.equal(small.length, 1000);

  const exact = challengeFor(CIDS[1], 9, 'seed', CHALLENGE_BYTES);
  assert.equal(exact.offset, 0);
  assert.equal(exact.length, CHALLENGE_BYTES);
});

test('a holder answers its own challenge and a pretender cannot', () => {
  const shardBytes = 16384;
  const bytes = new Uint8Array(shardBytes);
  for (let i = 0; i < shardBytes; i++) bytes[i] = rnd() & 0xff;

  const challenge = challengeFor(CIDS[5], 1, 'epoch-7', shardBytes);
  const answer = answerChallenge(bytes, challenge);
  assert.match(answer, /^[0-9a-f]{64}$/);
  assert.equal(answerChallenge(bytes, challenge), answer);

  // One byte altered inside the window breaks the answer; the same byte altered
  // outside it does not — which is why the window moves every epoch.
  const inside = Uint8Array.from(bytes);
  inside[challenge.offset] ^= 0x01;
  assert.notEqual(answerChallenge(inside, challenge), answer);

  const outsideAt = (challenge.offset + challenge.length) % shardBytes;
  if (outsideAt < challenge.offset || outsideAt >= challenge.offset + challenge.length) {
    const outside = Uint8Array.from(bytes);
    outside[outsideAt] ^= 0x01;
    assert.equal(answerChallenge(outside, challenge), answer);
  }
});
