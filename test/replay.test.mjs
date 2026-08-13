// The one rulebook, run.
//
// Everything here is a claim ARCHITECTURE makes about `core/replay.mjs` turned
// into arithmetic somebody else can check: that replay is pure, that it is
// deterministic, that a post accrues a PTP quantity rather than a euro liability,
// that a billable view is billable exactly when the four conditions hold, that
// settlement pays and redacts and tombstones, and that every wei debited from an
// account is somewhere else afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  PARAMS,
  EPOCH_SECONDS,
  NANO_EUR_PER_EUR,
  SAT_PER_BTC,
  WAD,
  creatorRebate,
} from '../core/params.mjs';
import { canonicalJson } from '../core/canonical.mjs';
import { E } from '../core/errors.mjs';
import { SPLIT_VECTORS, actionPriceNanoEur, nanoEurToPtpWei, splitFee } from '../core/pricing.mjs';
import { placeShard } from '../core/placement.mjs';
import { credit as creditV1, VERSION as RULES_VERSION } from '../core/rules/v1.mjs';
import {
  EDITION,
  MB_PER_PLACEMENT_SLOT,
  actError,
  applyAct,
  emptyWorld,
  placementFor,
  replay,
} from '../core/replay.mjs';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const KEY = '0x' + 'e'.repeat(40);
const T0 = 1786445193465;
const DAY = Number(EPOCH_SECONDS) * 1000;
const GRACE = Number(PARAMS.settlementGraceSec) * 1000;
const COOLDOWN = Number(PARAMS.viewCooldownSec) * 1000;

/**
 * A log builder. It hands back both the world and the acts, because half the
 * claims here are about the world and the other half are about replaying the same
 * acts again and landing in the same place.
 */
function stage(params = { ...PARAMS, ruleKey: KEY }) {
  const world = emptyWorld(params);
  const acts = [];
  let i = 0;
  let t = T0;
  const api = {
    world,
    acts,
    get at() {
      return t;
    },
    wait(ms) {
      t += ms;
      return api;
    },
    land(as, k, fields = {}, dt = 1000) {
      t += dt;
      const a = { i: i++, t, as, k, ...fields };
      acts.push(a);
      const result = applyAct(world, a);
      assert.equal(result.ok, true, `${k} refused: ${result.code} ${JSON.stringify(result.detail)}`);
      return a;
    },
    refuse(as, k, fields = {}, dt = 1000) {
      t += dt;
      const a = { i, t, as, k, ...fields };
      const result = applyAct(world, a);
      assert.equal(result.ok, false, `${k} was accepted`);
      return result;
    },
    fund(addr, handle, sat = '400000', buy = '3000') {
      api.land(addr, 'register', { handle });
      // A txid is 64 lowercase hex characters, and one per address keeps the
      // burn index honest without a hash function in the test.
      api.land(addr, 'burnClaim', { txid: (addr.slice(2) + addr.slice(2)).slice(0, 64), vout: 0, sat });
      api.land(addr, 'swap', { sell: 'btc', amt: buy, minOut: '1' });
      return api;
    },
    publish(addr, over = {}) {
      return api.land(addr, 'post', {
        cid: 'd'.repeat(64),
        bytes: 2000000,
        mime: 'image/jpeg',
        w: 1200,
        h: 1500,
        viewPriceNano: String(PARAMS.viewPriceDefaultNanoEur),
        days: 1,
        ...over,
      });
    },
  };
  return api;
}

// ── the shape of the thing ─────────────────────────────────────────────────

test('EDITION is the sha256 of this file, self-reported', () => {
  const onDisk = createHash('sha256')
    .update(readFileSync(new URL('../core/replay.mjs', import.meta.url)))
    .digest('hex');
  assert.equal(EDITION, onDisk);
  assert.match(EDITION, /^[0-9a-f]{64}$/);
});

test('an empty world is the genesis pool and nothing else', () => {
  const w = emptyWorld(PARAMS);
  assert.deepEqual(w.pool, { sat: PARAMS.genesisSat, ptp: PARAMS.genesisPtpWei, shares: 100000000000000n, locked: 1000n });
  assert.equal(w.supply.emitted, PARAMS.genesisPtpWei);
  assert.equal(w.supply.burned, 0n);
  assert.deepEqual(Object.keys(w.accounts), []);
  assert.equal(w.rules.version, RULES_VERSION);
  assert.equal(w.epoch.n, 0);
  // Nobody is allocated anything: the only PTP that exists is the side of the
  // pool it opens against.
  assert.equal(w.treasury.ptp, 0n);
  assert.equal(w.capacity.potPtp, 0n);
});

// ── rule 1: replay is a pure function of the log ───────────────────────────

test('replay never consults a clock, the network or a random source', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A);
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'like', { pid: 'p1' });

  const clock = Date.now;
  const random = Math.random;
  const net = globalThis.fetch;
  const perf = globalThis.performance ? globalThis.performance.now : undefined;
  Date.now = () => {
    throw new Error('replay read a clock');
  };
  Math.random = () => {
    throw new Error('replay read a random source');
  };
  globalThis.fetch = () => {
    throw new Error('replay read the network');
  };
  if (perf) {
    globalThis.performance.now = () => {
      throw new Error('replay read a clock');
    };
  }
  try {
    const again = replay(s.acts, { ...PARAMS, ruleKey: KEY });
    assert.equal(again.log.skipped, 0);
    assert.equal(canonicalJson(again), canonicalJson(s.world));
  } finally {
    Date.now = clock;
    Math.random = random;
    globalThis.fetch = net;
    if (perf) globalThis.performance.now = perf;
  }
});

test('replay is deterministic, and resuming is the same as replaying', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 2 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 1600, seq: 1, vp: 61 });
  s.land(B, 'comment', { pid: 'p1', text: 'the light in this one' });
  s.wait(COOLDOWN + 1000);
  s.land(B, 'view', { pid: 'p1', dwellMs: 5000, seq: 2, vp: 100 });

  const once = replay(s.acts, { ...PARAMS, ruleKey: KEY });
  const twice = replay(s.acts, { ...PARAMS, ruleKey: KEY });
  assert.equal(canonicalJson(once), canonicalJson(twice));
  assert.equal(canonicalJson(once), canonicalJson(s.world));

  // Split the log in half and resume: the world is a function of the acts, not
  // of how many passes it took to read them.
  const half = Math.floor(s.acts.length / 2);
  const resumed = replay(s.acts.slice(0, half), { ...PARAMS, ruleKey: KEY });
  for (const a of s.acts.slice(half)) assert.equal(applyAct(resumed, a).ok, true);
  assert.equal(canonicalJson(resumed), canonicalJson(once));
});

test('every balance in the world is a bigint after a long replay', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A);
  s.land(A, 'liqAdd', { sat: '1000', ptp: '10000000000000000' });
  for (let n = 0; n < 5; n += 1) {
    s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: n + 1, vp: 80 }, COOLDOWN + 1000);
  }
  s.land(B, 'like', { pid: 'p1' });

  const money = [
    s.world.pool.sat,
    s.world.pool.ptp,
    s.world.pool.shares,
    s.world.pool.locked,
    s.world.supply.emitted,
    s.world.supply.burned,
    s.world.treasury.ptp,
    s.world.capacity.potPtp,
    s.world.capacity.bondsPtp,
  ];
  for (const account of Object.values(s.world.accounts)) {
    money.push(account.sat, account.ptp, account.cap, account.shares);
  }
  for (const post of Object.values(s.world.posts)) {
    money.push(post.grossNano, post.creditWei, post.paidWei, post.capUnits, post.escrow.holdingWei, post.escrow.servingWei);
  }
  for (const value of money) assert.equal(typeof value, 'bigint');
  // And the counts are Numbers, because they are counts.
  assert.equal(typeof s.world.posts.p1.views, 'number');
  assert.equal(typeof s.world.epoch.n, 'number');
});

