// The one pool: a constant-product market over BTC (satoshis) and PTP (wei).
//
// Uniswap-V2 arithmetic, integer-exact, BigInt from end to end. No float ever
// touches a reserve, a price or a share count in this file — not as an
// intermediate, not "just for the ratio". A market that computes a price in
// doubles is a market where two honest nodes disagree about who owns what, and
// the whole point of ARCHITECTURE §5 is that replay is a pure function anyone
// can rerun and land on the same integers.
//
// Everything here is a pure function of its arguments. Nothing reads a clock,
// nothing reads the network, nothing holds state. `newPool` is always a fresh
// object; the pool you passed in is never mutated, so a caller that rejects an
// act (replay skips invalid acts whole, ARCHITECTURE §5) has nothing to undo.
//
// REFUSAL CODES USED HERE — declared for the errors agent to check against.
// This file deliberately does NOT import core/errors.mjs: core is the one
// rulebook and the AMM is the part of it that must load in a browser, a server
// and a chain builder with nothing behind it. It throws `new Error(code)` with
// one of these literal strings, and core/errors.mjs must carry an entry for
// each with its `why` and `fix`:
//
//   POOL_EMPTY     a side of the pool is zero, or the trade would take a whole
//                  reserve. A constant-product pool cannot quote against
//                  nothing and cannot sell its last unit.
//   BAD_AMOUNT    an amount is zero, negative, not a bigint, larger than the
//                  representable bound, or too small to move a single unit
//                  (a swap that buys 0, a deposit that mints 0 shares).
//   INSUFFICIENT_SHARES    a share count is zero, larger than the pool has, or would
//                  take the pool below MINIMUM_LIQUIDITY.
//   SLIPPAGE_EXCEEDED  the fill is worse than the `minOut` the act carried.
//
// SLIPPAGE_EXCEEDED is never thrown by this module and that is deliberate: none of
// the signatures in ARCHITECTURE §2 take a `minOut`, because slippage is a
// property of the act, not of the arithmetic. `quote()` tells you what a trade
// would do; the swap-act validator in core/replay.mjs compares `out` with the
// act's `minOut` and raises SLIPPAGE_EXCEEDED. It is listed here so the catalogue
// and the pool agree on one spelling.

/**
 * Basis-point denominator. Fees, price impact and the proportional share math
 * are all expressed against 10 000, which is the unit ARCHITECTURE §2 states
 * the swap formula in.
 */
export const BPS = 10000n;

/** One PTP, in wei. The token has 18 decimals (ARCHITECTURE §1). */
export const WAD = 1000000000000000000n;

/**
 * The default swap fee, 30 bps = 0.3 %, Uniswap-V2's number.
 *
 * ARCHITECTURE §2 sources this from the params edition. It is restated here as
 * a literal rather than imported so that core/amm.mjs stays dependency-free and
 * loadable on its own; every function in this file takes `feeBps` explicitly,
 * so the value below is only a default for callers that have no params in
 * hand. core/params.mjs is the authority and must agree with this number — the
 * constants block sealed into each epoch block records which fee actually
 * priced that epoch, so a disagreement is detectable rather than silent.
 */
export const FEE_BPS = 30n;

/**
 * Share units locked forever when the pool opens, so the pool can never be
 * drained to zero (ARCHITECTURE §2). Uniswap-V2's constant, kept for the same
 * reason: it is what makes the first-depositor share-inflation attack cost more
 * than it earns. These shares belong to nobody and `removeLiquidity` refuses to
 * touch them, which is the whole of their enforcement.
 */
export const MINIMUM_LIQUIDITY = 1000n;

/**
 * Genesis liquidity from ARCHITECTURE §2: 0.01 BTC against 10 000 PTP.
 * Genesis spot is therefore exactly 1 PTP = 100 sat.
 */
export const GENESIS_SAT = 1000000n;
export const GENESIS_PTP = 10000n * WAD;

/**
 * The representable bound for every amount and reserve this module will accept.
 *
 * 2^128 is far above any quantity this network can produce — the whole bitcoin
 * supply is 2.1e15 sat and total PTP emission is bounded by the curve in
 * params — and far below the point where BigInt multiplication of two of them
 * gets expensive. Its job is to turn a caller's arithmetic mistake (a value
 * built by concatenation, a wei amount used where sat was meant) into a refusal
 * at the boundary instead of a pool state nobody can reason about.
 */
export const MAX_AMOUNT = (1n << 128n) - 1n;

// ── argument checking ──────────────────────────────────────────────────────
// Every entry point validates before it computes. There is no path through
// this file where a bad argument produces a number; it produces an Error whose
// message is a stable code, and the caller decides what to tell the human.

