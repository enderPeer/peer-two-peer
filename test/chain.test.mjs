// The epoch chain, held to the four things it claims.
//
//   it is DETERMINISTIC — the same record reseals to the same bytes, on any
//   machine, in any order, with no clock anywhere in the result;
//   it is TAMPER-EVIDENT — one changed act fails verification, and the report
//   names which act rather than merely announcing that the numbers moved;
//   it is NEUTRAL UNDER REDACTION — a picture settles, its payload leaves, and
//   every root still checks. This is the property the whole design rests on;
//   it is ATTRIBUTABLE — a forged signature fails, and an internally consistent
//   forgery signed by another key is refused because the key changed.
//
// Plus the election's four rules, each as its own assertion, including the two
// identical hosts that once demoted into each other's mirrors.
//
// Every test runs offline against a temporary record. Nothing here fetches, and
// the election is exercised through an injected delivery so that "claims are
// checked, not believed" is a test rather than a comment about a code path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalBytes } from '../core/canonical.mjs';
import { EMPTY_ROOT, buildTree, orderedRootOf, positionalLeaf, verifyProof } from '../core/merkle.mjs';
import { replay } from '../core/replay.mjs';

import {
  GENESIS_PREV,
  blockHash,
  digestOf,
  packageOf,
  parseActLine,
  parseChain,
  payloadOf,
  serialiseChain,
  signBlock,
  signingBytes,
  structuralOf,
  walkLog,
} from '../server/chain/block.mjs';
import { buildChain } from '../server/chain/build.mjs';
import { verifyChain } from '../server/chain/verify.mjs';
import { createProducer, keyPaths, loadProducer, verifyBytes } from '../server/chain/keys.mjs';
import {
  ROLES,
  auditRecord,
  bareOrigin,
  compareRecords,
  decide,
  elect,
  hashesOf,
  isBlockedHost,
  rosterOrigins,
} from '../server/chain/election.mjs';

// ── one realistic record ───────────────────────────────────────────────────
//
// Three epochs, because three is the smallest number that exercises all of it:
// epoch 0 is a busy day that ends in emission, epoch 1 settles the picture and
// writes a tombstone, and epoch 2 is a day on which nothing happened at all. One
// act in epoch 0 is deliberately refused, so the "skipped acts are not committed"
// path is covered by the ordinary record rather than by a special one.

const T0 = 1786000000000;
const DAY = 86400000;
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const A = addr(0xa1);
const B = addr(0xb2);
const hex = (s) => createHash('sha256').update(s).digest('hex');

function makeLog(overrides = {}) {
  const acts = [];
  let i = 0;
  const push = (t, as, k, rest = {}) => {
    acts.push({ i: i++, t, as, k, ...rest, sig: '0x' + '1'.repeat(130) });
  };

  push(T0, A, 'register', { handle: 'ansel' });
  push(T0 + 1000, B, 'register', { handle: 'berenice' });
  // A burn amount as a canonical bigint and another as a plain decimal string:
  // core/replay.mjs accepts both on the wire, and the chain has to read both.
  push(T0 + 2000, A, 'burnClaim', { txid: hex('burn-a'), vout: 0, sat: 500000n });
  push(T0 + 3000, B, 'burnClaim', { txid: hex('burn-b'), vout: 0, sat: '500000' });
  push(T0 + 4000, A, 'swap', { sell: 'btc', amt: '200000', minOut: '0' });
  push(T0 + 5000, B, 'swap', { sell: 'btc', amt: '200000', minOut: '0' });
  push(T0 + 6000, A, 'capBuy', { ptp: 1000000000000000000n });
  push(T0 + 7000, B, 'capPledge', { mb: 1000, endpoint: 'https://node.example' });
  push(T0 + 8000, A, 'post', {
    cid: overrides.cid || hex('picture'),
    bytes: 2000000,
    mime: 'image/jpeg',
    w: 1200,
    h: 800,
    viewPriceNano: '100000',
    days: 1,
  });
  push(T0 + 9000, B, 'view', { pid: 'p1', dwellMs: overrides.dwellMs || 2000, seq: 1, vp: 80 });
  push(T0 + 10000, B, 'like', { pid: 'p1' });
  push(T0 + 11000, B, 'comment', { pid: 'p1', text: overrides.text || 'the light in this is the whole picture' });
  // Refused: one like per person per post, ever. It is in the log and it moved
  // nothing, so no block commits it.
  push(T0 + 11500, B, 'like', { pid: 'p1' });
  push(T0 + DAY, A, 'closeEpoch', {
    oracle: {
      sources: [90900000000000n, 91000000000000n, 91100000000000n, 90800000000000n, 91200000000000n],
    },
  });
  // The post lapsed a day after it was published; settlement opens an hour after
  // that and anybody may send it.
  push(T0 + DAY + 3700000, B, 'settle', { pid: 'p1' });
  push(T0 + 2 * DAY, A, 'closeEpoch', {});
  // Nothing between this close and the one before it: an empty epoch.
  push(T0 + 3 * DAY, A, 'closeEpoch', {});
  return acts;
}