// ── conservation ───────────────────────────────────────────────────────────

/**
 * The identity in the two halves the stranding was found in.
 *
 *   genesis + minted − burned  ==  circulating + pot
 *
 * `circulating` is every wei some account, the pool, the treasury, a bond or a
 * post's accrued credit could still move. `pot` is what is held in escrow
 * against work that has not been paid for yet — and the second assertion below
 * is the one that has teeth: the pot is exactly the sum of the per-post
 * escrows, with nothing beside them. PTP that sits in the pot without an escrow
 * behind it is PTP no act can ever move, and it was not counted as burned
 * either, so it inflated the circulating supply forever.
 */
function halves(world) {
  let accounts = 0n;
  let credit = 0n;
  let escrows = 0n;
  let bonds = 0n;
  for (const a of Object.values(world.accounts)) accounts += a.ptp;
  for (const p of Object.values(world.posts)) {
    credit += p.creditWei;
    escrows += p.escrow.holdingWei + p.escrow.servingWei;
  }
  // Pledge bonds are held by the protocol against slashing rather than escrowed
  // against work, so they are counted here and checked against the per-identity
  // rows that owe them. Nothing in ARCHITECTURE §4's act table slashes one yet,
  // so a bond is immobile once posted — which is why it is named and summed
  // rather than folded silently into a total.
  for (const row of Object.values(world.capacity.providers)) bonds += row.bondPtp;
  return {
    circulating: world.pool.ptp + world.treasury.ptp + world.capacity.bondsPtp + accounts + credit,
    pot: world.capacity.potPtp,
    escrows,
    bonds,
  };
}

/** Every wei that exists, wherever it is sitting. */
function circulating(world) {
  let total = world.pool.ptp + world.treasury.ptp + world.capacity.potPtp + world.capacity.bondsPtp;
  for (const a of Object.values(world.accounts)) total += a.ptp;
  // A post's accrued credit is money that has left an account and not yet
  // reached one: it is held by the post until settlement.
  for (const p of Object.values(world.posts)) total += p.creditWei;
  return total;
}

test('every wei debited is somewhere else afterwards', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  s.land(A, 'capBuy', { ptp: '3000000000000000000' });
  s.publish(A, { days: 1 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(C, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'like', { pid: 'p1' });
  s.land(C, 'comment', { pid: 'p1', text: 'good' });
  s.land(A, 'extend', { pid: 'p1', days: 1 });
  s.land(A, 'capPledge', { mb: 500, endpoint: 'https://node.example' });
  s.land(A, 'capProof', { challenge: { pid: 'p1', shard: 0 }, answer: '1'.repeat(64) });
  s.land(A, 'capClaim');

  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);

  s.wait(2 * DAY + GRACE + 1000);
  s.land(C, 'settle', { pid: 'p1' });
  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);

  s.land(A, 'closeEpoch');
  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);
});

test('a capacity purchase is destroyed, not parked in a pot nobody can draw', () => {
  // What was measured: capBuy paid PTP into capacity.potPtp, and the only two
  // subtractions from that pot — a provider's claim and a settlement's sweep —
  // are both bounded by the escrows of one post. capBuy funds no escrow, so
  // every wei of it sat there for the life of the network: not spendable by
  // anybody, not counted as burned, and quietly inflating the circulating
  // supply that ECONOMICS.md's supply law is stated over.
  const s = stage();
  s.fund(A, 'alice');
  const spend = 2000000000000000000n;
  const burnedBefore = s.world.supply.burned;
  const potBefore = s.world.capacity.potPtp;
  const heldBefore = s.world.accounts[A].ptp;

  s.land(A, 'capBuy', { ptp: String(spend) });

  assert.equal(heldBefore - s.world.accounts[A].ptp, spend);
  assert.equal(s.world.supply.burned - burnedBefore, spend, 'the purchase was not destroyed');
  assert.equal(s.world.capacity.potPtp, potBefore, 'the purchase landed in the pot again');
  assert.ok(s.world.accounts[A].cap > 0n);

  // And the pot is the escrows, exactly, at every point of a post's life. That
  // is the property the stranding broke: a pot with no escrow behind it.
  const at = () => {
    const h = halves(s.world);
    assert.equal(h.pot, h.escrows, 'the pot holds wei no escrow accounts for');
    assert.equal(s.world.supply.emitted - s.world.supply.burned, h.circulating + h.pot);
  };
  at();
  s.publish(A, { days: 1 });
  at();
  s.land(A, 'extend', { pid: 'p1', days: 1 });
  at();
  s.wait(2 * DAY + GRACE + 1000);
  s.land(A, 'settle', { pid: 'p1' });
  at();
  assert.equal(s.world.capacity.potPtp, 0n);
});

