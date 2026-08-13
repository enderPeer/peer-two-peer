// The client, tested where it can be tested without a browser.
//
// Three things in app/ can cost a member money or lock them out of an account,
// and all three are testable as pure functions because they were written as pure
// functions:
//
//   the billable-view machine   decides whether looking at a picture was billed.
//                               Driven here with synthetic intersections, scroll
//                               samples and stamps, so a fling, a dwell, a
//                               cooldown and a per-pair cap are all reproducible
//                               without a viewport.
//   the signing body            decides whether an act is accepted at all. A
//                               canonical encoding that differs from the
//                               writer's by one byte recovers to a different
//                               address, and the refusal says nothing about
//                               which byte — so the encoder is checked against
//                               core/canonical.mjs for byte identity, and the
//                               curve arithmetic against OpenSSL through
//                               node:crypto.
//   the shard placement         decides which bytes this device owes the
//                               network. It has to agree with the server with
//                               nothing passing between them, so it is checked
//                               against core/placement.mjs directly — the same
//                               module server/capacity.mjs uses.
//
// The DOM half of app.mjs is not tested here and that is stated rather than
// implied: it needs a browser, and a fake one would test the fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PARAMS, NANO_EUR_PER_EUR } from '../core/params.mjs';
import { canonicalJson as coreCanonicalJson } from '../core/canonical.mjs';
import { actError, applyAct, emptyWorld, SHARD_BYTES, MAX_PAYLOAD_BYTES } from '../core/replay.mjs';
import { formatEur, priceOf, actionPriceNanoEur } from '../core/pricing.mjs';
import { placeShard, shardsOf, challengeFor, answerChallenge } from '../core/placement.mjs';

import {
  createViewMeter,
  createSession,
  parseEurToNano,
  parseUnits,
  formatUnits,
  publishReceipt,
  swapPreview,
  rankScore,
  feedOrder,
  checkAct,
  prepareAct,
  engagementPrice,
  MAX_TICK_GAP_MS,
} from '../app/app.mjs';
import {
  canonicalJson,
  signingBodyOf,
  signingMessage,
  keccak256,
  toHex,
  publicKeyOf,
  addressOfPrivateKey,
  signDigest,
  personalSign,
  recoverPersonalSign,
  createWallet,
  LOCAL_KEY_WARNING,
} from '../app/wallet.mjs';
import {
  createDataSpace,
  memoryBackend,
  shardPlanFor,
  shardRangeOf,
  connectionState,
} from '../app/storage.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

const MIN_PCT = Number(PARAMS.viewMinViewportPct);
const DWELL = Number(PARAMS.viewDwellMs);
const COOLDOWN = Number(PARAMS.viewCooldownSec) * 1000;

/** Advance the machine in steps small enough that no step looks like a tab that
 * stopped being watched, collecting whatever became billable. */
function drive(meter, from, to, step = 100, each) {
  const bills = [];
  for (let t = from; t <= to; t += step) {
    if (each) each(t);
    bills.push(...meter.tick(t));
  }
  return bills;
}

/** A look: on screen at `from`, still there at `to`. */
function look(meter, pid, from, to) {
  meter.intersect(pid, 100);
  return drive(meter, from, to);
}

const HEX = (n) => n.toString(16).padStart(64, '0');

function fixture() {
  const world = emptyWorld(PARAMS);
  const alice = '0x' + 'a'.repeat(40);
  const bob = '0x' + 'b'.repeat(40);
  let t = 1700000000000;
  const push = (act) => {
    const r = applyAct(world, { ...act, t: (t += 1000) });
    assert.equal(r.ok, true, `${act.k} was refused: ${r.code} ${r.detail ? JSON.stringify(r.detail) : ''}`);
    return r;
  };
  push({ k: 'register', as: alice, handle: 'alice' });
  push({ k: 'register', as: bob, handle: 'bob' });
  push({ k: 'burnClaim', as: alice, txid: HEX(1), vout: 0, sat: '400000' });
  push({ k: 'burnClaim', as: bob, txid: HEX(2), vout: 0, sat: '400000' });
  push({ k: 'swap', as: alice, sell: 'btc', amt: '200000', minOut: '0' });
  push({ k: 'swap', as: bob, sell: 'btc', amt: '200000', minOut: '0' });
  push({ k: 'capBuy', as: alice, ptp: (world.accounts[alice].ptp / 4n).toString() });
  return { world, alice, bob, at: () => t };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE BILLABLE VIEW
// ═══════════════════════════════════════════════════════════════════════════

test('a fling bills literally nothing, and the gate opens when the scroll settles', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  // 5000 px/s is four times the fling threshold on an 800 px viewport, and the
  // picture is fully on screen the whole time — the only thing stopping a bill
  // is the velocity gate.
  let y = 0;
  const flung = drive(meter, 0, 3000, 50, (t) => {
    meter.intersect('p1', 100);
    y += 250;
    meter.scroll(y, t);
  });
  assert.deepEqual(flung, [], 'a fast scroll billed something');

  // The thumb comes off. Nothing else changes: same picture, same share of the
  // screen, and now it bills exactly once.
  const settled = drive(meter, 3050, 3050 + DWELL * 3, 50);
  assert.equal(settled.length, 1, 'a settled scroll did not bill the dwell that followed');
  assert.equal(settled[0].pid, 'p1');
  assert.ok(settled[0].dwellMs >= DWELL, 'billed a dwell shorter than the parameter');
});

