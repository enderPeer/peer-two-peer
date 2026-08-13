// The price surface, and the arithmetic bug it exists to close.
//
// docs/ECONOMICS.md states the finding as flatly as it can be stated: "Every fee
// in this document, as originally specified, does not exist." The two-hop rope in
// ARCHITECTURE §3 — nanoeuro to integer satoshi to wei — truncates every
// sub-satoshi price in this economy to zero, at every token price, because the
// failure is on the bitcoin side and has nothing to do with what PTP is worth.
//
// So this file does not only check that the fused form works. It checks that the
// broken form is still broken, at every price, so that nobody can "simplify" the
// conversion back into two hops and have the suite stay green.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PARAMS, BPS, SAT_PER_BTC, NANO_EUR_PER_EUR } from '../core/params.mjs';
import {
  SPLIT_VECTORS,
  actionPriceNanoEur,
  formatEur,
  nanoEurToPtpWei,
  nanoEurToSubSat,
  priceOf,
  ptpWeiToNanoEur,
  sealRate,
  splitFee,
  splitVectorsOf,
} from '../core/pricing.mjs';

// The reference rate every worked example in docs/ECONOMICS.md is computed at.
const EUR_PER_BTC_NANO = 90000n * NANO_EUR_PER_EUR;

/**
 * A rate at `m` times the genesis token price.
 *
 * Genesis is 1,000,000 sat against 10,000 PTP — 100 sat per PTP. Multiplying the
 * satoshi side by `m` multiplies the price of PTP by `m` and divides the wei a
 * nanoeuro buys by the same factor, which is exactly the sweep ECONOMICS.md ran:
 * 1×, 10×, 100×, 1000× and 1,000,000× the genesis price.
 */
function rateAt(m) {
  return {
    eurPerBtcNano: EUR_PER_BTC_NANO,
    poolSat: PARAMS.genesisSat * m,
    poolPtpWei: PARAMS.genesisPtpWei,
    epoch: 0,
  };
}

const MULTIPLIERS = [1n, 10n, 100n, 1000n, 1000000n];

// Every priced item in the economy, as a euro price. Likes and comments are
// multiples of the poster's own view price, so they appear once per band edge.
const view = (p) => actionPriceNanoEur(p, 'view', PARAMS);
const like = (p) => actionPriceNanoEur(p, 'like', PARAMS);
const comment = (p) => actionPriceNanoEur(p, 'comment', PARAMS);
const MIN = PARAMS.viewPriceMinNanoEur;
const DEF = PARAMS.viewPriceDefaultNanoEur;
const MAX = PARAMS.viewPriceMaxNanoEur;

const ITEMS = [
  ['view, floor', view(MIN)],
  ['view, default', view(DEF)],
  ['view, ceiling', view(MAX)],
  ['like, at the floor', like(MIN)],
  ['like, at the default', like(DEF)],
  ['like, at the ceiling', like(MAX)],
  ['comment, at the floor', comment(MIN)],
  ['comment, at the default', comment(DEF)],
  ['comment, at the ceiling', comment(MAX)],
  ['publish base fee', PARAMS.publishBaseFeeNanoEur],
  ['storage rent, per MB-day', PARAMS.storageRentNanoEurPerMbDay],
  ['storage rent, 2 MB × 3 replicas', PARAMS.storageRentNanoEurPerMbDay * 6n],
  ['settlement floor', PARAMS.minSettlementNanoEur],
  ['account bond', PARAMS.newAccountBondNanoEur],
];

/**
 * The two-hop rope, exactly as ARCHITECTURE §3 first specified it: nanoeuros to
 * an INTEGER satoshi, then satoshis to wei through the pool ratio.
 *
 * It lives in the test rather than in core/pricing.mjs on purpose. Shipping a
 * deliberately broken conversion beside the correct one is how the broken one
 * eventually gets called; keeping it here means the defect is measured and can
 * never be imported.
 */