test('the accounting identity holds after every act of a fuzzed log', () => {
  // genesis + minted − burned == circulating + pot, asserted after every act
  // rather than at the end, so an act that both breaks and repairs the identity
  // cannot hide inside a total. The sequence is pseudo-random and DETERMINISTIC:
  // replay may not read a random source, and neither may a test that has to be
  // reproducible from its own source. Most of these acts are refused, which is
  // the other half of what is being asserted — a refusal must move nothing.
  let seed = 20260812;
  const rnd = (n) => {
    // xorshift32. A linear congruential generator was tried first and its low
    // bit alternates, which through `% n` picked act kinds in a cycle and left
    // four of them untried — the coverage assertion at the end is what caught
    // it. Reproducibility is the requirement; this one also mixes.
    seed ^= (seed << 13) & 0xffffffff;
    seed ^= seed >>> 17;
    seed ^= (seed << 5) & 0xffffffff;
    seed >>>= 0;
    return seed % n;
  };

  const s = stage();
  const cast = [A, B, C];
  for (const [n, addr] of cast.entries()) s.fund(addr, `player${n}`, '900000', '9000');
  for (const addr of cast) s.land(addr, 'capBuy', { ptp: '900000000000000000' });

  const check = (what) => {
    const h = halves(s.world);
    assert.equal(
      s.world.supply.emitted - s.world.supply.burned,
      h.circulating + h.pot,
      `the identity broke after ${what}`,
    );
    assert.equal(h.pot, h.escrows, `the pot stopped being the escrows after ${what}`);
    assert.equal(s.world.capacity.bondsPtp, h.bonds, `the bond ledger lost an owner after ${what}`);
    assert.ok(h.pot >= 0n && h.circulating >= 0n, `a total went negative after ${what}`);
  };
  check('the funding');

  const cids = ['1', '2', '3', '4', '5'].map((c) => c.repeat(64));
  let landed = 0;
  const kinds = new Set();
  let t = s.at;
  let seq = 0;
  for (let n = 0; n < 600; n += 1) {
    const as = cast[rnd(cast.length)];
    const pid = `p${1 + rnd(4)}`;
    const table = [
      () => ({ k: 'capBuy', ptp: String(1n + BigInt(rnd(1000000)) * 1000000000n) }),
      () => ({
        k: 'post',
        cid: cids[rnd(cids.length)],
        bytes: 100000 + rnd(900000),
        mime: 'image/jpeg',
        w: 100 + rnd(900),
        h: 100 + rnd(900),
        viewPriceNano: String(PARAMS.viewPriceMinNanoEur + BigInt(rnd(380000))),
        days: 1 + rnd(3),
      }),
      () => ({ k: 'view', pid, dwellMs: 1000 + rnd(3000), seq: (seq += 1), vp: 40 + rnd(60) }),
      () => ({ k: 'like', pid }),
      () => ({ k: 'comment', pid, text: `c${n}` }),
      () => ({ k: 'extend', pid, days: 1 + rnd(2) }),
      () => ({ k: 'settle', pid }),
      () => ({ k: 'capPledge', mb: 1 + rnd(2000), endpoint: `https://n${rnd(3)}.example` }),
      () => ({ k: 'capProof', challenge: { pid, shard: rnd(4) }, answer: String(rnd(10)).repeat(64) }),
      () => ({ k: 'capClaim' }),
      () => ({ k: 'swap', sell: rnd(2) === 0 ? 'btc' : 'ptp', amt: String(1 + rnd(100000)), minOut: '0' }),
      () => ({ k: 'liqAdd', sat: String(1 + rnd(1000)), ptp: String(BigInt(1 + rnd(1000)) * 1000000000000n) }),
      () => ({ k: 'liqRemove', shares: String(1 + rnd(1000)) }),
      () => ({ k: 'closeEpoch' }),
    ];
    const body = table[rnd(table.length)]();
    // Up to half an hour between acts. The step decides how much of the run a
    // post spends live, so it decides whether proofs and claims are reachable at
    // all; six days of acts is also several epochs, so closes land too.
    t += 1 + rnd(30 * 60 * 1000);
    const result = applyAct(s.world, { t, as, ...body });
    if (result.ok) {
      landed += 1;
      kinds.add(body.k);
    } else {
      // A refusal is catalogued or it is not a refusal a client can read.
      assert.ok(Object.prototype.hasOwnProperty.call(E, result.code), `${result.code} is not catalogued`);
    }
    check(`${body.k} #${n} (${result.ok ? 'accepted' : result.code})`);
  }

  // The fuzz has to have exercised the machine rather than bounced off it, and
  // in particular it has to have landed every act that moves the pot: a buy
  // that funds no escrow, rent and engagement that fund one, a claim that draws
  // one, and a settlement that destroys what is left.
  assert.ok(landed > 150, `only ${landed} of 600 acts landed`);
  for (const k of [
    'capBuy',
    'capClaim',
    'capPledge',
    'capProof',
    'closeEpoch',
    'comment',
    'extend',
    'like',
    'liqAdd',
    'liqRemove',
    'post',
    'settle',
    'swap',
    'view',
  ]) {
    assert.ok(kinds.has(k), `the fuzz never landed a ${k}`);
  }
  assert.ok(s.world.supply.burned > 0n);
});

test('CAP is bought at the rent tariff at every price, and one wei never mints a megabyte-day', () => {
  // The old conversion went wei -> nanoeuro -> CAP through ptpWeiToNanoEur,
  // which core/pricing.mjs documents as display-and-audit only and which floors
  // at 1 n€ so a meter never reads zero over a balance that moved. Settling a
  // MINT through that floor: one wei floored to 1 n€ and bought
  // 1e6/2000 = 500 CAP units, so 2,000 acts of one wei minted 1,000,000 units —
  // one MB-day that honestly costs 22,222,222,222,222 wei at the genesis price.
  const tariff = (units, rate) =>
    // What those units cost at the tariff, as the same rational the fused
    // conversion inverts: units × rent / capCoinPerMbDay nanoeuros, in wei.
    (units * PARAMS.storageRentNanoEurPerMbDay * SAT_PER_BTC * rate.poolPtpWei) /
    (PARAMS.capCoinPerMbDay * rate.eurPerBtcNano * rate.poolSat);

  const oldForm = (wei, rate) => {
    // ptpWeiToNanoEur, floor and all, then the tariff — the conversion that was
    // there, reproduced here so the regression cannot come back quietly.
    const nano = (wei * rate.eurPerBtcNano * rate.poolSat) / (SAT_PER_BTC * rate.poolPtpWei);
    return ((nano === 0n ? 1n : nano) * PARAMS.capCoinPerMbDay) / PARAMS.storageRentNanoEurPerMbDay;
  };

  // The sweep docs/ECONOMICS.md uses for every priced item: the token at one,
  // ten, a hundred, a thousand and a million times the genesis price. A euro is
  // worth m times as many wei, which is the same rational read from the other
  // end, so the EUR/BTC leg carries the multiplier.
  for (const m of [1n, 10n, 100n, 1000n, 1000000n]) {
    const s = stage({ ...PARAMS, ruleKey: KEY, genesisEurPerBtcNano: 90000n * NANO_EUR_PER_EUR * m });
    s.fund(A, 'alice', '900000', '9000');
    const rate = s.world.epoch.oracle;
    const send = (wei) => {
      s.wait(1000);
      return applyAct(s.world, { t: s.at, as: A, k: 'capBuy', ptp: String(wei) });
    };

    // One wei buys nothing, at every price in the sweep, and is refused rather
    // than rounded up to the smallest positive amount — which is the same
    // faucet in a smaller denomination.
    assert.equal(send(1n).code, 'DUST_BELOW_MINIMUM', `one wei minted CAP at ${m}x`);
    // What the old form did with that same wei, at that same price: it floored
    // the nanoeuro to 1 and sold half a thousandth of an MB-day for it.
    assert.equal(oldForm(1n, rate), 500n);
    assert.ok(tariff(oldForm(1n, rate), rate) > 1n, `no discount to remove at ${m}x`);
    if (m === 1n) {
      // The measured headline, exactly: 2,000 acts of one wei minted 1,000,000
      // CAP units — one MB-day — that honestly cost 22,222,222,222,222 wei at
      // the genesis price. A discount of 11,111,111,111 times.
      assert.equal(oldForm(1n, rate) * 2000n, 1000000n);
      assert.equal(tariff(1000000n, rate), 22222222222222n);
      assert.equal(tariff(1000000n, rate) / 2000n, 11111111111n);
    }

    for (const wei of [
      1000000000n,
      22222222222222n,
      1000000000000000n,
      2000000000000000000n,
      50000000000000000000n,
    ]) {
      const before = s.world.accounts[A].cap;
      const result = send(wei);
      if (!result.ok) {
        // Only ever refused for having bought nothing, and only when the tariff
        // agrees that it bought nothing.
        assert.equal(result.code, 'DUST_BELOW_MINIMUM');
        assert.ok(tariff(1n, rate) > wei, `${wei} wei was refused but covers a CAP unit at ${m}x`);
        continue;
      }
      const minted = s.world.accounts[A].cap - before;
      assert.ok(minted > 0n);
      // NO DISCOUNT: what was minted cost at least the tariff price of it.
      assert.ok(tariff(minted, rate) <= wei, `${minted} units cost less than the tariff at ${m}x`);
      // And the same statement without the truncation that `tariff` itself
      // carries, which is the definition of the fused floor: the units bought
      // are covered by the wei paid, and one more unit is not. Cross-multiplied,
      // so the comparison is exact rather than rounded twice.
      const N = rate.eurPerBtcNano * rate.poolSat * PARAMS.capCoinPerMbDay;
      const D = SAT_PER_BTC * rate.poolPtpWei * PARAMS.storageRentNanoEurPerMbDay;
      assert.ok(minted * D <= wei * N, `a discount survived at ${m}x`);
      assert.ok((minted + 1n) * D > wei * N, `the buyer was overcharged at ${m}x`);
    }
  }
});