test('a genuine dwell bills exactly one, and only after the dwell has elapsed', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  const early = look(meter, 'p1', 0, DWELL - 200);
  assert.deepEqual(early, [], 'billed before the dwell elapsed');
  const bills = drive(meter, DWELL - 100, DWELL * 4, 100);
  assert.equal(bills.length, 1, 'one continuous look billed ' + bills.length + ' times');
  assert.equal(bills[0].vp, 100);
});

test('below the viewport share, no amount of time bills anything', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  meter.intersect('p1', MIN_PCT - 1);
  assert.deepEqual(drive(meter, 0, DWELL * 10, 100), [], 'billed a picture that was never big enough on screen');
  // One percent more and the same wait bills once.
  meter.intersect('p1', MIN_PCT);
  assert.equal(drive(meter, DWELL * 10, DWELL * 13, 100).length, 1);
});

test('a second view inside the cooldown bills zero', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  const first = look(meter, 'p1', 0, DWELL * 2);
  assert.equal(first.length, 1);

  // Look away, look back, wait the full dwell again — well inside the fifteen
  // minute cooldown.
  meter.intersect('p1', 0);
  meter.intersect('p1', 100);
  const second = drive(meter, DWELL * 2 + 100, DWELL * 6, 100);
  assert.deepEqual(second, [], 'billed a second impression inside the cooldown');

  // And past the cooldown it bills again, because the limit is a cooldown and
  // not a ban.
  let t = DWELL * 6 + COOLDOWN;
  meter.intersect('p1', 0);
  meter.tick(t); // one long step: the machine treats it as a discontinuity
  meter.intersect('p1', 100);
  const third = drive(meter, t + 100, t + DWELL * 3, 100);
  assert.equal(third.length, 1, 'refused to bill after the cooldown had passed');
});

test('the per-pair cap holds: twelve billable views in an epoch, and no thirteenth', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  let t = 0;
  let billed = 0;
  for (let i = 0; i < 20; i++) {
    meter.intersect('p1', 0);
    meter.tick(t); // the jump across the cooldown is a discontinuity, by design
    meter.intersect('p1', 100);
    billed += drive(meter, t + 100, t + DWELL * 2, 100).length;
    t += COOLDOWN + DWELL * 3;
  }
  assert.equal(billed, Number(PARAMS.maxViewsPerPairPerEpoch), 'the per-pair epoch cap did not hold');
  assert.equal(meter.blocked('p1', t), 'VIEW_PAIR_CAP');

  // The cap counts inside the epoch only. A close resets it, exactly as
  // core/replay.mjs does.
  meter.setEpoch(1);
  assert.equal(meter.blocked('p1', t), null, 'the cap survived an epoch close');
});

test('a tab nobody was watching does not bill the time it was hidden', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  meter.intersect('p1', 100);
  meter.tick(0);
  meter.tick(100);
  // The tab goes away for an hour and comes back with the picture still on
  // screen. Without the discontinuity guard this bills instantly.
  const bills = meter.tick(100 + 3600000);
  assert.deepEqual(bills, [], 'billed an hour of a hidden tab');
  assert.ok(3600000 > MAX_TICK_GAP_MS);
  assert.equal(drive(meter, 100 + 3600000 + 100, 100 + 3600000 + DWELL * 3, 100).length, 1);
});

test('blur restarts every dwell', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  meter.intersect('p1', 100);
  drive(meter, 0, DWELL - 200, 100);
  meter.blur(DWELL - 200);
  assert.deepEqual(drive(meter, DWELL - 100, DWELL + 100, 100), [], 'billed a dwell that was interrupted');
});

test('the dwell bar reaches one only when the impression is billable', () => {
  const meter = createViewMeter({ viewportPx: 800 });
  meter.intersect('p1', 100);
  meter.tick(0); // the dwell starts here
  meter.tick(100);
  assert.ok(meter.progress('p1', 100) < 0.2);
  assert.equal(meter.progress('p1', DWELL / 2), 0.5);
  assert.equal(meter.progress('p1', DWELL), 1);
  // And it is at zero for a picture that is not being billed at all.
  meter.intersect('p2', 10);
  assert.equal(meter.progress('p2', DWELL), 0);
});

test('the pair ledger is seeded from the world, so a cooldown survives a reload', () => {
  const { world, alice, bob } = fixture();
  const meter = createViewMeter();
  const at = 1700000100000;
  // A view act that landed in the log, applied by the rulebook itself.
  const post = publishFixturePost(world, alice, at);
  const view = prepareAct(world, bob, { k: 'view', pid: post, dwellMs: DWELL, seq: 0, vp: 100 }, at + 1000);
  assert.equal(applyAct(world, view).ok, true);
  meter.seed(world, bob);
  assert.equal(meter.blocked(post, at + 2000), 'VIEW_TOO_SOON');
  assert.equal(meter.blocked(post, at + 1000 + COOLDOWN), null);
  // Somebody else's ledger is not this viewer's.
  const other = createViewMeter();
  other.seed(world, alice);
  assert.equal(other.blocked(post, at + 2000), null);
});