const LOG = makeLog();

function logText(acts) {
  return acts.map((a) => canonicalBytes(a).toString('utf8')).join('\n') + '\n';
}

function newRecord(t, acts = LOG) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'acts.jsonl'), logText(acts), 'utf8');
  createProducer(dir);
  return dir;
}

const chainOf = (dir) => parseChain(readFileSync(path.join(dir, 'chain.json'), 'utf8'));
const rawChain = (dir) => readFileSync(path.join(dir, 'chain.json'), 'utf8');
const rewriteLog = (dir, acts) => writeFileSync(path.join(dir, 'acts.jsonl'), logText(acts), 'utf8');
const rewriteChain = (dir, blocks) => writeFileSync(path.join(dir, 'chain.json'), serialiseChain(blocks), 'utf8');
const codes = (r) => r.problems.map((p) => p.code);

// ── what the record contains ───────────────────────────────────────────────

test('the record seals three epochs: a busy one, a settlement, and a silent day', (t) => {
  const dir = newRecord(t);
  const report = buildChain({ dir });
  assert.equal(report.blocks, 3);
  assert.equal(report.added, 3);

  const chain = chainOf(dir);
  assert.deepEqual(chain.map((b) => b.epoch), [0, 1, 2]);
  assert.deepEqual(chain.map((b) => b.height), [0, 1, 2]);
  // The ranges tile the log with no gap and no overlap, so every act is inside
  // exactly one block's range.
  assert.deepEqual(chain.map((b) => [b.range.start, b.range.end]), [[0, 13], [14, 15], [16, 16]]);
  // Twelve accepted acts in epoch 0 out of thirteen: the duplicate like moved
  // nothing and is committed by nothing.
  assert.equal(chain[0].acts.length, 12);
  assert.equal(chain[0].package.epoch.skipped, 1);
  // The closing act is the seal and not the content; it is committed by the
  // block itself, whose `time` is that act's own stamp.
  assert.equal(chain[0].time, T0 + DAY);
  assert.equal(chain[1].acts.length, 1);
  assert.equal(chain[1].tombstones.length, 1);

  // The state the chain seals is the state the one rulebook computes, not a near
  // neighbour of it.
  const stub = { epoch: 0, time: 0, burnedWei: 0n, emittedWei: 0n, entries: [], skipped: 0 };
  const walked = walkLog(LOG, () => {});
  assert.equal(digestOf(packageOf(walked.world, stub)), digestOf(packageOf(replay(LOG), stub)));

  // Emission happened, and it is the epoch's own quantity rather than a running
  // total: the busy epoch minted, the silent one did not.
  assert.ok(chain[0].package.epoch.emittedWei > 0n);
  assert.ok(chain[0].package.epoch.burnedWei > 0n);
  assert.equal(chain[2].package.epoch.emittedWei, 0n);
  assert.equal(chain[2].package.epoch.burnedWei, 0n);
});

test('every root is the root of its own list, and one act proves against it', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const [block] = chainOf(dir);

  // orderedRootOf, not rootOf: pair-sorting makes a plain merkle root commit to
  // the MULTISET of leaves, so swapping two acts left it unchanged — while replay
  // is order-dependent all the way down. The position is folded into each leaf.
  assert.equal(block.actsRoot, orderedRootOf(block.acts));
  assert.equal(block.payloadsRoot, orderedRootOf(block.payloads));

  // And the ordering is really committed now, which is the point of the change.
  if (block.acts.length > 1) {
    const swapped = block.acts.slice();
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.notEqual(orderedRootOf(swapped), block.actsRoot);
  }
  assert.equal(block.stateRoot, digestOf(block.package));
  assert.equal(block.prev, GENESIS_PREV);

  // A member can prove their own act was in the sealed set without holding the
  // set: the leaf, the siblings, the root.
  const post = LOG[8];
  const index = block.acts.indexOf(structuralOf(post));
  assert.notEqual(index, -1);
  const tree = buildTree(block.acts.map((h, i) => positionalLeaf(i, h)));
  assert.equal(tree.root, block.actsRoot);

  // What is proved is the POSITIONAL leaf, and that is a stronger claim than
  // the old one: not merely "this act was in the sealed set" but "this act was
  // act number `index` of it". The position is inside the preimage, so a proof
  // cannot be replayed at another slot.
  assert.equal(verifyProof(positionalLeaf(index, block.acts[index]), tree.proofOf(index), block.actsRoot), true);

  // The bare content digest no longer proves, which is exactly the ordering
  // defect being closed rather than a regression.
  assert.equal(verifyProof(block.acts[index], tree.proofOf(index), block.actsRoot), false);

  // A tampered act does not prove, at its own position or any other.
  const tampered = structuralOf({ ...post, w: 1201 });
  assert.equal(verifyProof(positionalLeaf(index, tampered), tree.proofOf(index), block.actsRoot), false);
  // Nor does the real act moved one slot along.
  assert.equal(verifyProof(positionalLeaf(index + 1, block.acts[index]), tree.proofOf(index), block.actsRoot), false);
});