// ── billable views ─────────────────────────────────────────────────────────

test('the viewer pays full price every time, and the credit does not decay', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 2 });

  const price = nanoEurToPtpWei(PARAMS.viewPriceDefaultNanoEur, s.world.epoch.oracle);
  const perView = splitFee(price, SPLIT_VECTORS.fee);
  const before = s.world.accounts[B].ptp;

  const cap = Number(PARAMS.maxViewsPerPairPerEpoch);
  for (let n = 0; n < cap; n += 1) {
    s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: n + 1, vp: 80 }, COOLDOWN + 1000);
  }

  // Twelve views cost twelve times one view. viewRepeatDecayAlpha is zero, so the
  // twelfth view credits the creator exactly what the first did — the hard cap is
  // the rate limiter, not a decay that charges full price for a discount.
  assert.equal(before - s.world.accounts[B].ptp, price * BigInt(cap));
  assert.equal(s.world.posts.p1.creditWei, perView.creator * BigInt(cap));
  assert.equal(s.world.posts.p1.views, cap);
  assert.equal(s.world.posts.p1.uniqueViewers, 1);

  // The thirteenth is refused: it costs nothing and earns nothing.
  const held = s.world.accounts[B].ptp;
  const capped = s.refuse(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 99, vp: 80 }, COOLDOWN + 1000);
  assert.equal(capped.code, 'VIEW_PAIR_CAP');
  assert.equal(s.world.accounts[B].ptp, held);
});

test('the cap counts inside an epoch and starts again at the close', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 3 });
  for (let n = 0; n < Number(PARAMS.maxViewsPerPairPerEpoch); n += 1) {
    s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: n + 1, vp: 80 }, COOLDOWN + 1000);
  }
  // Past the cooldown, so it is the cap that refuses and not the spacing.
  assert.equal(
    s.refuse(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 50, vp: 80 }, COOLDOWN + 1000).code,
    'VIEW_PAIR_CAP',
  );
  s.land(A, 'closeEpoch', {}, DAY);
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 50, vp: 80 });
  assert.equal(s.world.posts.p1.views, Number(PARAMS.maxViewsPerPairPerEpoch) + 1);
});

test('unique viewers count people, and a like is not a view', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });

  s.land(B, 'like', { pid: 'p1' }); // opens the pair without viewing
  assert.equal(s.world.posts.p1.uniqueViewers, 0);
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  assert.equal(s.world.posts.p1.uniqueViewers, 1);
  s.land(C, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  assert.equal(s.world.posts.p1.uniqueViewers, 2);
  s.wait(COOLDOWN + 1000);
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 2, vp: 80 });
  assert.equal(s.world.posts.p1.uniqueViewers, 2);
  assert.equal(s.world.posts.p1.views, 3);

  // A like is one per pair, ever. The second says nothing new and is not billed.
  assert.equal(s.refuse(B, 'like', { pid: 'p1' }).code, 'DUPLICATE_ACT');
});

// ── the post accrues a quantity, not a liability ───────────────────────────

test('settlement pays the wei that arrived, not a euro amount reconverted', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob', '9000000', '10000');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'like', { pid: 'p1' });
  s.land(B, 'comment', { pid: 'p1', text: 'held' });

  const accrued = s.world.posts.p1.creditWei;
  const grossNano = s.world.posts.p1.grossNano;
  assert.ok(accrued > 0n);

  // Move the pool hard, then close the epoch so the new ratio is what the next
  // epoch prices with. This is the attacker's half of the timing option: depress
  // the price, settle, restore.
  const rateBefore = s.world.epoch.oracle;
  s.land(B, 'swap', { sell: 'btc', amt: '300000', minOut: '1' });
  s.wait(DAY);
  s.land(A, 'closeEpoch');
  const rateAfter = s.world.epoch.oracle;
  assert.notEqual(rateAfter.poolPtpWei, rateBefore.poolPtpWei);

  const balanceBefore = s.world.accounts[A].ptp;
  s.wait(GRACE + 1000);
  s.land(B, 'settle', { pid: 'p1' });

  // Paid exactly what accrued. The euro figure reconverted at the settlement
  // rate is a different number, and it is the number this design refuses to owe.
  assert.equal(s.world.posts.p1.paidWei, accrued);
  assert.equal(s.world.accounts[A].ptp - balanceBefore, accrued);
  const wouldHaveBeen = splitFee(nanoEurToPtpWei(grossNano, rateAfter), SPLIT_VECTORS.fee).creator;
  assert.notEqual(wouldHaveBeen, accrued);
});

// ── the post lifecycle ─────────────────────────────────────────────────────

test('publish costs the base fee plus the first day of rent, and burns CAP', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  const capBefore = s.world.accounts[A].cap;
  const ptpBefore = s.world.accounts[A].ptp;
  const burnedBefore = s.world.supply.burned;

  s.publish(A, { bytes: 2000000, days: 1 });

  const rate = s.world.epoch.oracle;
  const fee = nanoEurToPtpWei(PARAMS.publishBaseFeeNanoEur, rate);
  // 2 MB × 3 replicas × 1 day at 0.000002 EUR per MB-day = 0.000012 EUR.
  const rent = nanoEurToPtpWei(12000n, rate);
  assert.equal(ptpBefore - s.world.accounts[A].ptp, fee + rent);
  assert.equal(capBefore - s.world.accounts[A].cap, 6000000n); // 6 MB-days at 1e6 units
  // No creator leg: a poster may not pay themselves to post.
  const legs = splitFee(fee, SPLIT_VECTORS.publish);
  assert.equal(legs.creator, 0n);
  assert.equal(s.world.supply.burned - burnedBefore, legs.burn);
  assert.equal(s.world.posts.p1.escrow.holdingWei, rent);
});

test('a lapsed post settles once, pays, redacts and tombstones', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'comment', { pid: 'p1', text: 'a good one' });

  // Inside the lease: not yet.
  assert.equal(s.refuse(B, 'settle', { pid: 'p1' }).code, 'SETTLE_BEFORE_GRACE');
  s.wait(DAY);
  // Lapsed, but inside the grace window the author still owns the decision.
  assert.equal(s.refuse(B, 'settle', { pid: 'p1' }).code, 'SETTLE_BEFORE_GRACE');
  // Engagement stops the moment the lease does.
  assert.equal(s.refuse(B, 'like', { pid: 'p1' }).code, 'POST_NOT_LIVE');

  s.wait(GRACE + 1000);
  const accrued = s.world.posts.p1.creditWei;
  const before = s.world.accounts[A].ptp;
  s.land(B, 'settle', { pid: 'p1' }); // anybody may close a lapsed post

  const post = s.world.posts.p1;
  assert.equal(post.state, 'settled');
  assert.equal(post.redacted, true);
  assert.equal(post.paidWei, accrued);
  assert.equal(post.creditWei, 0n);
  assert.equal(s.world.accounts[A].ptp - before, accrued);
  // The structure survives the payload: author, cid, byte length, dimensions,
  // lifetime, totals and what was paid.
  assert.equal(post.tombstone.cid, post.cid);
  assert.equal(post.tombstone.bytes, 2000000);
  assert.equal(post.tombstone.views, 1);
  assert.equal(post.tombstone.comments, 1);
  assert.equal(post.tombstone.paidWei, accrued);
  assert.equal(post.tombstone.by, B);
  // Once and final.
  assert.equal(s.refuse(B, 'settle', { pid: 'p1' }).code, 'POST_ALREADY_SETTLED');
  assert.equal(s.refuse(A, 'extend', { pid: 'p1', days: 1 }).code, 'EXTEND_ON_SETTLED');
  // The comment text stays in the log: it was never sharded and is never deleted.
  assert.equal(s.world.comments.c1.text, 'a good one');
});