function twoHopPtpWei(nanoEur, rate) {
  const sat = (nanoEur * SAT_PER_BTC) / rate.eurPerBtcNano; // hop one, truncating
  return (sat * rate.poolPtpWei) / rate.poolSat; // hop two
}

test('the fused rational reproduces the published wei, to the wei', () => {
  const rate = rateAt(1n);
  // docs/ECONOMICS.md, "The arithmetic bug both reviews found".
  assert.equal(nanoEurToPtpWei(20000n, rate), 222222222222222n);
  assert.equal(nanoEurToPtpWei(100000n, rate), 1111111111111111n);
  assert.equal(nanoEurToPtpWei(400000n, rate), 4444444444444444n);
  assert.equal(nanoEurToPtpWei(2000n, rate), 22222222222222n);
  assert.equal(nanoEurToPtpWei(1000000n, rate), 11111111111111111n);
  assert.equal(nanoEurToPtpWei(2000000n, rate), 22222222222222222n);
});

test('no priced item converts to zero, at any token price', () => {
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of ITEMS) {
      const { wei, dust } = priceOf(nanoEur, rate);
      assert.ok(wei > 0n, `${name} at ${m}× genesis converted to ${wei}`);
      assert.equal(dust, false, `${name} at ${m}× genesis reached the dust floor`);
    }
  }
});

test('the smallest value the fused form produces anywhere is 22,222,222 wei', () => {
  // ECONOMICS.md states this figure as the floor of the whole sweep. It is the
  // storage rent for one MB-day at a million times the genesis price.
  let smallest = null;
  for (const m of MULTIPLIERS) {
    for (const [, nanoEur] of ITEMS) {
      const wei = nanoEurToPtpWei(nanoEur, rateAt(m));
      if (smallest === null || wei < smallest) smallest = wei;
    }
  }
  assert.equal(smallest, 22222222n);
});

test('the two-hop rope is zero for every sub-satoshi price, at every token price', () => {
  // At 90,000 EUR/BTC one satoshi is 900,000 nanoeuros, so every price below that
  // truncates to zero satoshis and the second hop multiplies zero. Twenty cells,
  // four distinct prices across five token prices, and every one of them is zero.
  const subSatoshi = [
    ['view, floor', 20000n],
    ['view, default', 100000n],
    ['view, ceiling', 400000n],
    ['storage rent, per MB-day', 2000n],
  ];
  let cells = 0;
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of subSatoshi) {
      assert.equal(twoHopPtpWei(nanoEur, rate), 0n, `${name} at ${m}× genesis was not zero`);
      assert.ok(nanoEurToPtpWei(nanoEur, rate) > 0n, `${name} at ${m}× genesis: fused zeroed too`);
      cells += 1;
    }
  }
  assert.equal(cells, 20);
});

test('the fused result differs from the two-hop result for every priced item', () => {
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of ITEMS) {
      const fused = nanoEurToPtpWei(nanoEur, rate);
      const roped = twoHopPtpWei(nanoEur, rate);
      assert.notEqual(fused, roped, `${name} at ${m}× genesis: the two forms agreed`);
      assert.ok(roped < fused, `${name} at ${m}× genesis: the rope over-charged`);
    }
  }
});

test('where the rope does not zero a price it under-charges by about 10%', () => {
  // The items at or above one satoshi survive the first hop and are still wrong:
  // a like is 1.1111 sat and a comment 2.2222, so the truncation to a whole
  // satoshi takes 10% and 10% respectively. ECONOMICS.md records both.
  const rate = rateAt(1n);
  for (const nanoEur of [1000000n, 2000000n, 4000000n, 8000000n]) {
    const fused = nanoEurToPtpWei(nanoEur, rate);
    const roped = twoHopPtpWei(nanoEur, rate);
    const shortfallBps = ((fused - roped) * BPS) / fused;
    assert.ok(shortfallBps > 900n && shortfallBps < 1100n, `shortfall was ${shortfallBps} bps`);
  }
});