test('an empty epoch seals EMPTY_ROOT and verifies', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const silent = chainOf(dir)[2];

  assert.deepEqual(silent.acts, []);
  assert.deepEqual(silent.payloads, []);
  // Not a leaf digest, not an interior node digest, and not reachable from any
  // act: the sentinel says "this epoch committed nothing" and nothing else.
  assert.equal(silent.actsRoot, EMPTY_ROOT);
  assert.equal(silent.payloadsRoot, EMPTY_ROOT);
  assert.equal(silent.prev, blockHash(chainOf(dir)[1]));

  const r = verifyChain({ dir });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.blocks, 3);
  assert.equal(r.checked, 3);
});

test('an empty record is a valid record of nothing', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = verifyChain({ dir });
  assert.equal(r.ok, true);
  assert.equal(r.blocks, 0);
  assert.equal(r.acts, 0);
  // A fresh fork is invited rather than broken.
  const built = buildChain({ dir });
  assert.equal(built.blocks, 0);
  assert.equal(verifyChain({ dir }).ok, true);
});

test('the canonical sigil survives the round trip through a file', () => {
  // A log line and a block are canonical JSON, and canonical JSON writes a bigint
  // as a string with a leading "~" and gives any string that already starts with
  // one an extra. A reader that does not decode that cannot read the record: it
  // would turn every wei quantity into a string and re-encode it with a second
  // sigil, moving every hash downstream.
  const act = {
    i: 3,
    t: T0,
    as: B,
    k: 'comment',
    pid: 'p1',
    text: '~1000 is not a number, it is a sentence about one',
    sat: 500000n,
    nested: { '~key': ['~~also a string', -7n, 0n, true, null, 1.5] },
  };
  const line = canonicalBytes(act).toString('utf8');
  const back = parseActLine(line);
  assert.deepEqual(back, act);
  assert.equal(canonicalBytes(back).toString('utf8'), line);
  assert.equal(structuralOf(back), structuralOf(act));
  // A key is always a string, so a single sigil in one is not something the
  // encoder can emit — reviving it as a bigint would put a number in a property
  // position and quietly rename the field.
  assert.throws(() => parseActLine('{"~123":1}'), /malformed sigil in key/);
  assert.throws(() => parseActLine('{"a":"~not-a-number"}'), /malformed sigil/);
});

test('the published archive verifies with no host and no key', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });

  // What .github/workflows/archive.yml stages: the chain as a host served it,
  // the act log as lines, and nothing else — no producer key, no per-block
  // files, no machine of ours. The document it writes is a single-line JSON
  // array rather than the builder's one-block-per-line form, so the reader has
  // to be tolerant of formatting while the writer stays canonical.
  const archive = mkdtempSync(path.join(os.tmpdir(), 'ptp-archive-'));
  t.after(() => rmSync(archive, { recursive: true, force: true }));
  const served = { ok: true, blocks: JSON.parse(rawChain(dir)) };
  writeFileSync(path.join(archive, 'chain.json'), JSON.stringify(served.blocks) + '\n', 'utf8');
  writeFileSync(path.join(archive, 'acts.jsonl'), readFileSync(path.join(dir, 'acts.jsonl'), 'utf8'), 'utf8');

  const r = verifyChain({ dir: archive });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.blocks, 3);
  assert.equal(r.checked, 3);
  // With no key pinned beside it, the record is held to the producer it names in
  // its own first block, which is still enough to catch a key changing midway.
  assert.equal(r.producer, chainOf(dir)[0].producer);

  // A record that fails verification is never published: stale is honest, wrong
  // is poison. One act edited in the archive is enough to stop it.
  writeFileSync(path.join(archive, 'acts.jsonl'), logText(makeLog({ dwellMs: 1800 })), 'utf8');
  assert.equal(verifyChain({ dir: archive }).ok, false);
});

// ── determinism ────────────────────────────────────────────────────────────

test('a rebuild is byte-identical, and a second build changes nothing', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const first = rawChain(dir);

  const again = buildChain({ dir });
  assert.equal(again.added, 0);
  assert.equal(again.kept, 3);
  assert.equal(again.changed, false);
  assert.equal(rawChain(dir), first);

  const rebuilt = buildChain({ dir, rebuild: true });
  assert.equal(rebuilt.resealed, 3);
  assert.equal(rebuilt.changed, false);
  assert.equal(rawChain(dir), first, 'a rebuild that changes bytes is a rebuild that changes history');

  // Nothing in a block is read from a clock: `time` is the closing act's own
  // stamp, so a record sealed a year later seals the same bytes.
  assert.equal(chainOf(dir)[0].time, T0 + DAY);
});