test('credit below the payout floor is destroyed and the post settles anyway', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  s.wait(DAY + GRACE + 1000);

  const burnedBefore = s.world.supply.burned;
  const balanceBefore = s.world.accounts[A].ptp;
  s.land(A, 'settle', { pid: 'p1' });

  // Nobody looked at it, so there is nothing to pay — and the post still settles,
  // redacts and tombstones. If the floor gated the act instead of the payout,
  // pinning a terabyte on other members' devices forever would cost 1,006 EUR
  // once.
  assert.equal(s.world.posts.p1.state, 'settled');
  assert.equal(s.world.posts.p1.paidWei, 0n);
  assert.equal(s.world.accounts[A].ptp, balanceBefore);
  // The unclaimed escrow is destroyed rather than shared, so under-replication
  // costs money instead of paying a bonus for it.
  assert.ok(s.world.supply.burned > burnedBefore);
  // And the pot is empty, because the pot is nothing but the escrows: the CAP
  // purchase was destroyed when it was made, and this post's own escrows were
  // destroyed when it settled unproved. A pot holding a balance here would be
  // PTP no act can ever move again.
  assert.equal(s.world.capacity.potPtp, 0n);
});

test('a cid belongs to one unsettled post, so settling cannot delete a stranger\'s picture', () => {
  // What was measured: `post` never checked that a cid was unused, and
  // settlement redacts BY cid — server/index.mjs forgets the media object and
  // the client's service worker is told to drop it. So a stranger published a
  // one-day post carrying somebody else's cid for the 0.002 EUR publish fee,
  // let it lapse, settled it, and the bytes of a live thirty-day lease went off
  // every node in the network. Her viewers went on being billed full price for
  // a 404, because replay had no idea the picture was gone.
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.land(B, 'capBuy', { ptp: '2000000000000000000' });
  const cid = 'd'.repeat(64);
  s.publish(A, { cid, days: 30 });
  assert.deepEqual(Object.keys(s.world.cids), [cid]);
  assert.equal(s.world.cids[cid], 'p1');

  // The attack, refused at the door and priced at nothing.
  const stolen = s.refuse(B, 'post', {
    cid,
    bytes: 2000000,
    mime: 'image/jpeg',
    w: 1200,
    h: 1500,
    viewPriceNano: '100000',
    days: 1,
  });
  assert.equal(stolen.code, 'CID_IN_USE');
  assert.equal(stolen.detail.heldBy, 'p1');
  assert.equal(stolen.detail.cid, cid);
  // The author cannot do it to her own picture either: the same settle would
  // delete the same bytes, and whose they are does not change that.
  assert.equal(s.refuse(A, 'post', { cid, bytes: 10, mime: 'image/png', w: 1, h: 1, viewPriceNano: '100000', days: 1 }).code, 'CID_IN_USE');
  assert.equal(Object.keys(s.world.posts).length, 1);
  assert.equal(s.world.seq.post, 1);

  // A different picture is a different cid, and lands.
  s.publish(B, { cid: 'e'.repeat(64), days: 1 });
  assert.deepEqual(Object.keys(s.world.cids).sort(), [cid, 'e'.repeat(64)].sort());

  // The claim is released exactly when the bytes are: at settlement, which is
  // the act that tells every node to forget them.
  s.wait(DAY + GRACE + 1000);
  s.land(A, 'settle', { pid: 'p2' });
  assert.deepEqual(Object.keys(s.world.cids), [cid]);
  s.wait(30 * DAY);
  s.land(B, 'settle', { pid: 'p1' });
  assert.deepEqual(Object.keys(s.world.cids), []);
  // And now those bytes may be published again, by anybody.
  s.land(B, 'post', { cid, bytes: 2000000, mime: 'image/jpeg', w: 1200, h: 1500, viewPriceNano: '100000', days: 1 });
  assert.equal(s.world.cids[cid], 'p3');
});

test('a settle releases its own cid claim and never another post\'s', () => {
  // The index is keyed by cid and holds the pid, and the release checks the
  // holder. A post that never held the claim cannot free it by settling, which
  // is what stops the refusal above from being unwound by a second act.
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { cid: 'd'.repeat(64), days: 1 });
  s.publish(A, { cid: 'e'.repeat(64), days: 5 });
  s.wait(DAY + GRACE + 1000);
  s.land(A, 'settle', { pid: 'p1' });
  assert.deepEqual(Object.keys(s.world.cids), ['e'.repeat(64)]);
  assert.equal(s.world.cids['e'.repeat(64)], 'p2');
});

test('extend buys days on the lease that was bought', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  const expires = s.world.posts.p1.expires;
  s.land(A, 'extend', { pid: 'p1', days: 2 });
  assert.equal(s.world.posts.p1.expires, expires + 2 * DAY);
  assert.equal(s.world.posts.p1.capUnits, 18000000n); // 6 MB-days a day, three days
});

test('three nodes doing identical work are paid identically, in any order', () => {
  // The payout divides what is UNDRAWN by what is UNCLAIMED. Dividing by the
  // post's full funded units instead would pay the first claimant a third, the
  // second two ninths and the third four twenty-sevenths — each claim measuring
  // against an escrow the previous one had already reduced. Identical work has to
  // be worth the same amount whoever asks first.
  const s = stage();
  const nodes = [A, B, C];
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  for (const node of nodes) s.land(node, 'capPledge', { mb: 200, endpoint: `https://${node}.example` });
  s.publish(A, { bytes: 200000, days: 1 });
  const funded = s.world.posts.p1.escrow.holdingWei + s.world.posts.p1.escrow.servingWei;
  for (const node of nodes) s.land(node, 'capProof', { challenge: { pid: 'p1', shard: 0 }, answer: '1'.repeat(64) });

  const paid = [];
  for (const node of nodes) {
    const before = s.world.accounts[node].ptp;
    s.land(node, 'capClaim');
    paid.push(s.world.accounts[node].ptp - before);
  }
  assert.ok(paid[0] > 0n);
  // Equal to within the wei that integer division cannot split three ways. The
  // dust goes to whoever claims LAST, because it stays in the escrow until it is
  // divided again — the opposite bias to the naive form, and two orders of
  // magnitude smaller than the payout instead of a third of it.
  for (const p of paid) {
    const drift = p > paid[0] ? p - paid[0] : paid[0] - p;
    assert.ok(drift <= 1n, `payouts differed by ${drift} wei`);
  }
  assert.equal(paid[0] + paid[1] + paid[2], funded);
  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);
});