function publishFixturePost(world, author, at) {
  const act = prepareAct(
    world,
    author,
    {
      k: 'post',
      cid: HEX(0xabc),
      bytes: 2000000,
      mime: 'image/jpeg',
      w: 1600,
      h: 2000,
      viewPriceNano: PARAMS.viewPriceDefaultNanoEur.toString(),
      days: 1,
    },
    at,
  );
  const r = applyAct(world, act);
  assert.equal(r.ok, true, 'the fixture post was refused: ' + r.code);
  return `p${world.seq.post}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE BODY THE WALLET SIGNS
// ═══════════════════════════════════════════════════════════════════════════

test('the client encodes an act exactly as core/canonical.mjs does', () => {
  const bodies = [
    { k: 'view', as: '0x' + '1'.repeat(40), t: 1700000000000, pid: 'p1', dwellMs: 1500, seq: 7, vp: 100 },
    { k: 'register', as: '0x' + '2'.repeat(40), t: 1, handle: 'ada_l' },
    { k: 'swap', as: '0x' + '3'.repeat(40), t: 2, sell: 'ptp', amt: '1000000000000000000', minOut: '0' },
    // The sigil case. A comment beginning with "~" is escaped by the encoder so
    // that a bigint and its own decimal string can never hash alike; a client
    // that skipped the escape would sign a different string than the writer
    // verifies, and the only symptom would be BAD_SIGNATURE.
    { k: 'comment', as: '0x' + '4'.repeat(40), t: 3, pid: 'p9', text: '~1000' },
    { k: 'comment', as: '0x' + '4'.repeat(40), t: 3, pid: 'p9', text: '~~ still a string' },
    { k: 'comment', as: '0x' + '4'.repeat(40), t: 3, pid: 'p9', text: 'quotes " and \\ and \n newline and é 😀' },
    { k: 'capProof', as: '0x' + '5'.repeat(40), t: 4, challenge: { pid: 'p2', shard: 3 }, answer: HEX(9) },
    { zeta: 1, alpha: 2, Beta: 3, _under: 4, '~sigil': 5 },
    { nested: { b: [1, 2, { c: 'x' }], a: null, t: true, f: false } },
    { big: 123456789012345678901234567890n },
  ];
  for (const body of bodies) {
    assert.equal(canonicalJson(body), coreCanonicalJson(body), 'diverged on ' + JSON.stringify(Object.keys(body)));
  }
});

test('the signed body is the act without sig and without i', () => {
  const act = { i: 42, t: 1, as: '0x' + '1'.repeat(40), k: 'like', pid: 'p1', sig: '0xdead' };
  const body = signingBodyOf(act);
  assert.deepEqual(Object.keys(body).sort(), ['as', 'k', 'pid', 't']);
  // The writer assigns `i` on acceptance, so signing it would make every act
  // unverifiable; `sig` cannot cover itself.
  assert.equal(signingMessage(act), coreCanonicalJson({ t: 1, as: act.as, k: 'like', pid: 'p1' }));
});

test('keccak256 matches its published vectors', () => {
  assert.equal(toHex(keccak256(new Uint8Array(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(
    toHex(keccak256(new TextEncoder().encode('abc'))),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  // Longer than one 136-byte block, so the absorb loop is exercised too.
  const long = new TextEncoder().encode('peer two peer '.repeat(40));
  assert.equal(keccak256(long).length, 32);
  assert.notEqual(toHex(keccak256(long)), toHex(keccak256(new Uint8Array(0))));
});

test('an address is derived exactly as Ethereum derives it', () => {
  // The two most-cited vectors: the addresses of the private keys 1 and 2.
  const one = new Uint8Array(32);
  one[31] = 1;
  const two = new Uint8Array(32);
  two[31] = 2;
  assert.equal(addressOfPrivateKey(one), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  assert.equal(addressOfPrivateKey(two), '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf');
});

test('the curve arithmetic agrees with OpenSSL, and OpenSSL verifies the signatures', async () => {
  for (let i = 0; i < 4; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const sec1 = privateKey.export({ type: 'sec1', format: 'der' });
    // SEC1: SEQUENCE { INTEGER(1) version, OCTET STRING(32) d, ... }
    //       30 <len> 02 01 01 04 20 <32 bytes>
    assert.equal(sec1[5], 0x04);
    assert.equal(sec1[6], 0x20);
    const d = new Uint8Array(sec1.subarray(7, 39));
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const point = spki.subarray(spki.length - 65); // 0x04 ‖ X ‖ Y

    assert.equal(toHex(publicKeyOf(d)), point.subarray(1).toString('hex'), 'the public point disagrees with OpenSSL');

    const message = Buffer.from('peer two peer act ' + i);
    const digest = createHash('sha256').update(message).digest();
    const { r, s } = await signDigest(d, new Uint8Array(digest));
    assert.equal(cryptoVerify('sha256', message, publicKey, derSig(r, s)), true, 'OpenSSL rejected the signature');
  }
});

function derInt(v) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let b = Buffer.from(hex, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}
function derSig(r, s) {
  const a = derInt(r);
  const b = derInt(s);
  return Buffer.concat([Buffer.from([0x30, a.length + b.length]), a, b]);
}

test('personal_sign round-trips to the signing address, and one byte breaks it', async () => {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  priv[0] = 1; // keep it comfortably inside the order
  const address = addressOfPrivateKey(priv);
  const act = { t: 1700000000000, as: address, k: 'like', pid: 'p1' };
  const message = signingMessage(act);
  const sig = await personalSign(priv, message);
  assert.equal(recoverPersonalSign(message, sig), address);

  // The same signature over a body that differs anywhere recovers to somebody
  // else, which is exactly what BAD_SIGNATURE means and why the encoding has to
  // match the writer's byte for byte.
  const tampered = signingMessage({ ...act, pid: 'p2' });
  assert.notEqual(recoverPersonalSign(tampered, sig), address);
});

test('the wallet signs the canonical body and verifies its own signature', async () => {
  const store = memoryKeyStore();
  const wallet = createWallet({ provider: null, store });
  const address = await wallet.createLocal();
  assert.match(address, /^0x[0-9a-f]{40}$/);
  const signed = await wallet.signAct({ k: 'like', pid: 'p1', t: 1700000000000, as: address });
  assert.equal(signed.as, address);
  assert.equal(recoverPersonalSign(signingMessage(signed), signed.sig), address);
  // The stored key is the one that signs, across a reload.
  const again = createWallet({ provider: null, store });
  assert.equal(await again.loadLocal(), address);

  // The warning is a constant so that it cannot drift away from the choice it
  // belongs to, and it says the one thing that matters.
  assert.ok(LOCAL_KEY_WARNING.some((line) => /nobody can restore it/i.test(line)));
  await wallet.forgetLocal();
  assert.equal(await again.loadLocal(), null);
});

function memoryKeyStore() {
  let row = null;
  return {
    async load() {
      return row;
    },
    async save(r) {
      row = r;
    },
    async clear() {
      row = null;
    },
  };
}

test('an injected provider is used through EIP-1193 and never asked for a key', async () => {
  const priv = new Uint8Array(32);
  priv[31] = 9;
  const address = addressOfPrivateKey(priv);
  const seen = [];
  const provider = {
    async request({ method, params }) {
      seen.push(method);
      if (method === 'eth_requestAccounts') return [address.toUpperCase().replace('0X', '0x')];
      if (method === 'personal_sign') {
        const message = new TextDecoder().decode(Buffer.from(params[0].slice(2), 'hex'));
        return personalSign(priv, message);
      }
      throw new Error('unexpected method ' + method);
    },
  };
  const wallet = createWallet({ provider, store: null });
  assert.equal(await wallet.connectInjected(), address);
  const signed = await wallet.signAct({ k: 'like', pid: 'p1', t: 1 });
  assert.equal(recoverPersonalSign(signingMessage(signed), signed.sig), address);
  assert.deepEqual(seen, ['eth_requestAccounts', 'personal_sign']);
  // Nothing that could produce a key was ever asked for.
  assert.ok(!seen.some((m) => /private|seed|mnemonic|export/i.test(m)));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. STORAGE: THE SAME PLACEMENT THE SERVER COMPUTES
// ═══════════════════════════════════════════════════════════════════════════

const NODES = Array.from({ length: 9 }, (_, i) => '0x' + String(i + 1).repeat(40));

test('storage placement agrees with core/placement.mjs, shard for shard', () => {
  const post = { cid: HEX(0x1234), bytes: 5 * SHARD_BYTES + 17 };
  const replication = Number(PARAMS.replication);
  for (const nodeId of NODES) {
    const plan = shardPlanFor(nodeId, post, NODES);
    assert.deepEqual(plan.shards, shardsOf(post.cid, post.bytes, SHARD_BYTES));
    for (const index of plan.shards) {
      const server = placeShard(NODES, post.cid, index, replication);
      assert.deepEqual(plan.holders.get(index), server, 'a browser node placed a shard differently');
      assert.equal(plan.mine.includes(index), server.includes(nodeId));
    }
  }
  // Every shard is held by exactly `replication` nodes, and every node's share
  // adds up to that.
  const total = NODES.reduce((n, id) => n + shardPlanFor(id, post, NODES).mine.length, 0);
  assert.equal(total, shardsOf(post.cid, post.bytes, SHARD_BYTES).length * replication);
});

test('shard ranges tile the picture exactly, and the last one is short', () => {
  const bytes = 3 * SHARD_BYTES + 101;
  let covered = 0;
  const indexes = shardsOf(HEX(1), bytes, SHARD_BYTES);
  for (const i of indexes) {
    const range = shardRangeOf(i, bytes);
    assert.equal(range.start, covered, 'a gap or an overlap between shards');
    covered = range.end;
  }
  assert.equal(covered, bytes);
  assert.equal(shardRangeOf(indexes[indexes.length - 1], bytes).length, 101);
  assert.throws(() => shardRangeOf(indexes.length, bytes));
});

test('a shard this node was not assigned is refused rather than stored', async () => {
  const post = { cid: HEX(0x99), bytes: 4 * SHARD_BYTES };
  const nodeId = NODES[0];
  const space = createDataSpace({ backend: memoryBackend(), nodeId, meteredOverride: false });
  const plan = space.plan(post, NODES);
  const notMine = plan.shards.find((i) => !plan.mine.includes(i));
  assert.notEqual(notMine, undefined, 'the fixture needs a shard this node does not hold');
  await assert.rejects(
    () => space.accept(post, notMine, new Uint8Array(SHARD_BYTES), NODES),
    /CAPACITY_NOT_PLACED/,
  );
  const report = await space.report();
  assert.equal(report.shards, 0);
});

test('a challenge is answered out of the bytes actually held', async () => {
  const bytes = new Uint8Array(2 * SHARD_BYTES + 500);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const cid = createHash('sha256').update(bytes).digest('hex');
  const post = { pid: 'p1', cid, bytes: bytes.length };
  const nodeId = NODES[0];
  const space = createDataSpace({ backend: memoryBackend(), nodeId, meteredOverride: false });
  const plan = space.plan(post, NODES);
  assert.ok(plan.mine.length > 0, 'the fixture needs at least one shard here');

  for (const index of plan.mine) {
    const range = shardRangeOf(index, post.bytes);
    const stored = await space.accept(post, index, bytes.subarray(range.start, range.end), NODES);
    assert.equal(stored.stored, true);
  }

  const seed = 'epoch-seed-3';
  for (const index of plan.mine) {
    const proof = await space.prove(post, index, seed);
    const range = shardRangeOf(index, post.bytes);
    const shard = bytes.subarray(range.start, range.end);
    // What a verifier holding a complete copy would compute, independently.
    const expected = answerChallenge(shard, challengeFor(cid, index, seed, range.length));
    assert.equal(proof.answer, expected, 'the proof does not match the bytes');
    assert.equal(proof.challenge.pid, 'p1');
    assert.equal(proof.challenge.shard, index);
  }

  // A shard this device does not hold cannot be proved, and says so.
  const notMine = plan.shards.find((i) => !plan.mine.includes(i));
  if (notMine !== undefined) {
    await assert.rejects(() => space.prove(post, notMine, seed), /CAPACITY_PROOF_WRONG/);
  }

  // Serving counts the bytes it served, which is what the capacity share pays
  // for.
  const served = await space.serve(cid, plan.mine[0]);
  assert.ok(served instanceof Uint8Array);
  const report = await space.report();
  assert.equal(report.servedBytes, BigInt(served.length));
  assert.equal(report.shards, plan.mine.length);
  assert.equal(report.pictures, 1);

  // Settlement takes the payload off this device.
  await space.forget(cid);
  assert.equal((await space.report()).shards, 0);
});

test('nothing is stored while the connection may be metered', async () => {
  const post = { cid: HEX(0x77), bytes: SHARD_BYTES };
  // No override and no NetworkInformation: the platform will not say, so the
  // answer is "metered" and the device serves nothing. Serving on a 5 EUR/GB
  // plan costs 3,255 times what it earns, and the member would not know.
  const unknown = createDataSpace({ backend: memoryBackend(), nodeId: NODES[0] });
  assert.equal(unknown.connection().metered, null);
  assert.equal(unknown.mayServe().ok, false);
  const plan = unknown.plan(post, NODES);
  const mine = plan.mine[0];
  if (mine !== undefined) {
    const attempt = await unknown.accept(post, mine, new Uint8Array(SHARD_BYTES), NODES);
    assert.equal(attempt.stored, false);
    assert.match(attempt.why, /3,255/);
  }
  // The member says it is Wi-Fi, and their answer outranks the guess.
  unknown.setMetered(false);
  assert.equal(unknown.mayServe().ok, true);
  // And data-saver is the one signal every browser agrees on.
  assert.equal(connectionState(null, { connection: { saveData: true } }).metered, true);
  assert.equal(connectionState(null, { connection: { saveData: false, type: 'cellular' } }).metered, true);
  assert.equal(connectionState(null, { connection: { saveData: false, type: 'wifi' } }).metered, false);
  assert.equal(connectionState(true, { connection: { saveData: false, type: 'wifi' } }).metered, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE PRICES ON THE SCREEN ARE THE CHARGES IN THE LOG
// ═══════════════════════════════════════════════════════════════════════════

test('a euro typed in is the euro printed out, to the nanoeuro', () => {
  for (const nano of [
    PARAMS.viewPriceMinNanoEur,
    PARAMS.viewPriceDefaultNanoEur,
    PARAMS.viewPriceMaxNanoEur,
    PARAMS.publishBaseFeeNanoEur,
    1n,
    NANO_EUR_PER_EUR,
    123456789012n,
  ]) {
    assert.equal(parseEurToNano(formatEur(nano)), nano, 'round trip failed at ' + nano);
  }
  assert.equal(parseEurToNano('0.0001'), 100000n);
  assert.equal(parseEurToNano('0,0001'), 100000n);
  assert.equal(parseEurToNano('1'), NANO_EUR_PER_EUR);
  // Finer than a nanoeuro is refused rather than rounded: dropping a digit from
  // a price is how a poster charges a tenth of what they meant to.
  assert.throws(() => parseEurToNano('0.0000000001'), /BAD_AMOUNT/);
  assert.throws(() => parseEurToNano('abc'), /BAD_AMOUNT/);
  assert.throws(() => parseEurToNano(''), /BAD_AMOUNT/);
});

test('units parse and print without a float anywhere near them', () => {
  assert.equal(parseUnits('1.5', 18), 1500000000000000000n);
  assert.equal(parseUnits('0.000000000000000001', 18), 1n);
  assert.equal(parseUnits('100000', 0), 100000n);
  assert.throws(() => parseUnits('1.5', 0), /BAD_AMOUNT/);
  assert.equal(formatUnits(1500000000000000000n, 18, 6), '1.5');
  assert.equal(formatUnits(1n, 18, 18), '0.000000000000000001');
  // The group separator is U+202F, the same narrow no-break space
  // core/pricing.mjs formatEur uses, written as an escape here because the
  // difference between it and an ordinary space is invisible in a diff.
  assert.equal(formatUnits(1234567n * 10n ** 18n, 18, 2), '1\u202f234\u202f567');
  // The largest quantity this economy can hold, printed exactly. A double would
  // have lost the last eleven digits.
  assert.equal(formatUnits(7310000n * 10n ** 18n, 18, 0), '7\u202f310\u202f000');
  assert.equal(formatUnits(7310000n * 10n ** 18n + 1n, 18, 18), '7\u202f310\u202f000.000000000000000001');
});

test("the composer's receipt is exactly what the rulebook charges", () => {
  const { world, alice } = fixture();
  const bytes = 2000000;
  const days = 3;
  const before = { ptp: world.accounts[alice].ptp, cap: world.accounts[alice].cap };
  const receipt = publishReceipt({ bytes, days, world, held: before.cap });
  const act = prepareAct(
    world,
    alice,
    {
      k: 'post',
      cid: HEX(0x5150),
      bytes,
      mime: 'image/jpeg',
      w: 1000,
      h: 1250,
      viewPriceNano: PARAMS.viewPriceDefaultNanoEur.toString(),
      days,
    },
    1700000100000,
  );
  assert.equal(actError(world, act), null);
  assert.equal(applyAct(world, act).ok, true);
  assert.equal(before.ptp - world.accounts[alice].ptp, receipt.totalWei, 'the receipt is not the charge');
  assert.equal(before.cap - world.accounts[alice].cap, receipt.capUnits, 'the CAP line is not what was consumed');
  // 0.002 EUR of publish fee and 0.000012 EUR a day of rent at replication 3 —
  // the figures docs/ECONOMICS.md quotes for a 2 MB picture.
  assert.equal(receipt.feeNano, 2000000n);
  assert.equal(receipt.rentNano, 12000n * BigInt(days));
});

test('an engagement price shown is the engagement price charged', () => {
  const { world, alice, bob } = fixture();
  const pid = publishFixturePost(world, alice, 1700000100000);
  const post = world.posts[pid];
  for (const kind of ['view', 'like', 'comment']) {
    const shown = engagementPrice(post, kind, world);
    assert.equal(shown.nanoEur, actionPriceNanoEur(post.viewPriceNano, kind, world.constants));
    assert.equal(shown.wei, priceOf(shown.nanoEur, world.epoch.oracle).wei);
    assert.ok(shown.wei > 0n, 'a priced action converted to nothing');
  }
  const before = world.accounts[bob].ptp;
  const price = engagementPrice(post, 'like', world);
  const act = prepareAct(world, bob, { k: 'like', pid }, 1700000200000);
  assert.equal(applyAct(world, act).ok, true);
  assert.equal(before - world.accounts[bob].ptp, price.wei, 'the like cost something other than the price shown');
});

test('the slippage line is the trade: minOut is what the pool fills at, or it refuses', () => {
  const { world, alice } = fixture();
  const amount = 50000n;
  const preview = swapPreview(world.pool, 'btc', amount, 0, world.constants);
  assert.equal(preview.minOut, preview.out, 'zero slippage should accept exactly the quote');
  // A minOut one wei above the quote is a fill at a price the screen never
  // showed, and it is refused rather than executed.
  const greedy = prepareAct(
    world,
    alice,
    { k: 'swap', sell: 'btc', amt: amount.toString(), minOut: (preview.out + 1n).toString() },
    1700000100000,
  );
  assert.equal(actError(world, greedy).code, 'SLIPPAGE_EXCEEDED');

  const before = world.accounts[alice].ptp;
  const honest = prepareAct(
    world,
    alice,
    { k: 'swap', sell: 'btc', amt: amount.toString(), minOut: preview.minOut.toString() },
    1700000100000,
  );
  assert.equal(applyAct(world, honest).ok, true);
  assert.equal(world.accounts[alice].ptp - before, preview.out, 'the fill differed from the quote on screen');
  assert.deepEqual(world.pool, preview.newPool);

  const withSlippage = swapPreview(world.pool, 'ptp', 10n ** 18n, 50, world.constants);
  assert.ok(withSlippage.minOut < withSlippage.out);
  assert.equal(withSlippage.minOut, (withSlippage.out * 9950n) / 10000n);
});

test('the session meter counts what was billed, in integers', () => {
  const session = createSession();
  assert.equal(session.total, 0n);
  session.add('view', PARAMS.viewPriceDefaultNanoEur);
  session.add('view', PARAMS.viewPriceDefaultNanoEur);
  session.add('like', actionPriceNanoEur(PARAMS.viewPriceDefaultNanoEur, 'like', PARAMS));
  assert.equal(session.total, 200000n + 1000000n);
  assert.deepEqual(session.rows.map((r) => [r.what, r.n]), [['view', 2], ['like', 1]]);
  assert.equal(formatEur(session.total), '0.001\u202f2\u00a0\u20ac');
  assert.throws(() => session.add('view', 1), /BAD_AMOUNT/);

  // The calibrated honest day — 150 views, 16 likes, 5 comments — is 0.0410 EUR,
  // the figure docs/ECONOMICS.md rests its affordability case on. The meter has
  // to agree with it or the header is lying.
  const day = createSession();
  const view = PARAMS.viewPriceDefaultNanoEur;
  for (let i = 0; i < 150; i++) day.add('view', view);
  for (let i = 0; i < 16; i++) day.add('like', actionPriceNanoEur(view, 'like', PARAMS));
  for (let i = 0; i < 5; i++) day.add('comment', actionPriceNanoEur(view, 'comment', PARAMS));
  assert.equal(day.total, 41000000n);
  assert.equal(formatEur(day.total), '0.041\u00a0\u20ac');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE TWO RULES THE CLIENT COULD BREAK ON ITS OWN
// ═══════════════════════════════════════════════════════════════════════════

test('rule 5: no balance enters the feed score', () => {
  const now = 1700000000000;
  const post = {
    author: '0x' + '1'.repeat(40),
    created: now - 3600000,
    expires: now + 3600000,
    state: 'live',
    uniqueViewers: 7,
    likes: 3,
    comments: 1,
    views: 30,
    viewPriceNano: PARAMS.viewPriceMinNanoEur,
    creditWei: 0n,
    grossNano: 0n,
    paidWei: 0n,
  };
  const base = rankScore(post, now);
  // Everything money can buy, moved as far as it goes. The score does not know.
  const rich = { ...post, viewPriceNano: PARAMS.viewPriceMaxNanoEur, creditWei: 10n ** 24n, grossNano: 10n ** 18n, paidWei: 10n ** 24n };
  assert.equal(rankScore(rich, now), base, 'a balance changed the rank');

  const world = emptyWorld(PARAMS);
  world.posts.p1 = { ...post };
  world.posts.p2 = { ...rich, created: now - 3600001 };
  world.accounts[post.author] = { handle: 'a', sat: 10n ** 12n, ptp: 10n ** 30n, cap: 0n, shares: 0n, joined: 0, acts: 0, viewSeq: -1 };
  const order = feedOrder(world, now).map((e) => e.pid);
  assert.deepEqual(order, ['p1', 'p2'], 'the richer, older post outranked the newer one');
});

test('the client refuses exactly what the writer refuses, with the same sentence', () => {
  const { world, alice, bob } = fixture();
  const now = 1700000100000;
  const pid = publishFixturePost(world, alice, now);
  const cases = [
    [alice, { k: 'like', pid }, 'SELF_ENGAGEMENT'],
    [bob, { k: 'like', pid: 'p999' }, 'POST_NOT_FOUND'],
    [bob, { k: 'view', pid, dwellMs: 10, seq: 0 }, 'VIEW_DWELL_TOO_SHORT'],
    [bob, { k: 'comment', pid, text: 'x'.repeat(1001) }, 'COMMENT_TOO_LONG'],
    [bob, { k: 'register', handle: 'alice' }, 'ALREADY_REGISTERED'],
    ['0x' + 'c'.repeat(40), { k: 'like', pid }, 'UNKNOWN_ACCOUNT'],
    [bob, { k: 'settle', pid }, 'SETTLE_BEFORE_GRACE'],
  ];
  for (const [as, act, code] of cases) {
    const client = checkAct(world, as, act, now + 1000);
    const writer = actError(world, prepareAct(world, as, act, now + 1000));
    assert.equal(client.code, code, JSON.stringify(act));
    // Not merely the same code: the same four fields, because they come from the
    // same catalogue through the same function.
    assert.deepEqual({ ...client, detail: null }, { ...writer, detail: null });
    assert.ok(client.msg && client.why && client.next);
  }
  // No account connected is a refusal too, and it is the writer's refusal.
  assert.equal(checkAct(world, null, { k: 'like', pid }, now).code, 'BAD_ADDRESS');
  // And an act the rulebook accepts returns null, which is when a button is
  // offered and not before.
  assert.equal(checkAct(world, bob, { k: 'like', pid }, now + 1000), null);
});

test('a clock a little behind the log does not refuse the user their own act', () => {
  const { world, alice, bob } = fixture();
  const pid = publishFixturePost(world, alice, 1700000100000);
  // The device's clock reads earlier than the last accepted act. Left alone that
  // is TIMESTAMP_IMPLAUSIBLE — a refusal about a wristwatch — so the stamp is
  // clamped to the log and the writer assigns the real one anyway.
  const behind = prepareAct(world, bob, { k: 'like', pid }, 1);
  assert.equal(behind.t, world.log.lastAt);
  assert.equal(actError(world, behind), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. WHAT THE APP SHIPS
// ═══════════════════════════════════════════════════════════════════════════

test('the client loads nothing from anybody else’s server', () => {
  const here = fileURLToPath(new URL('../app/', import.meta.url));
  for (const name of ['app.mjs', 'wallet.mjs', 'storage.mjs']) {
    const source = readFileSync(here + name, 'utf8');
    const urls = source.match(/https?:\/\/[^\s'"`)]+/g) || [];
    for (const url of urls) {
      // The only absolute URLs allowed are the ones in prose: a placeholder in a
      // comment is not a request.
      assert.ok(/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) || url.includes('…'), `${name} reaches ${url}`);
    }
    assert.ok(!/\bimport\s*\(\s*['"]https?:/.test(source), `${name} imports over the network`);
  }
});