test('the chain is also one file per block, for the two parts that read it that way', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const chain = chainOf(dir);
  const home = path.join(dir, 'chain');

  // server/index.mjs serves /api/chain by sorting the .json files in this
  // directory BY NAME, so the names are padded: sorted as strings and sorted as
  // numbers have to give the same order, or block 10 lands between 1 and 2.
  const names = readdirSync(home).filter((n) => n.endsWith('.json'));
  assert.deepEqual(names.sort(), ['00000000.json', '00000001.json', '00000002.json', 'head.json']);
  assert.deepEqual([...names].sort(), names.sort());

  // Byte-identical to the authority, block for block.
  const blocks = names
    .filter((n) => n !== 'head.json')
    .map((n) => parseChain('[' + readFileSync(path.join(home, n), 'utf8') + ']')[0]);
  for (let h = 0; h < 3; h++) assert.equal(blockHash(blocks[h]), blockHash(chain[h]));

  // The head is the top block itself, so the two paths that host takes — the
  // head file, or the highest-numbered block when there is none — agree.
  const head = parseChain('[' + readFileSync(path.join(home, 'head.json'), 'utf8') + ']')[0];
  assert.equal(blockHash(head), blockHash(chain[2]));
  assert.equal(head.height, 2);
  assert.equal(head.epoch, 2);

  // The producer key sits in the same directory and is not a .json file, which
  // is what keeps it out of both the served chain and the published archive.
  assert.ok(readdirSync(home).includes('producer.key'));
  assert.equal(names.some((n) => n.includes('key')), false);

  // Nothing verifies against the projection: it is a convenience, and the
  // authority is the file the verifier reads.
  writeFileSync(path.join(home, '00000001.json'), '{"height":1}\n', 'utf8');
  assert.equal(verifyChain({ dir }).ok, true);
  buildChain({ dir });
  assert.equal(blockHash(parseChain('[' + readFileSync(path.join(home, '00000001.json'), 'utf8') + ']')[0]), blockHash(chain[1]));
});

test('two machines that share no key seal the same state', (t) => {
  const one = newRecord(t);
  const two = newRecord(t);
  buildChain({ dir: one });
  buildChain({ dir: two });

  const a = chainOf(one);
  const b = chainOf(two);
  assert.notEqual(a[0].producer, b[0].producer, 'the two records are signed by different keys');
  for (let h = 0; h < 3; h++) {
    assert.equal(a[h].stateRoot, b[h].stateRoot);
    assert.equal(a[h].actsRoot, b[h].actsRoot);
    assert.equal(a[h].payloadsRoot, b[h].payloadsRoot);
    assert.equal(digestOf(a[h].package), digestOf(b[h].package));
  }
  // Publication is attributable; the state is not a matter of opinion. Two
  // verifiers either match bits or can attribute the difference.
  assert.notEqual(blockHash(a[0]), blockHash(b[0]));
});

// ── tamper evidence ────────────────────────────────────────────────────────

test('one changed act fails verification, and the report names the act', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  assert.equal(verifyChain({ dir }).ok, true);

  // The view still qualifies as billable, so it is still accepted and still
  // costs the same. Only the act itself is different.
  rewriteLog(dir, makeLog({ dwellMs: 1800 }));
  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['ACT_MISMATCH']);
  const [problem] = r.problems;
  assert.equal(problem.height, 0);
  assert.equal(problem.detail.logIndex, 9);
  assert.equal(problem.detail.kind, 'view');
  assert.equal(problem.detail.as, B);
  assert.match(problem.message, /log index 9 is a "view"/);
  assert.equal(problem.detail.derived, structuralOf(makeLog({ dwellMs: 1800 })[9]));
  assert.equal(problem.detail.sealed, structuralOf(LOG[9]));
});

test('an inserted line moves no root and is caught by the range', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });

  // An act replay refuses: no account, so nothing moves and no root changes.
  // What changes is where every act after it sits in the log.
  const spliced = [...LOG];
  spliced.splice(12, 0, { i: 11, t: T0 + 11400, as: addr(0xcc), k: 'view', pid: 'p1', dwellMs: 2000, seq: 1 });
  rewriteLog(dir, spliced);

  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].code, 'BLOCK_MISMATCH');
  assert.equal(r.problems[0].detail.field, 'range');
});

test('a rewritten block is caught against itself, before the log is consulted', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const chain = chainOf(dir);
  // The state root edited to say the epoch ended somewhere else.
  chain[1] = { ...chain[1], stateRoot: 'f'.repeat(64) };
  rewriteChain(dir, chain);

  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('STATE_ROOT_MISMATCH'));
  // And the signature no longer covers what the block says.
  assert.ok(codes(r).includes('BAD_SIGNATURE'));
});

test('a block crafted to be unencodable is refused, not thrown', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });

  // Canonical encoding refuses a structure nested past the published bound, and
  // a chain document can arrive from a stranger. A verifier that crashed on it
  // would be a verifier an attacker can stop, so this is a refusal like any
  // other — and the block after it is still checked.
  const raw = JSON.parse(rawChain(dir));
  let deep = 'leaf';
  for (let k = 0; k < 70; k++) deep = [deep];
  raw[0].package = deep;
  writeFileSync(path.join(dir, 'chain.json'), JSON.stringify(raw), 'utf8');

  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].code, 'BLOCK_MALFORMED');
  assert.match(r.problems[0].message, /nested deeper than 64/);

  // The same bytes offered by a peer are not a record either.
  const audit = auditRecord({ origin: 'https://b.example', chain: parseChain(JSON.stringify(raw)), acts: 17, claim: {} });
  assert.equal(audit.verified, false);
  assert.match(audit.problems[0], /cannot be read/);
});