function need(value, code) {
  if (typeof value !== 'bigint') throw new Error(code);
  if (value < 0n || value > MAX_AMOUNT) throw new Error(code);
  return value;
}

function needPositive(value, code) {
  if (need(value, code) === 0n) throw new Error(code);
  return value;
}

function needFee(feeBps) {
  // A fee of exactly 10 000 bps would take the entire input and hand back
  // nothing, which is not a market; anything above it is nonsense.
  if (typeof feeBps !== 'bigint' || feeBps < 0n || feeBps >= BPS) throw new Error('BAD_AMOUNT');
  return feeBps;
}

/**
 * Read a pool argument and check it is a shape the arithmetic can stand on.
 *
 * A pool is `{ sat, ptp, shares, locked }`, every field bigint. `shares` counts
 * every share outstanding INCLUDING the locked ones, so it is the correct
 * denominator for every proportional calculation; `locked` is the floor
 * `removeLiquidity` will not go under.
 */
function needPool(pool, { allowEmpty = false } = {}) {
  if (pool === null || typeof pool !== 'object') throw new Error('POOL_EMPTY');
  const sat = need(pool.sat, 'POOL_EMPTY');
  const ptp = need(pool.ptp, 'POOL_EMPTY');
  const shares = need(pool.shares, 'INSUFFICIENT_SHARES');
  const locked = need(pool.locked, 'INSUFFICIENT_SHARES');
  if (locked > shares) throw new Error('INSUFFICIENT_SHARES');
  if (shares === 0n) {
    // No shares means no pool yet. Reserves without shares would be liquidity
    // owned by nobody, which no operation here can produce, so it is refused
    // rather than quietly absorbed.
    if (sat !== 0n || ptp !== 0n) throw new Error('POOL_EMPTY');
    if (!allowEmpty) throw new Error('POOL_EMPTY');
  } else if (sat === 0n || ptp === 0n) {
    throw new Error('POOL_EMPTY');
  }
  return { sat, ptp, shares, locked };
}

/** Divide rounding up. Used wherever the rounding must favour the pool. */
function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * Exact integer square root of a BigInt, by Newton's method from an initial
 * guess above the answer, so the iteration decreases monotonically to
 * floor(sqrt(n)) and stops the first time it stops moving.
 *
 * This exists because `Math.sqrt(Number(n))` is wrong here in a way that
 * matters: the genesis product is 1e28, past 2^53, so the double would round
 * and the opening share count — the denominator every later deposit and
 * withdrawal divides by — would depend on which engine computed it. Newton on
 * BigInt gives one answer everywhere.
 */