test('the client states no economic number core/params.mjs already exports', () => {
  const whole = readFileSync(fileURLToPath(new URL('../app/app.mjs', import.meta.url)), 'utf8');
  // Prose may quote the calibration — a comment explaining why the dwell is
  // 1500 ms is exactly the comment that should be there. Code may not: a
  // literal in an expression is a second edition of the economy that nothing
  // would ever compare against.
  const source = whole
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // The distinctive ones — every price, every multiplier, every split. Small
  // integers like the pair cap are deliberately NOT scanned for: 12 is also a
  // perfectly good page size, and a grep that cannot tell them apart would be
  // enforced by renaming innocent constants. The thresholds are covered by the
  // test below instead, which is the stronger check anyway because it reads
  // behaviour rather than text.
  for (const value of [
    PARAMS.viewPriceDefaultNanoEur,
    PARAMS.viewPriceMinNanoEur,
    PARAMS.viewPriceMaxNanoEur,
    PARAMS.publishBaseFeeNanoEur,
    PARAMS.storageRentNanoEurPerMbDay,
    PARAMS.likeMultiplierBps,
    PARAMS.commentMultiplierBps,
    PARAMS.viewDwellMs,
    PARAMS.viewCooldownSec,
    PARAMS.splitCreatorBps,
    PARAMS.splitBurnBps,
    PARAMS.emissionCapBps,
    PARAMS.newAccountBondNanoEur,
    PARAMS.minSettlementNanoEur,
  ]) {
    const literal = new RegExp(`(^|[^0-9.])${value}n?([^0-9]|$)`, 'm');
    assert.ok(!literal.test(source), `app.mjs hardcodes ${value}, which core/params.mjs exports`);
  }
});

