// The pool's arithmetic, checked against the properties it is supposed to have
// rather than against itself.
//
// Two things are asserted everywhere: that k never falls, because a falling k
// is liquidity leaving the pool through a rounding error, and that every
// refusal is a refusal — an Error carrying a stable code — rather than a
// number that happens to be zero.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BPS,
  WAD,
  FEE_BPS,
  MINIMUM_LIQUIDITY,
  GENESIS_SAT,
  GENESIS_PTP,
  isqrt,
  amountOut,
  amountIn,
  spotSatPerPtp,
  quote,
  addLiquidity,
  removeLiquidity,
  genesisPool,
} from '../core/amm.mjs';

// The euro figures in these tests need a BTC price to become satoshis. One BTC
// = 100 000 EUR is assumed here and nowhere else, purely so the arithmetic is
// legible: it makes 1 EUR exactly 1000 sat, so the genesis pool holds 1000 EUR
// of bitcoin, a 0.09 EUR trade is 90 sat and a 90 EUR trade is 90 000 sat. The
// real rate comes from the signed oracle (ARCHITECTURE §3); nothing in
// core/amm.mjs knows or cares what a euro is.
const SAT_PER_EUR = 1000n;

const k = (p) => p.sat * p.ptp;

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);
}

test('integer sqrt is exact, including past 2^53', () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(2n), 1n);
  assert.equal(isqrt(3n), 1n);
  assert.equal(isqrt(4n), 2n);
  assert.equal(isqrt(99n), 9n);
  assert.equal(isqrt(100n), 10n);
  // The genesis product. A double would have rounded this.
  assert.equal(isqrt(10n ** 28n), 10n ** 14n);
  assert.equal(isqrt(10n ** 28n - 1n), 10n ** 14n - 1n);
  for (let n = 0n; n < 4096n; n++) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`);
  }
  throwsCode(() => isqrt(-1n), 'BAD_AMOUNT');
});

test('k never decreases across a swap, in either direction', () => {
  const pool = genesisPool();
  const before = k(pool);
  for (const amount of [1n, 3n, 90n, 1000n, 90000n, 500000n]) {
    const r = quote(pool, 'btc', amount, FEE_BPS);
    assert.ok(k(r.newPool) > before, `buying with ${amount} sat must grow k`);
    assert.equal(r.newPool.shares, pool.shares);
    assert.equal(r.newPool.locked, pool.locked);
  }
  for (const amount of [WAD / 10n, WAD, 100n * WAD, 5000n * WAD]) {
    const r = quote(pool, 'ptp', amount, FEE_BPS);
    assert.ok(k(r.newPool) > before, `selling ${amount} wei must grow k`);
  }
  // Below a tenth of a PTP there is no whole satoshi to buy at 100 sat/PTP, and
  // the pool says so instead of filling at zero.
  throwsCode(() => quote(pool, 'ptp', WAD / 1000n, FEE_BPS), 'BAD_AMOUNT');
  // Repeated trades compound: k is monotone along a whole path, never just per
  // trade in isolation.
  let p = pool;
  let last = k(p);
  for (let i = 0; i < 20; i++) {
    p = quote(p, i % 2 === 0 ? 'btc' : 'ptp', i % 2 === 0 ? 5000n : 40n * WAD, FEE_BPS).newPool;
    const now = k(p);
    assert.ok(now > last, `step ${i}`);
    last = now;
  }
});

test('k grows by exactly the fee', () => {
  // The fee is not an extra term in the formula; it is the part of the input
  // that stays behind. Take that literally: a 10 000 sat trade at 30 bps and a
  // 9 970 sat trade at zero fee are the SAME trade — the numerators and
  // denominators are identical, so the outputs are equal to the unit — and the
  // only difference in the pool afterwards is the 30 sat that never bought
  // anything.
  const pool = genesisPool();
  const outWithFee = amountOut(10000n, pool.sat, pool.ptp, 30n);
  const outFeeFree = amountOut(9970n, pool.sat, pool.ptp, 0n);
  assert.equal(outWithFee, outFeeFree);

  const kWithFee = (pool.sat + 10000n) * (pool.ptp - outWithFee);
  const kFeeFree = (pool.sat + 9970n) * (pool.ptp - outFeeFree);
  assert.equal(kWithFee - kFeeFree, 30n * (pool.ptp - outWithFee));

  // And a fee-free swap grows k only by the truncation dust, which is bounded
  // by one unit of the output reserve times the new input reserve.
  assert.ok(kFeeFree - k(pool) < pool.sat + 9970n);
});

test('the round trip never favours the trader', () => {
  const pool = genesisPool();

  // Forward then back: paying the quoted input always delivers at least what
  // was asked for. This is what the +1 in amountIn buys, and it is the
  // direction that matters, because it is the one a caller relies on.
  for (const want of [1n, 12345n, WAD, 823n * WAD, 4000n * WAD]) {
    const cost = amountIn(want, pool.sat, pool.ptp, FEE_BPS);
    assert.ok(amountOut(cost, pool.sat, pool.ptp, FEE_BPS) >= want, `buying ${want} wei`);
    // One unit less must not be enough, or the quote was padded.
    if (cost > 1n) {
      let short;
      try {
        short = amountOut(cost - 1n, pool.sat, pool.ptp, FEE_BPS);
      } catch {
        short = 0n;
      }
      assert.ok(short <= want, 'the quoted cost is minimal to within the deliberate unit');
    }
  }

  // Back then forward: the cost quoted for what an input actually bought is
  // never more than that input plus the one deliberate unit.
  //
  // The stronger claim — that amountIn(amountOut(x)) is always >= x — is not
  // true and is not asserted, because it is false in exactly the direction
  // where it would matter. It holds when each extra unit of input buys a
  // distinct unit of output, which is the case selling satoshis for wei
  // (checked below, where it comes back exactly equal). It fails selling wei
  // for satoshis: a whole PTP buys 99 sat, and so do many neighbouring wei
  // amounts, so the cheapest input that buys 99 sat is far below a whole PTP.
  // That is truncation working for the pool, not against it, and the
  // discrepancy is attributable rather than hidden.
  for (const x of [1n, 7n, 90n, 1000n, 90000n, 250000n]) {
    const got = amountOut(x, pool.sat, pool.ptp, FEE_BPS);
    const back = amountIn(got, pool.sat, pool.ptp, FEE_BPS);
    assert.equal(back, x, 'sat in, wei out: every satoshi buys a distinct amount');
    assert.ok(back <= x + 1n);
  }
  for (const x of [WAD, 10n * WAD, 500n * WAD]) {
    const got = amountOut(x, pool.ptp, pool.sat, FEE_BPS);
    const back = amountIn(got, pool.ptp, pool.sat, FEE_BPS);
    assert.ok(back <= x, 'wei in, sat out: the output unit is coarse, so the cheapest input is lower');
    assert.ok(amountOut(back, pool.ptp, pool.sat, FEE_BPS) >= got, 'and it still delivers');
  }
});

test('the genesis pool prices 1 PTP at exactly 100 sat', () => {
  const pool = genesisPool();
  assert.deepEqual(pool, {
    sat: GENESIS_SAT,
    ptp: GENESIS_PTP,
    shares: 100000000000000n, // sqrt(1e6 · 1e22) = 1e14
    locked: MINIMUM_LIQUIDITY,
  });
  assert.equal(GENESIS_SAT, 1000000n);
  assert.equal(GENESIS_PTP, 10000n * WAD);
  // Scaled by 1e18, so exactly 100 sat with no fractional part.
  assert.equal(spotSatPerPtp(pool), 100n * WAD);
  // 100 sat is 1e-6 BTC, which is what ARCHITECTURE §2 opens the market at.
  assert.equal(spotSatPerPtp(pool) / WAD, 100n);
});

test('a 0.09 EUR buy and a 90 EUR buy, and what each does to the price', () => {
  const pool = genesisPool();
  const fee = FEE_BPS;
  assert.equal(fee, 30n);

  // 0.09 EUR = 90 sat. Under one whole PTP; the price barely moves.
  const smallIn = (9n * SAT_PER_EUR) / 100n;
  assert.equal(smallIn, 90n);
  const small = quote(pool, 'btc', smallIn, fee);

  // Recomputed longhand from ARCHITECTURE §2's published formula.
  const smallWithFee = smallIn * (BPS - fee);
  assert.equal(small.out, (pool.ptp * smallWithFee) / (pool.sat * BPS + smallWithFee));
  assert.equal(small.out, 897219492494938429n);
  // Just under 0.9 PTP: 90 sat at 100 sat/PTP, less the 0.3 % fee and a
  // whisker of impact.
  assert.ok(small.out < (90n * WAD) / 100n);
  assert.ok(small.out > (8965n * WAD) / 10000n);
  // 90 sat against a 1 000 000 sat reserve moves the mid price by under two
  // basis points, and the basis point is the unit, so it reports one.
  assert.equal(small.priceImpactBps, 1n);

  // 90 EUR = 90 000 sat, nine percent of the entire bitcoin side. This is a
  // large trade against a small pool and the number says so.
  const bigIn = 90n * SAT_PER_EUR;
  assert.equal(bigIn, 90000n);
  const big = quote(pool, 'btc', bigIn, fee);
  const bigWithFee = bigIn * (BPS - fee);
  assert.equal(big.out, (pool.ptp * bigWithFee) / (pool.sat * BPS + bigWithFee));
  assert.equal(big.out, 823414974351444853312n);
  assert.equal(big.priceImpactBps, 1878n); // 18.78 %

  // A thousand times the money does not buy a thousand times the PTP, and the
  // gap is the impact rather than the fee: the effective price paid per PTP is
  // far worse on the large trade.
  assert.ok(big.out < 1000n * small.out);
  const smallPricePerPtp = (smallIn * WAD * WAD) / small.out;
  const bigPricePerPtp = (bigIn * WAD * WAD) / big.out;
  assert.ok(bigPricePerPtp > smallPricePerPtp);
  assert.ok(bigPricePerPtp > (smallPricePerPtp * 108n) / 100n, 'the big trade pays over 8 % more per PTP');

  // Impact is a magnitude, so selling reports the same shape of number.
  const sell = quote(pool, 'ptp', 800n * WAD, fee);
  assert.ok(sell.priceImpactBps > 0n);
  assert.ok(sell.newPool.sat < pool.sat && sell.newPool.ptp > pool.ptp);
  assert.ok(spotSatPerPtp(sell.newPool) < spotSatPerPtp(pool));
});

test('the first-depositor share-inflation attack loses money', () => {
  // The attack: open the pool with dust so you own every share, donate to the
  // reserves so one share is worth a fortune, then let the next depositor's
  // whole deposit round down to zero shares and keep it.
  //
  // Step one already fails. A pool cannot open below the locked minimum, so
  // "own every share" is not available: 1000 of them are gone before the
  // opener holds any.
  const empty = { sat: 0n, ptp: 0n, shares: 0n, locked: 0n };
  throwsCode(() => addLiquidity(empty, 1n, 1n), 'INSUFFICIENT_SHARES');
  throwsCode(() => addLiquidity(empty, 1000n, 1000n), 'INSUFFICIENT_SHARES'); // sqrt = 1000, not > 1000

  // The smallest pool that can exist mints 1001 shares and hands the opener
  // exactly one of them.
  const open = addLiquidity(empty, 1001n, 1001n);
  assert.equal(open.shares, 1n);
  assert.equal(open.newPool.shares, 1001n);
  assert.equal(open.newPool.locked, MINIMUM_LIQUIDITY);

  // Now the donation. Nothing in this module can perform one — every entry
  // point that adds reserves also mints shares — so it is written by hand,
  // which is exactly what sending coins straight to the pool would look like.
  const donation = 1000000000n;
  const skewed = { ...open.newPool, sat: open.newPool.sat + donation };

  // The victim's deposit is refused, not swallowed. This is the whole defence:
  // minting zero shares for a non-zero deposit is the theft, and it cannot
  // happen because it is an error.
  throwsCode(() => addLiquidity(skewed, 100n, 100n), 'BAD_AMOUNT');

  // And the attacker cannot get the donation back. One share of 1001 is one
  // thousandth of the pool; the other thousand shares are locked forever and
  // belong to nobody, so 99.9 % of the donation is simply gone.
  const out = removeLiquidity(skewed, 1n);
  assert.ok(out.sat * 1000n < donation, 'under a thousandth of the donation comes back');
  assert.ok(out.newPool.shares >= MINIMUM_LIQUIDITY);
  assert.ok(out.newPool.sat > 0n && out.newPool.ptp > 0n);

  // The locked shares themselves are unreachable by construction.
  throwsCode(() => removeLiquidity(skewed, skewed.shares), 'INSUFFICIENT_SHARES');
  throwsCode(() => removeLiquidity(open.newPool, 2n), 'INSUFFICIENT_SHARES');
});

test('adding liquidity takes only the proportional part of a skewed offer', () => {
  const pool = genesisPool();
  // Offered 1000 sat and 100 PTP against a pool priced at 100 sat per PTP,
  // where 1000 sat is worth 10 PTP. The satoshi side binds; only 10 PTP is
  // taken and the other 90 never leaves the depositor.
  const r = addLiquidity(pool, 1000n, 100n * WAD);
  assert.equal(r.used.sat, 1000n);
  assert.equal(r.used.ptp, 10n * WAD);
  assert.ok(r.used.ptp < 100n * WAD);
  assert.equal(r.shares, (1000n * pool.shares) / pool.sat);
  // The ratio, and therefore the price, is unchanged to the unit.
  assert.equal(spotSatPerPtp(r.newPool), spotSatPerPtp(pool));
  assert.equal(r.newPool.shares, pool.shares + r.shares);
  assert.equal(r.newPool.locked, pool.locked);

  // The other side binding gives the mirror answer.
  const s = addLiquidity(pool, 1000000n, 10n * WAD);
  assert.equal(s.used.ptp, 10n * WAD);
  assert.equal(s.used.sat, 1000n);

  // A deposit and an immediate withdrawal never returns more than went in.
  const back = removeLiquidity(r.newPool, r.shares);
  assert.ok(back.sat <= r.used.sat && back.ptp <= r.used.ptp);

  // Round trip through liquidity leaves the pool no poorer per share.
  const perShareBefore = (pool.sat * WAD) / pool.shares;
  const perShareAfter = (back.newPool.sat * WAD) / back.newPool.shares;
  assert.ok(perShareAfter >= perShareBefore);
});

test('every zero, negative, oversized and malformed input is refused', () => {
  const pool = genesisPool();
  const R = pool.sat;
  const P = pool.ptp;

  throwsCode(() => amountOut(0n, R, P, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => amountOut(-1n, R, P, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => amountOut(1n << 200n, R, P, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => amountOut(90, R, P, FEE_BPS), 'BAD_AMOUNT'); // a Number, not a bigint
  throwsCode(() => amountOut(90n, 0n, P, FEE_BPS), 'POOL_EMPTY');
  throwsCode(() => amountOut(90n, R, 0n, FEE_BPS), 'POOL_EMPTY');
  throwsCode(() => amountOut(90n, R, P, BPS), 'BAD_AMOUNT');
  throwsCode(() => amountOut(90n, R, P, -1n), 'BAD_AMOUNT');
  throwsCode(() => amountOut(90n, R, P, 30), 'BAD_AMOUNT');
  // Too small to buy a single unit: refused, never filled at zero.
  throwsCode(() => amountOut(1n, P, R, FEE_BPS), 'BAD_AMOUNT');

  throwsCode(() => amountIn(0n, R, P, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => amountIn(P, R, P, FEE_BPS), 'POOL_EMPTY'); // the whole reserve
  throwsCode(() => amountIn(P + 1n, R, P, FEE_BPS), 'POOL_EMPTY');

  throwsCode(() => quote(pool, 'eur', 90n, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => quote(pool, 'btc', 0n, FEE_BPS), 'BAD_AMOUNT');
  throwsCode(() => quote(null, 'btc', 90n, FEE_BPS), 'POOL_EMPTY');
  throwsCode(() => quote({ sat: 0n, ptp: 0n, shares: 0n, locked: 0n }, 'btc', 90n, FEE_BPS), 'POOL_EMPTY');
  throwsCode(() => quote({ sat: 1n, ptp: 1n, shares: 0n, locked: 0n }, 'btc', 1n, FEE_BPS), 'POOL_EMPTY');
  throwsCode(() => quote({ ...pool, locked: pool.shares + 1n }, 'btc', 90n, FEE_BPS), 'INSUFFICIENT_SHARES');

  throwsCode(() => addLiquidity(pool, 0n, WAD), 'BAD_AMOUNT');
  throwsCode(() => addLiquidity(pool, -5n, WAD), 'BAD_AMOUNT');
  throwsCode(() => addLiquidity(pool, 1n, 1n), 'BAD_AMOUNT'); // mints no whole share

  throwsCode(() => removeLiquidity(pool, 0n), 'INSUFFICIENT_SHARES');
  throwsCode(() => removeLiquidity(pool, -1n), 'INSUFFICIENT_SHARES');
  throwsCode(() => removeLiquidity(pool, pool.shares), 'INSUFFICIENT_SHARES');
  throwsCode(() => removeLiquidity(pool, pool.shares - pool.locked + 1n), 'INSUFFICIENT_SHARES');

  // Nothing above mutated the pool.
  assert.deepEqual(pool, genesisPool());
});

test('a swap can thin a reserve but never empty it', () => {
  const pool = genesisPool();
  // An absurd trade: sell more PTP than the pool holds.
  const r = quote(pool, 'ptp', 1000000n * WAD, FEE_BPS);
  assert.ok(r.newPool.sat > 0n, 'the satoshi reserve survives');
  assert.ok(r.out < pool.sat);
  assert.ok(k(r.newPool) > k(pool));
  // And the pool is still quotable afterwards.
  assert.ok(quote(r.newPool, 'btc', 1000n, FEE_BPS).out > 0n);
});

test('the pool passed in is never mutated', () => {
  const pool = genesisPool();
  const copy = { ...pool };
  quote(pool, 'btc', 90000n, FEE_BPS);
  addLiquidity(pool, 1000n, 100n * WAD);
  removeLiquidity(pool, 1000n);
  spotSatPerPtp(pool);
  assert.deepEqual(pool, copy);
});