test('a post proved across a close cannot be drawn past what funded it', () => {
  // Proofs accrue per EPOCH and funding is per DAY of lease, and the two are the
  // same length but not the same window: a post created in the middle of an epoch
  // straddles one close more than it funded, so its shards can be proved once
  // more than its escrow was filled for. The second round must draw nothing —
  // the funding ran out, even though the service was real.
  const s = stage();
  const nodes = [A, B, C];
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  for (const node of nodes) s.land(node, 'capPledge', { mb: 200, endpoint: `https://${node}.example` });
  s.publish(A, { bytes: 200000, days: 1 }); // one shard, three replicas, one day
  const funded = s.world.posts.p1.escrow.holdingWei + s.world.posts.p1.escrow.servingWei;
  for (const node of nodes) s.land(node, 'capProof', { challenge: { pid: 'p1', shard: 0 }, answer: '1'.repeat(64) });
  for (const node of nodes) s.land(node, 'capClaim');
  assert.equal(s.world.posts.p1.claimedUnits, s.world.posts.p1.capUnits);

  // Close the epoch while the lease still has a few seconds to run, then let all
  // three prove again inside the new epoch: six shard-epochs of proof against a
  // post funded for three. More engagement money arrives in between, so the
  // escrow is NOT empty — what stops the second round is the funded budget, not
  // an empty till.
  s.land(A, 'closeEpoch', {}, DAY - 12000);
  assert.equal(s.world.epoch.n, 1);
  assert.ok(s.at < s.world.posts.p1.expires, 'the lease lapsed before the second epoch');
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  assert.ok(s.world.posts.p1.escrow.servingWei > 0n);

  for (const node of nodes) s.land(node, 'capProof', { challenge: { pid: 'p1', shard: 0 }, answer: '2'.repeat(64) });
  const heldBefore = nodes.map((n) => s.world.accounts[n].ptp);
  for (const node of nodes) assert.equal(s.refuse(node, 'capClaim').code, 'CAPACITY_POT_EMPTY');

  const post = s.world.posts.p1;
  // The first epoch's three proofs already claimed everything the post funded, so
  // the second epoch's three can draw nothing and the claim is refused rather than
  // paid as zero — which leaves those proofs standing against a later escrow
  // instead of consuming them. The stranded engagement money is bounded by one
  // epoch of a lease and is destroyed at settlement rather than paid twice.
  assert.deepEqual(nodes.map((n) => s.world.accounts[n].ptp), heldBefore);
  assert.equal(post.claimedUnits, post.capUnits);
  assert.ok(post.escrow.holdingWei >= 0n, 'the holding escrow went negative');
  assert.ok(post.escrow.servingWei >= 0n, 'the serving escrow went negative');
  assert.ok(s.world.capacity.potPtp >= 0n, 'the capacity pot went negative');
  assert.ok(funded > 0n);
  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);

  s.wait(DAY + GRACE);
  s.land(B, 'settle', { pid: 'p1' });
  assert.equal(s.world.posts.p1.escrow.servingWei, 0n);
  assert.equal(circulating(s.world), s.world.supply.emitted - s.world.supply.burned);
});

// ── capacity: what a pledge costs, wins and may prove ──────────────────────

test('a pledge is priced per identity as well as per gigabyte', () => {
  // What was measured: the bond prices MEGABYTES while placement and payment
  // rank IDENTITIES, so twenty invented node ids pledging one megabyte each
  // paid 20 × 0.0002 = 0.004 EUR — 0.02% of the 20.00 EUR one honest 100 GB
  // pledge posts — for twenty independent placements against its one.
  const s = stage();
  s.fund(A, 'alice', '900000', '250000');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  const floorNano = PARAMS.newAccountBondNanoEur;
  const perGb = (mb) => (BigInt(mb) * PARAMS.capPledgeBondNanoEurPerGb + 999n) / 1000n;

  // The smallest lawful pledge pays the per-identity floor, not the per-gigabyte
  // price of a megabyte.
  const heldBefore = s.world.accounts[B].ptp;
  s.land(B, 'capPledge', { mb: 1, endpoint: 'https://b.example' });
  assert.equal(s.world.capacity.providers[B].bondNano, floorNano);
  assert.equal(heldBefore - s.world.accounts[B].ptp, nanoEurToPtpWei(floorNano, s.world.epoch.oracle));
  assert.ok(perGb(1) < floorNano, 'the sized bond is not the smaller of the two here');

  // A second identity pays it again. That is the whole point of a per-identity
  // price: it cannot be amortised across the ids it exists to price.
  s.land(C, 'capPledge', { mb: 1, endpoint: 'https://c.example' });
  assert.equal(s.world.capacity.providers[C].bondNano, floorNano);

  // Re-announcing the same capacity is free, and growing costs the difference
  // against what this identity has already posted — never the floor twice.
  const heldAgain = s.world.accounts[B].ptp;
  s.land(B, 'capPledge', { mb: 1, endpoint: 'https://b2.example' });
  assert.equal(s.world.accounts[B].ptp, heldAgain);
  assert.equal(s.world.capacity.providers[B].endpoint, 'https://b2.example');

  // The honest 100 GB pledge, which the bond has always priced correctly.
  const beforeHonest = s.world.accounts[A].ptp;
  s.land(A, 'capPledge', { mb: 100000, endpoint: 'https://a.example' });
  const honestNano = s.world.capacity.providers[A].bondNano;
  assert.equal(honestNano, perGb(100000));
  assert.equal(honestNano, 20n * NANO_EUR_PER_EUR); // 20.00 EUR
  assert.equal(beforeHonest - s.world.accounts[A].ptp, nanoEurToPtpWei(honestNano, s.world.epoch.oracle));

  // And what a twenty-identity farm of minimum pledges now pays against it:
  // 10.00 EUR — which is the figure docs/ECONOMICS.md quotes for exactly this
  // attack, and which was only true before if each invented id pledged 2.5 GB.
  const farmNano = 20n * floorNano;
  assert.equal(farmNano, 10n * NANO_EUR_PER_EUR);
  assert.equal(farmNano * 2n, honestNano);
  // The old price of the same farm, for the record: 0.004 EUR, two hundredths
  // of one percent of the honest pledge.
  assert.equal(20n * perGb(1), 4000000n);
  assert.equal((20n * perGb(1) * 10000n) / honestNano, 2n); // 2 basis points
});

test('rendezvous placement follows pledged megabytes, not the count of node ids', () => {
  // Placement is a pure function of the pledged set, so it is measured here
  // directly, over two hundred pictures, against the unweighted ranking that
  // was there before. `cid` is any 64-hex string: placement hashes it and does
  // not care that these ones were counted rather than hashed.
  const honest = '0x' + 'a'.repeat(40);
  const invented = [];
  for (let n = 0; n < 20; n += 1) invented.push('0x' + (n + 1).toString(16).padStart(40, '0'));
  const providers = Object.create(null);
  providers[honest] = { mb: 100000 }; // 100 GB
  for (const id of invented) providers[id] = { mb: 1 };
  const world = { constants: PARAMS, capacity: { providers } };
  const ids = Object.keys(providers);
  const cidOf = (n) => n.toString(16).padStart(64, '0');

  let weighted = 0;
  let flat = 0;
  for (let n = 0; n < 200; n += 1) {
    if (placementFor(world, cidOf(n), 0, 3).includes(honest)) weighted += 1;
    if (placeShard(ids, cidOf(n), 0, 3).includes(honest)) flat += 1;
  }
  // Unweighted, the device holding a hundred gigabytes is one node id in
  // twenty-one and wins three replica slots in twenty-one — about 14%, whatever
  // it pledged. Weighted, it holds most of the network's bytes and holds most
  // of its shards.
  assert.ok(flat < 70, `the unweighted ranking already favoured the pledge: ${flat}/200`);
  assert.ok(weighted > 150, `weighting placed the honest node only ${weighted} times in 200`);
  assert.ok(weighted > flat * 3, `weighting barely moved the ranking: ${flat} -> ${weighted}`);

  // And it is LINEAR in the pledge rather than merely monotone: ten gigabytes
  // against one wins about ten shards in eleven at the top of the ranking.
  const big = '0x' + 'b'.repeat(40);
  const small = '0x' + 'c'.repeat(40);
  const pair = Object.create(null);
  pair[big] = { mb: 10 * MB_PER_PLACEMENT_SLOT };
  pair[small] = { mb: MB_PER_PLACEMENT_SLOT };
  const two = { constants: PARAMS, capacity: { providers: pair } };
  let bigFirst = 0;
  for (let n = 0; n < 330; n += 1) {
    if (placementFor(two, cidOf(n), 0, 1)[0] === big) bigFirst += 1;
  }
  // 10/11 of 330 is 300. The window is wide because 330 samples of a fair coin
  // are noisy; it is narrow enough to fail both the unweighted ranking (165)
  // and a multiplicative one, which would take nearly everything.
  assert.ok(bigFirst > 255 && bigFirst < 325, `the ten-gigabyte node took ${bigFirst}/330`);

  // A pledge of nothing is not a node: it is a withdrawal, and it is not ranked.
  pair[small] = { mb: 0 };
  assert.deepEqual(placementFor(two, cidOf(1), 0, 3), [big]);
});