test('the underflow rule: a non-zero price never becomes free', () => {
  // A pool skewed far enough that a nanoeuro buys less than a wei. The rule is
  // what stands between truncation and a free view, and a free view is a sybil
  // faucet: 1 wei at the genesis price is 9.0e-20 EUR, a discount of 1.1e15.
  const skewed = { eurPerBtcNano: EUR_PER_BTC_NANO, poolSat: 10n ** 30n, poolPtpWei: 1n, epoch: 0 };
  const q = priceOf(PARAMS.viewPriceDefaultNanoEur, skewed);
  assert.equal(q.wei, 1n);
  assert.equal(q.dust, true);
  assert.equal(nanoEurToPtpWei(PARAMS.viewPriceDefaultNanoEur, skewed), 1n);
  // Zero euros is zero wei and is not dust: the rule is about a price that
  // silently becomes free, not about a quantity that was never priced.
  assert.deepEqual(priceOf(0n, rateAt(1n)), { nanoEur: 0n, wei: 0n, dust: false });
});

test('splitFee conserves to the wei, at every price and in both vectors', () => {
  const vectors = [
    ['fee', SPLIT_VECTORS.fee],
    ['publish', SPLIT_VECTORS.publish],
  ];
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of ITEMS) {
      const wei = nanoEurToPtpWei(nanoEur, rate);
      for (const [vname, vector] of vectors) {
        const s = splitFee(wei, vector);
        assert.equal(
          s.creator + s.burn + s.capacity + s.treasury,
          wei,
          `${name} at ${m}× genesis under the ${vname} vector did not conserve`,
        );
        for (const [leg, value] of Object.entries(s)) {
          assert.equal(typeof value, 'bigint', `${leg} was not a bigint`);
          assert.ok(value >= 0n, `${leg} was negative`);
        }
      }
    }
  }
});

test('the remainder goes to burn, never to a payout', () => {
  // 10001 wei against the fee vector: creator 4000.4, capacity 300.03, treasury
  // 2100.21, all floored. Everything the flooring leaves over is destroyed, which
  // is the one destination no account can be paid from.
  const s = splitFee(10001n, SPLIT_VECTORS.fee);
  assert.equal(s.creator, 4000n);
  assert.equal(s.capacity, 300n);
  assert.equal(s.treasury, 2100n);
  assert.equal(s.burn, 3601n); // 3600.36 floored is 3600; the extra wei is dust
  assert.equal(s.creator + s.burn + s.capacity + s.treasury, 10001n);

  // Every amount from 1 to 400 wei: the three payout legs are never larger than
  // their exact share, and the burn carries the whole remainder.
  for (let wei = 1n; wei <= 400n; wei += 1n) {
    const t = splitFee(wei, SPLIT_VECTORS.fee);
    assert.equal(t.creator + t.burn + t.capacity + t.treasury, wei);
    assert.ok(t.creator * BPS <= wei * SPLIT_VECTORS.fee.creator);
    assert.ok(t.capacity * BPS <= wei * SPLIT_VECTORS.fee.capacity);
    assert.ok(t.treasury * BPS <= wei * SPLIT_VECTORS.fee.treasury);
    assert.ok(t.burn * BPS >= wei * SPLIT_VECTORS.fee.burn);
  }
});

test('the publish vector pays no creator, and both vectors sum to 10000', () => {
  for (const v of [SPLIT_VECTORS.fee, SPLIT_VECTORS.publish]) {
    assert.equal(v.creator + v.burn + v.capacity + v.treasury, BPS);
  }
  assert.equal(SPLIT_VECTORS.publish.creator, 0n);
  const s = splitFee(1000000n, SPLIT_VECTORS.publish);
  assert.equal(s.creator, 0n);
  assert.equal(s.burn + s.capacity + s.treasury, 1000000n);
});