export function isqrt(n) {
  if (typeof n !== 'bigint' || n < 0n) throw new Error('BAD_AMOUNT');
  if (n < 2n) return n;
  let bits = 0n;
  for (let t = n; t > 0n; t >>= 1n) bits += 1n;
  // 2^ceil(bits/2) is >= sqrt(n) for every n < 2^bits, which is the condition
  // Newton needs to approach the root from above.
  let x = 1n << ((bits + 1n) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * How much comes out for a given amount in — ARCHITECTURE §2's formula,
 * verbatim:
 *
 *   out = rOut · (10000−fee)·Δin / (rIn·10000 + (10000−fee)·Δin)
 *
 * The division is deferred to the very end so the fee is never lost to
 * truncation, and the single truncation at the end rounds DOWN, which leaves
 * the dust in the pool. That is the shape the whole file keeps: every rounding
 * favours the pool, i.e. every liquidity provider pro rata, and never a
 * particular caller.
 *
 * `out` is strictly less than `reserveOut` by construction — the fraction is
 * below 1 — so a swap can thin a reserve but never empty it. A trade too small
 * to buy a single unit is refused instead of filled at zero: a free fill is a
 * faucet, and this network already has one place where zero must never appear
 * silently (the underflow rule, ARCHITECTURE §3).
 */
export function amountOut(amountIn, reserveIn, reserveOut, feeBps = FEE_BPS) {
  needPositive(amountIn, 'BAD_AMOUNT');
  needPositive(reserveIn, 'POOL_EMPTY');
  needPositive(reserveOut, 'POOL_EMPTY');
  needFee(feeBps);
  const inWithFee = amountIn * (BPS - feeBps);
  const out = (reserveOut * inWithFee) / (reserveIn * BPS + inWithFee);
  if (out === 0n) throw new Error('BAD_AMOUNT');
  return out;
}

/**
 * The inverse: the smallest input that buys at least `amountOut`.
 *
 * Solving the swap equation for the input gives
 *
 *   in ≥ out·rIn·10000 / ((rOut−out)·(10000−fee))
 *
 * and the answer is the ceiling of that. This returns floor(·)+1, Uniswap's
 * form, which is the ceiling whenever the division has a remainder and one unit
 * MORE than it when it divides exactly. That extra unit is deliberate and is
 * the reason this function never favours the trader: quoting the exact
 * threshold would occasionally leave the caller one unit short of the amount
 * they asked for once the forward truncation is applied, and a quote that
 * under-delivers is worse than a quote that costs one satoshi too much. The
 * consequence, stated plainly: `amountIn(amountOut(x))` can come back as x+1,
 * never as something the pool would refuse to honour.
 *
 * Buying the whole of a reserve is refused rather than priced at infinity.
 */
export function amountIn(amountOut, reserveIn, reserveOut, feeBps = FEE_BPS) {
  needPositive(amountOut, 'BAD_AMOUNT');
  needPositive(reserveIn, 'POOL_EMPTY');
  needPositive(reserveOut, 'POOL_EMPTY');
  needFee(feeBps);
  if (amountOut >= reserveOut) throw new Error('POOL_EMPTY');
  const num = reserveIn * amountOut * BPS;
  const den = (reserveOut - amountOut) * (BPS - feeBps);
  const need_ = num / den + 1n;
  if (need_ > MAX_AMOUNT) throw new Error('BAD_AMOUNT');
  return need_;
}

/**
 * The mid price: satoshis per whole PTP, scaled by 1e18.
 *
 * A whole PTP is 1e18 wei, so the sat price of one PTP is `sat·1e18/ptp`, and
 * scaling that by another 1e18 to keep the fractional part gives
 * `sat·1e36/ptp`. At genesis this is exactly 100·1e18 — 1 PTP = 100 sat = 1e-6
 * BTC, the opening price ARCHITECTURE §2 fixes.
 *
 * This is the price BEFORE fee and before impact: it is what the pool is worth
 * per unit at rest, not what a trade would get. Anything user-facing must quote
 * `quote()` instead, because the difference between the two is exactly what a
 * screen that hides slippage is hiding.
 */
export function spotSatPerPtp(pool) {
  const p = needPool(pool);
  return (p.sat * WAD * WAD) / p.ptp;
}

/**
 * Price a trade without executing it: what comes out, how far it moves the
 * pool, and what the pool looks like afterwards.
 *
 * `side` names the asset being SOLD and takes the same two values the `swap`
 * act's `sell` field takes (ARCHITECTURE §4): "btc" spends satoshis and
 * receives wei, "ptp" spends wei and receives satoshis. Using the act's own
 * vocabulary here means the validator can hand the act's field straight in
 * with no translation table to get backwards.
 *
 * `priceImpactBps` is how far the trade moves the pool's own mid price, in
 * basis points, truncated: |spotAfter − spotBefore| · 10000 / spotBefore. It is
 * reported as a magnitude because the direction is already implied by `side`,
 * and it is measured against the mid price rather than against the fill so that
 * the number means the same thing in both directions. A trade too small to
 * register a whole basis point reports 0 impact, which is honest — it is below
 * the resolution of the unit, not free.
 *
 * `newPool` is what the pool becomes if this trade lands. `shares` and `locked`
 * are carried across unchanged: a swap moves reserves and pays the providers by
 * growing k, it never mints or burns a share.
 */
export function quote(pool, side, amount, feeBps = FEE_BPS) {
  const p = needPool(pool);
  if (side !== 'btc' && side !== 'ptp') throw new Error('BAD_AMOUNT');
  needPositive(amount, 'BAD_AMOUNT');
  needFee(feeBps);

  const before = spotSatPerPtp(p);
  // A pool skewed so far that its own mid price truncates to zero at 1e18 scale
  // (sat·1e36 < ptp) cannot report an impact: the impact is measured against
  // `before`, and dividing by it would raise a bare RangeError instead of one of
  // this file's four codes. That is a pool nobody can quote against honestly, so
  // it is refused as empty rather than priced. It is out of reach from genesis —
  // k is conserved, so thinning sat to 1 leaves ptp at k and the spot at 1e8 —
  // but `quote` takes a pool from its caller, and every entry point here refuses
  // with a code rather than trusting the caller to have built a sane one.
  if (before === 0n) throw new Error('POOL_EMPTY');
  let newPool;
  let out;
  if (side === 'btc') {
    out = amountOut(amount, p.sat, p.ptp, feeBps);
    newPool = { sat: p.sat + amount, ptp: p.ptp - out, shares: p.shares, locked: p.locked };
  } else {
    out = amountOut(amount, p.ptp, p.sat, feeBps);
    newPool = { sat: p.sat - out, ptp: p.ptp + amount, shares: p.shares, locked: p.locked };
  }
  const after = spotSatPerPtp(newPool);
  const moved = after > before ? after - before : before - after;
  const priceImpactBps = (moved * BPS) / before;
  return { out, priceImpactBps, newPool };
}

/**
 * Deposit liquidity and receive shares.
 *
 * On an empty pool this opens it: the deposit ratio IS the opening price, since
 * there is no market yet to disagree with. Shares minted are the integer square
 * root of the product — the geometric mean, so the opening count does not
 * depend on which side you call which — and MINIMUM_LIQUIDITY of them are
 * locked forever. The opener therefore has to put in enough that
 * sqrt(sat·ptp) > MINIMUM_LIQUIDITY, or the pool would open belonging entirely
 * to nobody; below that it is refused.
 *
 * On a live pool only the PROPORTIONAL part of the offer is taken. You state
 * two ceilings, the binding side is whichever mints fewer shares, and the used
 * amounts are computed back from the minted shares rounding UP. The skewed part
 * of a lopsided offer is simply not taken — there is nothing to refund, and so
 * no refund path to get wrong. This is what stops a deposit from repricing the
 * pool and minting shares against the providers already in it.
 *
 * A deposit too small to mint one whole share is refused rather than swallowed:
 * minting zero for a non-zero deposit is how the first-depositor inflation
 * attack takes its victim's money.
 *
 * Returns the shares minted, the amounts actually `used`, and the new pool.
 */
export function addLiquidity(pool, satIn, ptpIn) {
  const p = needPool(pool, { allowEmpty: true });
  needPositive(satIn, 'BAD_AMOUNT');
  needPositive(ptpIn, 'BAD_AMOUNT');

  if (p.shares === 0n) {
    const total = isqrt(satIn * ptpIn);
    // Strictly greater: the opener must end up holding at least one share.
    if (total <= MINIMUM_LIQUIDITY) throw new Error('INSUFFICIENT_SHARES');
    return {
      shares: total - MINIMUM_LIQUIDITY,
      used: { sat: satIn, ptp: ptpIn },
      newPool: { sat: satIn, ptp: ptpIn, shares: total, locked: MINIMUM_LIQUIDITY },
    };
  }

  const bySat = (satIn * p.shares) / p.sat;
  const byPtp = (ptpIn * p.shares) / p.ptp;
  const minted = bySat < byPtp ? bySat : byPtp;
  if (minted === 0n) throw new Error('BAD_AMOUNT');
  const usedSat = ceilDiv(minted * p.sat, p.shares);
  const usedPtp = ceilDiv(minted * p.ptp, p.shares);
  // The round-up can never exceed the ceiling the caller offered: `minted` was
  // floored from that ceiling on both sides, so ceil(minted·res/total) ≤ the
  // offer, both being integers.
  if (usedSat > satIn || usedPtp > ptpIn) throw new Error('BAD_AMOUNT');
  return {
    shares: minted,
    used: { sat: usedSat, ptp: usedPtp },
    newPool: {
      sat: p.sat + usedSat,
      ptp: p.ptp + usedPtp,
      shares: p.shares + minted,
      locked: p.locked,
    },
  };
}

/**
 * Burn shares, take the proportional slice of both reserves, rounded down.
 *
 * The floor on both sides leaves the dust with the pool, which is every
 * remaining provider's pro rata rather than the leaver's to extract.
 *
 * The locked shares are the floor: a removal that would take `shares` below
 * `locked` is refused, which is the entire mechanism by which the pool cannot
 * be drained to zero. Because `shares` therefore never reaches zero, the
 * divisions below can never divide by zero and the pool never closes — it only
 * thins.
 */
export function removeLiquidity(pool, shares) {
  const p = needPool(pool);
  needPositive(shares, 'INSUFFICIENT_SHARES');
  if (shares > p.shares - p.locked) throw new Error('INSUFFICIENT_SHARES');
  const sat = (shares * p.sat) / p.shares;
  const ptp = (shares * p.ptp) / p.shares;
  if (sat === 0n && ptp === 0n) throw new Error('INSUFFICIENT_SHARES');
  return {
    sat,
    ptp,
    newPool: {
      sat: p.sat - sat,
      ptp: p.ptp - ptp,
      shares: p.shares - shares,
      locked: p.locked,
    },
  };
}

/**
 * The pool the network starts with: 1 000 000 sat against 10 000 PTP, opened
 * through the ordinary deposit path so genesis is not a special case with its
 * own arithmetic. Opening shares are sqrt(1e6 · 1e22) = 1e14, of which 1000 are
 * locked forever.
 *
 * Genesis spot is exactly 100 sat per PTP. That number is an invention — there
 * is no market yet to discover a price — and it is stated in ARCHITECTURE §2 so
 * that it is a published choice rather than a quiet one.
 */
export function genesisPool() {
  const empty = { sat: 0n, ptp: 0n, shares: 0n, locked: 0n };
  return addLiquidity(empty, GENESIS_SAT, GENESIS_PTP).newPool;
}