test('a fork is refused rather than repaired', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  rewriteLog(dir, makeLog({ dwellMs: 1800 }));

  assert.throws(() => buildChain({ dir }), /CHAIN_FORK.*block 0 \(epoch 0\)/s);
  // --rebuild is not a way around it. Rewriting a published block is the event
  // this layer exists to make visible.
  assert.throws(() => buildChain({ dir, rebuild: true }), /CHAIN_FORK/);
  // The sealed chain is left exactly as it was.
  assert.equal(chainOf(dir).length, 3);
  assert.equal(verifyChain({ dir }).problems[0].code, 'ACT_MISMATCH');
});

test('a chain ahead of its log fails; a log ahead of its chain only warns', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });

  // The last close removed: block 2 now describes a close the log cannot produce.
  rewriteLog(dir, LOG.slice(0, 16));
  const short = verifyChain({ dir });
  assert.equal(short.ok, false);
  assert.ok(codes(short).includes('CHAIN_AHEAD_OF_LOG'));
  assert.throws(() => buildChain({ dir }), /CHAIN_AHEAD_OF_LOG/);

  // The other direction is the ordinary state of a record fetched between a
  // close and the next build.
  const ahead = newRecord(t, LOG.slice(0, 16));
  buildChain({ dir: ahead });
  rewriteLog(ahead, LOG);
  const late = verifyChain({ dir: ahead });
  assert.equal(late.ok, true);
  assert.deepEqual(late.warnings.map((w) => w.code), ['LOG_AHEAD_OF_CHAIN']);
});

// ── redaction neutrality ───────────────────────────────────────────────────

test('redaction neutrality: the picture settles and every root still checks', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const chain = chainOf(dir);

  // The settlement really happened: the post is redacted, the creator was paid,
  // and the tombstone carries what survives deletion.
  const settled = chain[1].package.posts[0];
  assert.equal(settled.state, 'settled');
  assert.equal(settled.redacted, true);
  assert.ok(settled.paidWei > 0n);
  const [tomb] = chain[1].tombstones;
  assert.equal(tomb.pid, 'p1');
  assert.equal(tomb.cid, hex('picture'));
  assert.equal(tomb.author, A);
  assert.equal(tomb.bytes, 2000000);
  assert.equal(tomb.views, 1);
  assert.equal(tomb.likes, 1);
  assert.equal(tomb.comments, 1);
  assert.ok(tomb.grossNano > 0n);

  // Every root still checks after the settlement, which is the whole claim.
  const r = verifyChain({ dir });
  assert.equal(r.ok, true, JSON.stringify(r.problems));

  // And the mechanism underneath it, checked directly rather than inferred: the
  // structural commitment never covered the payload, so stripping the payload
  // off every act reproduces the same digests and the same root.
  const stripped = LOG.map((act) => {
    const copy = { ...act };
    delete copy.cid;
    delete copy.text;
    return copy;
  });
  for (let k = 0; k < LOG.length; k++) {
    assert.equal(structuralOf(stripped[k]), structuralOf(LOG[k]));
  }
  const committed = [8, 9, 10, 11].map((k) => structuralOf(stripped[k]));
  for (const digest of committed) assert.ok(chain[0].acts.includes(digest));
  assert.equal(orderedRootOf(chain[0].acts), chain[0].actsRoot);

  // The payload commitment is the other half: sealed at close and simply KEPT.
  // It is recomputable while the payload survives and not afterwards, which is
  // exactly what a residue is.
  assert.equal(payloadOf(LOG[8]), chain[0].payloads[chain[0].acts.indexOf(structuralOf(LOG[8]))]);
  assert.notEqual(payloadOf(stripped[8]), payloadOf(LOG[8]));
});

test('the state root does not depend on the payload, and the payload root does', (t) => {
  const one = newRecord(t);
  const two = newRecord(t, makeLog({ cid: hex('a different picture entirely') }));
  buildChain({ dir: one });
  buildChain({ dir: two });
  const a = chainOf(one)[0];
  const b = chainOf(two)[0];

  // Two different pictures, published identically, priced identically, looked at
  // identically. Every euro that moved is the same, so the economic state is the
  // same and the structural commitment is the same.
  assert.equal(a.stateRoot, b.stateRoot);
  assert.equal(a.actsRoot, b.actsRoot);
  // Which bytes existed is committed in exactly one place.
  assert.notEqual(a.payloadsRoot, b.payloadsRoot);
});

test('editing a comment moves the payload commitment and nothing else', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const before = chainOf(dir)[0];

  rewriteLog(dir, makeLog({ text: 'a different sentence, the same fee' }));
  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].code, 'PAYLOAD_MISMATCH');
  assert.equal(r.problems[0].detail.logIndex, 11);

  // The structure and the money are untouched: the comment cost what it cost.
  const after = chainOf(dir)[0];
  assert.equal(after.actsRoot, before.actsRoot);
  assert.equal(after.stateRoot, before.stateRoot);
});