test('a provider cannot prove more megabyte-days in a day than it pledged', () => {
  // What was measured: nothing bounded proven MB-days by pledged MB, so an
  // identity announcing one megabyte could answer for every placement it won
  // and draw against all of them. One CAP is one MB-day and an epoch is a day,
  // so the honest ceiling is mb × capCoinPerMbDay between two closes.
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.land(A, 'capPledge', { mb: 1, endpoint: 'https://a.example' });
  s.publish(A, { bytes: 2000000, days: 3 }); // eight shards of 256 KiB

  const allowance = 1n * PARAMS.capCoinPerMbDay;
  const perShard = 262144n; // 256 KiB at one CAP unit per byte-millionth of an MB-day
  for (let shard = 0; shard < 3; shard += 1) {
    s.land(A, 'capProof', { challenge: { pid: 'p1', shard }, answer: '1'.repeat(64) });
  }
  assert.equal(s.world.capacity.providers[A].provenInEpoch, perShard * 3n);
  assert.ok(perShard * 4n > allowance);

  const over = s.refuse(A, 'capProof', { challenge: { pid: 'p1', shard: 3 }, answer: '1'.repeat(64) });
  assert.equal(over.code, 'CAPACITY_OVER_PLEDGE');
  assert.equal(over.detail.allowance, allowance);
  assert.equal(over.detail.pledgedMb, 1);
  assert.equal(s.world.capacity.providers[A].proven, perShard * 3n, 'a refused proof still accrued');

  // The ceiling is a day's work and not a lifetime: the next epoch starts the
  // allowance again, and the lifetime total keeps counting.
  s.land(A, 'closeEpoch', {}, DAY);
  s.land(A, 'capProof', { challenge: { pid: 'p1', shard: 3 }, answer: '1'.repeat(64) });
  assert.equal(s.world.capacity.providers[A].provenInEpoch, perShard);
  assert.equal(s.world.capacity.providers[A].proven, perShard * 4n);

  // Pledging more raises it, which is what makes the bond the price of the
  // ceiling rather than a toll on announcing.
  s.land(A, 'capPledge', { mb: 100, endpoint: 'https://a.example' });
  for (let shard = 4; shard < 8; shard += 1) {
    s.land(A, 'capProof', { challenge: { pid: 'p1', shard }, answer: '1'.repeat(64) });
  }
  // Shards 3 to 7 of a 2 MB picture. The last shard is short and is never
  // padded, so a full round over every shard is exactly 2,000,000 units — two
  // megabyte-days for two megabytes, which is what the unit means.
  assert.equal(s.world.capacity.providers[A].provenInEpoch, 2000000n - perShard * 3n);
  assert.ok(s.world.capacity.providers[A].provenInEpoch < 100n * PARAMS.capCoinPerMbDay);
});

// ── distribution ───────────────────────────────────────────────────────────

test('the epoch mints exactly the rebate on the burn each creator caused', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.fund(C, 'carol');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 2 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(C, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'like', { pid: 'p1' });
  s.land(C, 'comment', { pid: 'p1', text: 'clean' });

  // What the rules module says, computed independently of what replay charged.
  const credited = creditV1(s.world, s.world.epoch.acts);
  const rate = s.world.epoch.oracle;
  const price = (kind) => nanoEurToPtpWei(actionPriceNanoEur(PARAMS.viewPriceDefaultNanoEur, kind, PARAMS), rate);
  const burnOf = (kind) => splitFee(price(kind), SPLIT_VECTORS.fee).burn;
  const expected = burnOf('view') * 2n + burnOf('like') + burnOf('comment');
  assert.equal(credited.get(A), expected);
  assert.equal(credited.size, 1);

  // The publish fee's burn is NOT credited: a poster's own spending must not
  // rebate to the poster, or publishing becomes a faucet with no viewer in it.
  assert.ok(s.world.epoch.burnedWei > expected);

  const before = s.world.accounts[A].ptp;
  const emittedBefore = s.world.supply.emitted;
  s.land(A, 'closeEpoch', {}, DAY);
  const minted = s.world.accounts[A].ptp - before;
  assert.equal(minted, creatorRebate(expected));
  assert.equal(minted, (PARAMS.emissionCapBps * expected) / 10000n);
  assert.equal(s.world.supply.emitted - emittedBefore, minted);
  // Under the coupled rule the schedule rail is far above a real epoch's burn,
  // so nothing was withheld here — but it is still a min(), and it can only ever
  // lower emission.
  assert.ok(minted < PARAMS.epochEmissionPtp * WAD);
  assert.equal(s.world.epoch.n, 1);
  assert.equal(s.world.epoch.burnedWei, 0n);
  assert.equal(s.world.history.length, 1);
});

test('a post that settles inside an epoch still credits its author at the close', () => {
  // An epoch advances only when a closeEpoch act lands, so an epoch can outlive a
  // post: the lease runs out, the picture is redacted and tombstoned, and the
  // epoch it earned in has still not been cut. The rules module reads the post
  // for its author and its price, so the record has to survive the redaction —
  // and it does, because redaction takes the payload and leaves the structure.
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  s.land(B, 'like', { pid: 'p1' });
  const credited = creditV1(s.world, s.world.epoch.acts).get(A);
  assert.ok(credited > 0n);

  s.wait(DAY + GRACE + 1000);
  s.land(B, 'settle', { pid: 'p1' });
  assert.equal(s.world.posts.p1.state, 'settled');
  assert.equal(s.world.epoch.n, 0);
  assert.equal(creditV1(s.world, s.world.epoch.acts).get(A), credited);

  const before = s.world.accounts[A].ptp;
  s.land(A, 'closeEpoch');
  assert.equal(s.world.accounts[A].ptp - before, creatorRebate(credited));
});

test('self-engagement is refused, so it can never be credited', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });
  assert.equal(s.refuse(A, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 }).code, 'SELF_ENGAGEMENT');
  assert.equal(s.refuse(A, 'like', { pid: 'p1' }).code, 'SELF_ENGAGEMENT');
  assert.equal(s.refuse(A, 'comment', { pid: 'p1', text: 'mine' }).code, 'SELF_ENGAGEMENT');

  // And if one somehow reached the rules module, it would still count nothing:
  // the module is a pure function of the acts it is given and assumes no gate ran
  // upstream.
  const smuggled = [{ i: 999, t: s.at, as: A, k: 'like', pid: 'p1' }];
  assert.equal(creditV1(s.world, smuggled).size, 0);
});

test('an epoch that burned nothing emits nothing', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.land(A, 'closeEpoch', {}, DAY);
  assert.equal(s.world.supply.emitted, PARAMS.genesisPtpWei);
  assert.equal(s.world.epoch.n, 1);
});