test('the view machine reads its thresholds from a params edition, not from itself', () => {
  // A world replayed under a sealed edition must be judged by THAT edition's
  // numbers. If the machine held its own copies, a client and a writer running
  // different editions would disagree about what was billable and neither could
  // say why. Four thresholds, all moved at once, and the behaviour follows.
  const edition = {
    ...PARAMS,
    viewMinViewportPct: 20n,
    viewDwellMs: 400n,
    viewCooldownSec: 2n,
    maxViewsPerPairPerEpoch: 2n,
  };
  const meter = createViewMeter({ params: edition, viewportPx: 800 });
  meter.intersect('p1', 25); // below the shipped 60, above this edition's 20
  const first = drive(meter, 0, 900, 100);
  assert.equal(first.length, 1, 'the edition’s viewport share and dwell were not used');
  assert.ok(first[0].dwellMs >= 400 && first[0].dwellMs < Number(PARAMS.viewDwellMs));

  let t = 1000;
  let billed = 1;
  for (let i = 0; i < 5; i++) {
    meter.intersect('p1', 0);
    meter.tick(t);
    meter.intersect('p1', 25);
    billed += drive(meter, t + 100, t + 900, 100).length;
    t += 2000 + 1000;
  }
  assert.equal(billed, 2, 'the edition’s per-pair cap was not used');
});

test('MAX_PAYLOAD_BYTES is the limit the composer enforces', () => {
  // Stated in the rulebook, read by the client, never restated: an 8 MB upload
  // asks for 24 MB of somebody else's device at replication 3.
  assert.equal(MAX_PAYLOAD_BYTES, 8000000);
  assert.equal(shardsOf(HEX(1), MAX_PAYLOAD_BYTES, SHARD_BYTES).length, Math.ceil(MAX_PAYLOAD_BYTES / SHARD_BYTES));
});