// ── attribution ────────────────────────────────────────────────────────────

test('a chain that changes network midway is two chains in one file', (t) => {
  const dir = newRecord(t);
  buildChain({ dir, net: 'ptp-test' });
  // A record is verified on its own terms — a verifier holds a record, not an
  // opinion about which network it belongs to — so a consistent test net checks
  // out exactly like the main one.
  assert.equal(chainOf(dir)[0].net, 'ptp-test');
  assert.equal(verifyChain({ dir }).ok, true);

  const chain = chainOf(dir);
  chain[2] = signBlock({ ...chain[2], net: 'ptp' }, loadProducer(dir));
  rewriteChain(dir, chain);
  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('NET_CHANGED'));
});

test('a forged signature fails', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const chain = chainOf(dir);

  const sig = chain[1].sig;
  chain[1] = { ...chain[1], sig: (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1) };
  rewriteChain(dir, chain);

  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].code, 'BAD_SIGNATURE');
  assert.equal(r.problems[0].height, 1);
});

test('an internally consistent forgery is refused because the key changed', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const chain = chainOf(dir);

  // A forger with their own key, rewriting a block and signing it properly. On
  // its own terms it verifies: the signature checks against the key it names.
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'ptp-forge-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const forger = createProducer(elsewhere);
  chain[1] = signBlock({ ...chain[1], time: chain[1].time + 1 }, forger);
  rewriteChain(dir, chain);

  const r = verifyChain({ dir });
  assert.equal(r.ok, false);
  const seen = codes(r);
  // The block does not reproduce from the log AND it was published by somebody
  // else. Either alone is enough; both are reported, because they are different
  // facts about the same block.
  assert.ok(seen.includes('BLOCK_MISMATCH'));
  assert.ok(seen.includes('PRODUCER_CHANGED'));
  // The forged signature is genuinely valid over the block it was made for. The
  // refusal is not a lucky side effect of a broken hash — nothing about this
  // block is broken except who published it.
  assert.equal(verifyBytes(forger.publicHex, signingBytes(chain[1]), chain[1].sig), true);
  assert.equal(r.problems.find((p) => p.code === 'BAD_SIGNATURE'), undefined);
});