test('a vector that does not sum to 10000 is refused rather than scaled', () => {
  assert.throws(() => splitFee(100n, { creator: 5000n, burn: 5000n, capacity: 1n, treasury: 0n }), /BAD_AMOUNT/);
  assert.throws(() => splitFee(100n, { creator: -1n, burn: 10001n, capacity: 0n, treasury: 0n }), /BAD_AMOUNT/);
  assert.throws(() => splitFee(-1n, SPLIT_VECTORS.fee), /BAD_AMOUNT/);
});

test('the price surface follows the poster: a like is 10× a view, a comment 20×', () => {
  for (const p of [MIN, DEF, MAX]) {
    assert.equal(actionPriceNanoEur(p, 'view', PARAMS), p);
    assert.equal(actionPriceNanoEur(p, 'like', PARAMS), p * 10n);
    assert.equal(actionPriceNanoEur(p, 'comment', PARAMS), p * 20n);
  }
  assert.throws(() => actionPriceNanoEur(DEF, 'settle', PARAMS), /BAD_AMOUNT/);
});

test('the round trip loses at most one nanoeuro', () => {
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of ITEMS) {
      const back = ptpWeiToNanoEur(nanoEurToPtpWei(nanoEur, rate), rate);
      const drift = back > nanoEur ? back - nanoEur : nanoEur - back;
      assert.ok(drift <= 1n, `${name} at ${m}× genesis drifted ${drift} n€`);
    }
  }
});

test('a non-zero PTP quantity never displays as zero euros', () => {
  const rate = rateAt(1n);
  assert.equal(ptpWeiToNanoEur(1n, rate), 1n); // 9.0e-20 EUR, floored to one nanoeuro
  assert.equal(ptpWeiToNanoEur(0n, rate), 0n);
});

test('the satoshi hop stays public, and is exact at the sub-satoshi scale', () => {
  // ECONOMICS.md: at 1e8 sub-satoshi resolution the view price floor is 2,222,222
  // units. Publishing the hop is required; settling money through it is not.
  assert.equal(nanoEurToSubSat(20000n, EUR_PER_BTC_NANO), 2222222n);
  assert.equal(nanoEurToSubSat(100000n, EUR_PER_BTC_NANO), 11111111n);
  assert.equal(nanoEurToSubSat(2000n, EUR_PER_BTC_NANO), 222222n);
});

test('formatEur never shows a false zero', () => {
  // The separators are written as escapes because they are not ordinary spaces
  // and must not become ordinary spaces: a narrow no-break space between digit
  // groups and a no-break space before the sign, so a price can never wrap across
  // a line and be read as two numbers.
  const G = ' ';
  const S = ' ';
  assert.equal(formatEur(20000n), `0.000${G}02${S}€`);
  assert.equal(formatEur(100000n), `0.000${G}1${S}€`);
  assert.equal(formatEur(1n), `0.000${G}000${G}001${S}€`);
  assert.equal(formatEur(0n), `0.00${S}€`);
  assert.equal(formatEur(5000000000n), `5.00${S}€`);
  assert.equal(formatEur(1200000000n), `1.20${S}€`);
  assert.equal(formatEur(41000000n), `0.041${S}€`);
  assert.equal(formatEur(-500000n), `-0.000${G}5${S}€`);
  assert.equal(formatEur(1234567890123n), `1${G}234.567${G}890${G}123${S}€`);
  assert.equal(formatEur('100000'), `0.000${G}1${S}€`);

  // The property, over every priced item and every price: a non-zero amount
  // always shows a non-zero digit.
  for (const m of MULTIPLIERS) {
    const rate = rateAt(m);
    for (const [name, nanoEur] of ITEMS) {
      const shown = formatEur(nanoEur);
      assert.ok(/[1-9]/.test(shown), `${name} printed as ${shown}`);
      const back = formatEur(ptpWeiToNanoEur(nanoEurToPtpWei(nanoEur, rate), rate));
      assert.ok(/[1-9]/.test(back), `${name} at ${m}× genesis round-tripped to ${back}`);
    }
  }
});