// ── the rule key ───────────────────────────────────────────────────────────

test('a rules change names a future epoch and takes effect at that close', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(KEY, 'keyholder');

  // Replay is the real gate: the contract compares fromEpoch against a sealed
  // horizon that lags the true epoch, so the strict check lives here where the
  // world knows what epoch it is.
  assert.equal(s.refuse(KEY, 'rulesSet', { version: 'v1', hash: '0'.repeat(64), fromEpoch: 0 }).code, 'RULES_EPOCH_PAST');
  assert.equal(s.refuse(A, 'rulesSet', { version: 'v1', hash: '0'.repeat(64), fromEpoch: 2 }).code, 'RULES_KEY_ONLY');

  s.land(KEY, 'rulesSet', { version: 'v1', hash: 'a'.repeat(64), fromEpoch: 2 });
  assert.equal(s.world.rules.next.fromEpoch, 2);
  assert.equal(s.world.rules.hash, '');

  s.land(A, 'closeEpoch', {}, DAY);
  assert.equal(s.world.epoch.n, 1);
  assert.equal(s.world.rules.hash, '', 'a change took effect before the epoch it named');
  s.land(A, 'closeEpoch', {}, DAY);
  assert.equal(s.world.epoch.n, 2);
  assert.equal(s.world.rules.hash, 'a'.repeat(64));
  assert.equal(s.world.rules.setBy, KEY);
  assert.equal(s.world.rules.next, null);
});

test('the rule key cannot mint, move a balance or touch the pool', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(KEY, 'keyholder');
  // Every number money can be in. The act counter is deliberately not here: the
  // act happened and the log says so, which is the point of the log.
  const money = (w) =>
    canonicalJson({
      balances: Object.fromEntries(
        Object.entries(w.accounts).map(([addr, r]) => [addr, { ptp: r.ptp, sat: r.sat, cap: r.cap, shares: r.shares }]),
      ),
      pool: w.pool,
      supply: w.supply,
      treasury: w.treasury,
      capacity: { potPtp: w.capacity.potPtp, bondsPtp: w.capacity.bondsPtp },
    });
  const before = money(s.world);
  s.land(KEY, 'rulesSet', { version: 'v1', hash: 'b'.repeat(64), fromEpoch: 9 });
  const after = money(s.world);
  // The act that changes the rules changes exactly one field of the world, and
  // it is the schedule. Everything money touches is byte-identical.
  assert.equal(after, before);
});

// ── the underflow rule ─────────────────────────────────────────────────────

test('a priced act that converts at the underflow floor is recorded as dust', () => {
  // ARCHITECTURE §3: a non-zero price never converts to zero wei — at the floor
  // it converts to 1 wei "and the caller records a dust flag". core/pricing.mjs
  // computes the flag; until now nothing in the rulebook wrote it down, so the
  // one state the rule exists for was the one state nothing recorded.
  //
  // Reaching it takes a token worth about 1e18 times its genesis price against
  // this pool, which is why the flag is asserted here rather than assumed: at
  // the floor every price in the network — a view, a like, a comment, the
  // publish fee — is the same single wei, which is 9e-20 EUR at genesis and is
  // the sybil faucet the underflow rule was written to prevent. A counter that
  // rises is the only warning the state gives.
  const ordinary = stage();
  ordinary.fund(A, 'alice');
  ordinary.land(A, 'capBuy', { ptp: '2000000000000000000' });
  ordinary.publish(A, { days: 1 });
  assert.equal(ordinary.world.log.dust, 0, 'a normal epoch recorded dust');
  assert.equal(ordinary.world.posts.p1.dust, false);

  const huge = 90000n * NANO_EUR_PER_EUR * 1000000000000000000n;
  const s = stage({ ...PARAMS, ruleKey: KEY, genesisEurPerBtcNano: huge });
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  // A euro buys almost nothing here, so a wei is worth a fortune and CAP is
  // nearly free — the same rational read from the other end.
  s.land(A, 'capBuy', { ptp: '1' });
  assert.ok(s.world.accounts[A].cap > 0n);

  s.publish(A, { days: 1 });
  assert.equal(s.world.log.dust, 1, 'the publish fee floored and nothing said so');
  assert.equal(s.world.posts.p1.dust, true);
  // The whole publish — 0.002 EUR of fee and a day of rent on 2 MB — cost two
  // wei, one for each conversion that hit the floor.
  assert.equal(nanoEurToPtpWei(PARAMS.publishBaseFeeNanoEur, s.world.epoch.oracle), 1n);

  s.land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });
  assert.equal(s.world.log.dust, 2);
  s.land(B, 'like', { pid: 'p1' });
  assert.equal(s.world.log.dust, 3);
  // The pledge bond is priced through the same conversion and is recorded the
  // same way — but at 0.50 EUR it is two hundred and fifty times the publish
  // fee and still clears the floor even here, so the counter does not move. A
  // counter that counted priced acts rather than floored ones would say four.
  s.land(B, 'capPledge', { mb: 1, endpoint: 'https://b.example' });
  assert.equal(s.world.log.dust, 3);
  assert.equal(s.world.capacity.bondsPtp, 5n);

  // And it survives a replay of the same log, because it is a fact about the
  // acts and not a fact about the machine that read them.
  const again = replay(s.acts, { ...PARAMS, ruleKey: KEY, genesisEurPerBtcNano: huge });
  assert.equal(again.log.dust, 3);
  assert.equal(again.posts.p1.dust, true);
});

// ── the two readers ────────────────────────────────────────────────────────

test('actError and applyAct agree, act for act', () => {
  const s = stage();
  s.fund(A, 'alice');
  s.fund(B, 'bob');
  s.land(A, 'capBuy', { ptp: '2000000000000000000' });
  s.publish(A, { days: 1 });

  const good = { i: 100, t: s.at + 1000, as: B, k: 'view', pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 };
  assert.equal(actError(s.world, good), null);
  assert.equal(applyAct(s.world, good).ok, true);

  const bad = { i: 101, t: s.at + 2000, as: B, k: 'view', pid: 'p1', dwellMs: 2000, seq: 2, vp: 80 };
  const problem = actError(s.world, bad);
  assert.equal(problem.code, 'VIEW_TOO_SOON');
  assert.equal(applyAct(s.world, bad).code, 'VIEW_TOO_SOON');
  // The browser asks the same function before offering the button, so the
  // sentence on the screen is the sentence the server would have sent.
  assert.equal(typeof problem.why, 'string');
  assert.equal(typeof problem.next, 'string');
});

test('a log with a bad act in it is replayed, not abandoned', () => {
  const s = stage();
  s.fund(A, 'alice');
  const poisoned = [...s.acts, { i: 99, t: T0 + 999999, as: A, k: 'mint' }, { i: 100, t: T0 + 1000000, as: A, k: 'capClaim' }];
  const w = replay(poisoned, PARAMS);
  assert.equal(w.log.skipped, 2);
  assert.equal(Object.keys(w.accounts).length, 1);
  // One malformed line must not be able to stop every reader in the network at
  // the same place, which is what throwing here would do.
});

test('an address is one account however it is spelled', () => {
  const s = stage();
  const mixed = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  s.land(mixed, 'register', { handle: 'alice' });
  assert.ok(s.world.accounts[A]);
  assert.equal(Object.keys(s.world.accounts).length, 1);
  assert.equal(s.refuse(A, 'register', { handle: 'alice2' }).code, 'ALREADY_REGISTERED');
});