test('the producer key is generated once, kept private, and never re-created', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptp-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(loadProducer(dir), null);
  const signer = createProducer(dir);
  assert.match(signer.publicHex, /^[0-9a-f]{64}$/);
  // It signs and it does exactly that: there is no accessor for the private half
  // anywhere on the object a caller holds.
  assert.deepEqual(Object.keys(signer).sort(), ['file', 'publicHex', 'sign']);
  assert.equal(loadProducer(dir).publicHex, signer.publicHex);
  // Ed25519 is deterministic, which is what makes a rebuild byte-identical.
  const bytes = Buffer.from('one epoch, sealed');
  assert.equal(signer.sign(bytes), loadProducer(dir).sign(bytes));
  assert.equal(verifyBytes(signer.publicHex, bytes, signer.sign(bytes)), true);
  assert.equal(verifyBytes(signer.publicHex, Buffer.from('a different epoch'), signer.sign(bytes)), false);
  // A second generation would orphan every block already signed.
  assert.throws(() => createProducer(dir), /EEXIST/);
  // The private half is on disk and is not the public half.
  const paths = keyPaths(dir);
  assert.match(readFileSync(paths.private, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(readFileSync(paths.public, 'utf8').trim(), signer.publicHex);
});

// ── the election ───────────────────────────────────────────────────────────

const host = (origin, height, logLength, extra = {}) => ({
  origin,
  height,
  logLength,
  hashes: Array.from({ length: height }, (_, i) => hex(`block-${i}`)),
  ...extra,
});

const peer = (origin, height, logLength, extra = {}) => ({
  origin,
  height,
  logLength,
  liveAt: 1000,
  role: ROLES.writer,
  follows: null,
  verified: true,
  hashes: Array.from({ length: height }, (_, i) => hex(`block-${i}`)),
  ...extra,
});

test('rule 1: silence is not a mandate', () => {
  // A host that has heard from no peer since it started does not write. The bug
  // this closes is a watchdog restarting a stale host inside a partition and
  // handing the isolated side a second pen.
  const booting = decide({ self: host('https://a.example', 9, 400, { quarantined: true }), peers: [] });
  assert.equal(booting.role, ROLES.waiting);
  assert.equal(booting.code, 'NO_PEER_HEARD');
  assert.equal(booting.follow, null);

  // Quarantine lifts on a successful probe round and never on a failed one.
  const failedRound = decide({
    self: host('https://a.example', 9, 400, { quarantined: true }),
    peers: [peer('https://b.example', 12, 900, { verified: false })],
  });
  assert.equal(failedRound.role, ROLES.waiting);
  assert.equal(failedRound.code, 'NO_PEER_HEARD');

  // A host already seated keeps the pen through a partition: that is CAP, and it
  // is one writer per side rather than none.
  const seated = decide({
    self: host('https://a.example', 9, 400, { quarantined: false, incumbent: true }),
    peers: [],
  });
  assert.equal(seated.role, ROLES.writer);
  assert.equal(seated.code, 'PARTITIONED_INCUMBENT');

  // A genuine last host standing is promoted by hand, and says so.
  const promoted = decide({
    self: host('https://a.example', 9, 400, { quarantined: true, promoted: true }),
    peers: [],
  });
  assert.equal(promoted.role, ROLES.writer);
  assert.equal(promoted.code, 'PROMOTED_BY_OPERATOR');
});

test('rule 2: an incumbent yields only to a strictly longer record', () => {
  const me = host('https://a.example', 9, 400, { quarantined: false, incumbent: true });

  // Equal on both published fields: the pen stays exactly where it is.
  assert.equal(decide({ self: me, peers: [peer('https://b.example', 9, 400)] }).code, 'INCUMBENT_HOLDS');
  // Longer log at the same sealed height: strictly longer.
  assert.equal(decide({ self: me, peers: [peer('https://b.example', 9, 401)] }).code, 'YIELD_TO_LONGER');
  // Higher sealed chain wins over a longer log, because a sealed block is a
  // stronger statement than an unsealed act.
  assert.equal(decide({ self: me, peers: [peer('https://b.example', 10, 1)] }).code, 'YIELD_TO_LONGER');
  assert.equal(decide({ self: me, peers: [peer('https://b.example', 8, 9000)] }).code, 'INCUMBENT_HOLDS');

  const yielded = decide({ self: me, peers: [peer('https://b.example', 12, 900)] });
  assert.equal(yielded.role, ROLES.mirror);
  assert.equal(yielded.follow, 'https://b.example');

  // The boot half of the same rule uses a different threshold on purpose: a host
  // still in quarantine yields to any live writer at least as long.
  const booting = host('https://a.example', 9, 400, { quarantined: true });
  const equal = decide({ self: booting, peers: [peer('https://b.example', 9, 400)] });
  assert.equal(equal.role, ROLES.mirror);
  assert.equal(equal.code, 'YIELD_TO_SEATED_WRITER');
});

test('rule 2, the case that produced it: two identical hosts elect exactly one', () => {
  // Both booting, both reachable, both records identical to the byte. Under a
  // single ">=" threshold each yielded to the other and the network had no
  // writer at all. The published order decides, and both sides compute it.
  const a = host('https://a.example', 4, 120, { quarantined: true });
  const b = host('https://b.example', 4, 120, { quarantined: true });
  const asA = decide({ self: a, peers: [peer('https://b.example', 4, 120, { role: ROLES.waiting })] });
  const asB = decide({ self: b, peers: [peer('https://a.example', 4, 120, { role: ROLES.waiting })] });

  assert.equal(asA.role, ROLES.writer);
  assert.equal(asA.code, 'QUARANTINE_LIFTED');
  assert.equal(asB.role, ROLES.mirror);
  assert.equal(asB.follow, 'https://a.example');
  assert.equal([asA.role, asB.role].filter((r) => r === ROLES.writer).length, 1);

  // And the round after: A is seated, B follows it, and nothing oscillates.
  const settledA = decide({
    self: host('https://a.example', 4, 120, { quarantined: false, incumbent: true }),
    peers: [peer('https://b.example', 4, 120, { role: ROLES.mirror, follows: 'https://a.example' })],
  });
  assert.equal(settledA.code, 'INCUMBENT_HOLDS');
  const settledB = decide({
    self: host('https://b.example', 4, 120, { quarantined: true }),
    peers: [peer('https://a.example', 4, 120, { role: ROLES.writer })],
  });
  assert.equal(settledB.follow, 'https://a.example');
});

test('rule 3: never follow someone who follows you', () => {
  // A peer that mirrors us is not a writer, however long its record claims to be.
  // Without this, a restored-from-backup primary and its mirror seated each
  // other forever.
  const mutual = decide({
    self: host('https://a.example', 9, 400, { quarantined: false, incumbent: true }),
    peers: [peer('https://b.example', 99, 9999, { role: ROLES.mirror, follows: 'https://a.example' })],
  });
  assert.equal(mutual.role, ROLES.writer);
  assert.equal(mutual.code, 'INCUMBENT_HOLDS');

  // Even at boot, where the threshold is weaker, a peer that follows us is not
  // somewhere to hand a pen. It IS evidence that this host is not alone, though,
  // so the probe round succeeded and the quarantine lifts: a primary whose mirror
  // answers should write. Answering and being a candidate are different facts.
  const booting = decide({
    self: host('https://a.example', 9, 400, { quarantined: true }),
    peers: [peer('https://b.example', 99, 9999, { follows: 'https://a.example/' })],
  });
  assert.equal(booting.role, ROLES.writer);
  assert.equal(booting.code, 'QUARANTINE_LIFTED');

  // The degenerate case: a host reading its own entry out of a roster and
  // seating itself as its own mirror.
  const itself = decide({
    self: host('https://a.example', 9, 400, { quarantined: true }),
    peers: [peer('https://a.example', 99, 9999)],
  });
  assert.equal(itself.follow, null);
  assert.deepEqual(rosterOrigins(['https://a.example/status.json', 'https://a.example'], 'https://a.example'), []);
});

test('rule 4: claims are checked, not believed', async (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const delivered = chainOf(dir);

  // This host holds the same record the peer will deliver, so the only thing
  // under test is whether a claim is believed.
  const mine = hashesOf(delivered);
  const me = { origin: 'https://a.example', height: 3, logLength: 17, hashes: mine, quarantined: false, incumbent: true };
  const roster = ['https://b.example/api/chain', 'https://c.example'];

  // b advertises a record twice as long as it can produce. Nobody can produce a
  // million acts on demand, and the advertisement alone moves nothing.
  const liar = async (origin) => {
    if (origin === 'https://b.example') {
      return { origin, chain: delivered, acts: 17, claim: { height: 99, logLength: 999999, role: ROLES.writer } };
    }
    throw new Error('ECONNREFUSED');
  };
  const lied = await elect({ self: me, roster, deps: { fetchRecord: liar } });
  assert.equal(lied.role, ROLES.writer);
  assert.equal(lied.heard, 0);
  assert.equal(lied.probed, 2);
  assert.match(lied.unreachable[0].why, /claimed 99 blocks and delivered 3/);

  // The same peer telling the truth about what it delivers is believed, and it
  // holds a strictly longer record only when it actually delivers one.
  const honest = async (origin) => ({
    origin,
    chain: delivered,
    acts: 17,
    claim: { height: 3, logLength: 17, role: ROLES.writer, liveAt: 5 },
  });
  const truthful = await elect({ self: me, roster: ['https://b.example'], deps: { fetchRecord: honest } });
  assert.equal(truthful.heard, 1);
  assert.equal(truthful.role, ROLES.writer, 'an equal record does not move an incumbent');

  const behind = { ...me, logLength: 16 };
  const overtaken = await elect({ self: behind, roster: ['https://b.example'], deps: { fetchRecord: honest } });
  assert.equal(overtaken.role, ROLES.mirror);
  assert.equal(overtaken.follow, 'https://b.example');

  // A delivered chain that does not link, or is not signed by the key it names,
  // is not a record at all.
  const broken = [...delivered];
  broken[1] = { ...broken[1], prev: 'e'.repeat(64) };
  const bent = await elect({
    self: me,
    roster: ['https://b.example'],
    deps: {
      fetchRecord: async (origin) => ({ origin, chain: broken, acts: 17, claim: { height: 3, logLength: 17 } }),
    },
  });
  assert.equal(bent.heard, 0);
  assert.match(bent.unreachable[0].why, /block 1 does not link/);

  const unsigned = [...delivered];
  unsigned[2] = { ...unsigned[2], sig: 'a'.repeat(128) };
  const audit = auditRecord({ origin: 'https://b.example', chain: unsigned, acts: 17, claim: {} });
  assert.equal(audit.verified, false);
  assert.match(audit.problems[0], /block 2 is not signed/);
});

test('addresses out of a roster are stripped to bare origins and never point inward', () => {
  // A roster arrives over the network and is fed to a fetch. Untrusted input.
  assert.equal(bareOrigin('https://mirror.example/api/chain?x=1#f'), 'https://mirror.example');
  assert.equal(bareOrigin('https://user:pass@mirror.example'), null);
  assert.equal(bareOrigin('file:///etc/passwd'), null);
  assert.equal(bareOrigin('not a url'), null);
  for (const inward of [
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://[::1]:3000',
    'http://10.1.2.3',
    'http://192.168.0.9',
    'http://172.16.5.5',
    'http://169.254.169.254',
    'http://100.64.0.1',
    'http://box.local',
    'http://metadata',
  ]) {
    assert.equal(bareOrigin(inward), null, inward);
  }
  assert.equal(isBlockedHost('mirror.example'), false);
  assert.equal(bareOrigin('https://mirror.example:8443/'), 'https://mirror.example:8443');
});

test('two signed histories freeze the host', (t) => {
  const dir = newRecord(t);
  buildChain({ dir });
  const mine = hashesOf(chainOf(dir));

  // A record that shares a prefix is a record one of us can adopt.
  assert.equal(compareRecords(mine, mine.slice(0, 2)), 'ahead');
  assert.equal(compareRecords(mine.slice(0, 2), mine), 'behind');
  assert.equal(compareRecords(mine, mine), 'same');

  // A record that diverges is not. Each has sealed a block the other does not
  // have, and no program may choose between two attributable records.
  const theirs = [...mine];
  theirs[2] = hex('another block at the same height');
  assert.equal(compareRecords(mine, theirs), 'forked');

  const frozen = decide({
    self: { origin: 'https://a.example', height: 3, logLength: 17, hashes: mine, quarantined: false, incumbent: true },
    peers: [peer('https://b.example', 3, 17, { hashes: theirs })],
  });
  assert.equal(frozen.role, ROLES.waiting);
  assert.equal(frozen.code, 'FORK_NEEDS_A_PERSON');
  assert.equal(frozen.follow, null);
});