test('formatEur refuses a Number, because a Number is a different amount', () => {
  assert.throws(() => formatEur(20000), /BAD_AMOUNT/);
  assert.throws(() => formatEur(1.5), /BAD_AMOUNT/);
  assert.throws(() => formatEur('1e5'), /BAD_AMOUNT/);
});

test('sealRate freezes both legs, takes a median, and clamps the move', () => {
  const pool = { sat: PARAMS.genesisSat, ptp: PARAMS.genesisPtpWei, shares: 1n, locked: 0n };
  const flat = sealRate(pool, { eurPerBtcNano: EUR_PER_BTC_NANO, epoch: 7 });
  assert.deepEqual(
    { ...flat },
    {
      eurPerBtcNano: EUR_PER_BTC_NANO,
      poolSat: PARAMS.genesisSat,
      poolPtpWei: PARAMS.genesisPtpWei,
      epoch: 7,
    },
  );

  // Five sources, median taken, not the mean and not the first.
  const sources = [80n, 100n, 90000n, 91000n, 89000n].map((v) => ({ eurPerBtcNano: v * NANO_EUR_PER_EUR }));
  assert.equal(sealRate(pool, { sources, epoch: 1 }).eurPerBtcNano, 89000n * NANO_EUR_PER_EUR);

  // Below the quorum there is no rate, and a rate nobody sealed is refused rather
  // than guessed.
  assert.throws(() => sealRate(pool, { sources: sources.slice(0, 2), epoch: 1 }), /ORACLE_STALE/);
  assert.throws(() => sealRate(pool, { epoch: 1 }), /ORACLE_STALE/);
  assert.throws(() => sealRate({ sat: 0n, ptp: 0n }, { eurPerBtcNano: 1n, epoch: 1 }), /POOL_EMPTY/);

  // ±10% an epoch. A doubling arrives clamped, and a sustained 2× distortion
  // therefore costs eight epochs of public lying.
  const clampedUp = sealRate(pool, {
    eurPerBtcNano: EUR_PER_BTC_NANO * 2n,
    prevEurPerBtcNano: EUR_PER_BTC_NANO,
    epoch: 2,
  });
  assert.equal(clampedUp.eurPerBtcNano, (EUR_PER_BTC_NANO * 11000n) / BPS);
  const clampedDown = sealRate(pool, {
    eurPerBtcNano: 1n,
    prevEurPerBtcNano: EUR_PER_BTC_NANO,
    epoch: 2,
  });
  assert.equal(clampedDown.eurPerBtcNano, (EUR_PER_BTC_NANO * 9000n) / BPS);
});

test('a sealed rate is frozen, so an epoch cannot be repriced under a reader', () => {
  const pool = { sat: PARAMS.genesisSat, ptp: PARAMS.genesisPtpWei, shares: 1n, locked: 0n };
  const rate = sealRate(pool, { eurPerBtcNano: EUR_PER_BTC_NANO, epoch: 3 });
  assert.throws(() => {
    'use strict';
    rate.eurPerBtcNano = 1n;
  }, TypeError);
});

test('splitVectorsOf reads the edition it is given, not the shipped one', () => {
  const alternative = { ...PARAMS, splitCreatorBps: 4000n, splitBurnBps: 4200n, splitCapacityBps: 300n, splitTreasuryBps: 1500n };
  const v = splitVectorsOf(alternative).fee;
  assert.equal(v.burn, 4200n);
  assert.equal(v.creator + v.burn + v.capacity + v.treasury, BPS);
  // The shipped edition is untouched by the question.
  assert.equal(SPLIT_VECTORS.fee.burn, PARAMS.splitBurnBps);
});
