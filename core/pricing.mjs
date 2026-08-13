// Prices are euros; settlement is PTP. This file is the bridge, and it is one
// rational number wide.
//
// Every user-visible price in this network is a euro price held as an integer
// nanoeuro (ARCHITECTURE §3). Every balance is PTP wei. Between them sit two
// public rates — the EUR/BTC oracle and the pool's own PTP/BTC ratio — and the
// whole of this module is the arithmetic that joins them without losing the
// money in the middle.
//
// ── WHY THE CONVERSION IS FUSED, MEASURED RATHER THAN ARGUED ────────────────
//
// The obvious rope is two hops: nanoeuros to satoshis, satoshis to wei. It does
// not work, and it does not work at every token price, so nothing downstream can
// fix it. At 90,000 EUR/BTC one satoshi is 900,000 nanoeuros, so:
//
//   view price floor      20,000 n€  =  0.0222 sat  ->  0 sat  ->  0 wei
//   view price default   100,000 n€  =  0.1111 sat  ->  0 sat  ->  0 wei
//   view price ceiling   400,000 n€  =  0.4444 sat  ->  0 sat  ->  0 wei
//   storage rent, MB·day   2,000 n€  =  0.0022 sat  ->  0 sat  ->  0 wei
//   settlement floor     100,000 n€  =  0.1111 sat  ->  0 sat  ->  0 wei
//
// and the two items that survive — a like at 1.1111 sat and a comment at 2.2222
// sat — are under-charged by exactly 10%. The failure is on the BITCOIN side of
// the rope: it is a property of one satoshi being worth 0.0009 EUR, and it is
// completely independent of what PTP is worth. No amount of token appreciation
// removes it, no deeper pool removes it, and raising the view price only moves
// which row zeroes first. Section 3's own underflow rule then substitutes 1 wei,
// which at the genesis price is 9.0e-20 EUR — a discount of 1.1e15, which is
// precisely the sybil faucet that rule exists to prevent.
//
// So the conversion is evaluated as ONE rational with ONE truncation, at the end:
//
//                nanoEur × 10⁸ × poolPtpWei
//   ptpWei  =  ───────────────────────────────
//                eurPerBtcNano × poolSat
//
// The 10⁸ is satoshis per bitcoin: it turns a EUR/BTC rate into a EUR/satoshi
// rate without ever materialising an integer satoshi. Swept across every priced
// item at 1×, 10×, 100×, 1000× and 1,000,000× the genesis token price, the
// smallest value this form produces anywhere is 22,222,222 wei; the two-hop form
// returns zero in twenty cells out of twenty. test/pricing.test.mjs holds both
// halves of that statement, so the regression cannot come back quietly.
//
// Both hops stay PUBLIC, as §3 requires — `nanoEurToSubSat` publishes the
// satoshi leg at 1e8 sub-satoshi resolution, where the view price floor is
// 2,222,222 units with no error at all. What is forbidden is settling money
// through an integer satoshi.
//
// ── WHAT THE RATE IS ───────────────────────────────────────────────────────
//
//   Rate = { eurPerBtcNano, poolSat, poolPtpWei, epoch }
//
// Both legs are frozen at the epoch seal and used unchanged for the whole epoch.
// A live pool spot would hand an attacker their own denominator: with weight
// linear in PTP burned, weight is fee euros divided by price, so an actor
// converting at a self-created dip buys r = p_others / p_attacker times the
// weight per euro, and a 90% dip in a 900 EUR pool returns 292% of the spend.
// Sealing both legs makes r exactly 1 for every actor, by construction. It also
// means a price is reproducible from the block alone, with no access to a live
// pool and no oracle call — which is what makes a settled epoch recomputable by
// somebody who holds nothing of ours.
//
// ── REFUSAL CODES USED HERE ────────────────────────────────────────────────
// This module throws `new Error(code)` with catalogued strings, the same
// convention core/amm.mjs and core/params.mjs use and for the same reason: core
// is the one rulebook and it must load in a browser, a server and a chain
// builder with nothing behind it. core/replay.mjs turns these into refusals.
//
//   BAD_AMOUNT          an amount is negative, not a bigint, or a bps vector
//                       does not sum to 10000.
//   POOL_EMPTY          a rate carries a zero or missing pool leg.
//   ORACLE_STALE        a rate carries no usable EUR/BTC value, or fewer
//                       sources answered than the quorum.
//   DUST_BELOW_MINIMUM  a conversion this direction cannot express at all.

import {
  PARAMS,
  BPS,
  NANO_EUR_PER_EUR,
  SAT_PER_BTC,
  SAT_SCALE,
  ORACLE_QUORUM,
  ORACLE_MAX_MOVE_BPS,
} from './params.mjs';

// ── argument checking ──────────────────────────────────────────────────────
// Every entry point validates before it computes, so there is no path through
// this file where a bad argument produces a number instead of a code.

function needWei(v, code = 'BAD_AMOUNT') {
  if (typeof v !== 'bigint' || v < 0n) throw new Error(code);
  return v;
}

/**
 * Read a Rate and check that every leg can carry money.
 *
 * A zero pool leg is POOL_EMPTY rather than a division by zero, and a missing or
 * non-positive oracle rate is ORACLE_STALE rather than a silent zero price: a
 * price of zero is a free act, and a free act is a sybil faucet.
 */
function needRate(rate) {
  if (rate === null || typeof rate !== 'object') throw new Error('ORACLE_STALE');
  const { eurPerBtcNano, poolSat, poolPtpWei } = rate;
  if (typeof eurPerBtcNano !== 'bigint' || eurPerBtcNano <= 0n) throw new Error('ORACLE_STALE');
  if (typeof poolSat !== 'bigint' || poolSat <= 0n) throw new Error('POOL_EMPTY');
  if (typeof poolPtpWei !== 'bigint' || poolPtpWei <= 0n) throw new Error('POOL_EMPTY');
  return { eurPerBtcNano, poolSat, poolPtpWei };
}

// ── the fused conversion ───────────────────────────────────────────────────

/**
 * A euro price and what it costs in PTP, with the dust flag the caller records.
 *
 * The numerator carries the whole of `nanoEur × 10⁸ × poolPtpWei` before
 * anything divides, so the only rounding in the conversion is the final
 * truncation. Truncation is DOWNWARD, which charges the payer the smaller
 * integer — the direction that favours the user on a charge — and the floor
 * below is what stops that direction from reaching zero.
 *
 * THE UNDERFLOW RULE. A non-zero price never converts to zero wei. Where the
 * truncation would reach zero the result is 1 wei and `dust` is true, so the
 * caller can say so on the screen (the card's price node carries data-dust) and
 * a payout can refuse rather than pay nothing. Zero nanoeuros converts to zero
 * wei and is not dust: the rule is about a price that silently BECOMES free, not
 * about a quantity that was never priced.
 */
export function priceOf(nanoEur, rate) {
  const n = needWei(nanoEur);
  const { eurPerBtcNano, poolSat, poolPtpWei } = needRate(rate);
  if (n === 0n) return { nanoEur: 0n, wei: 0n, dust: false };
  const wei = (n * SAT_PER_BTC * poolPtpWei) / (eurPerBtcNano * poolSat);
  return wei === 0n ? { nanoEur: n, wei: 1n, dust: true } : { nanoEur: n, wei, dust: false };
}

/**
 * What a euro price costs in PTP wei, at a sealed rate. The fused rational; never
 * two hops.
 *
 * This is the signature ARCHITECTURE §3 fixes and it returns a bigint, so the
 * dust flag is not visible through it. Anything that has to show or record the
 * flag calls `priceOf` instead and reads both halves; everything that only has to
 * move money calls this.
 */
export function nanoEurToPtpWei(nanoEur, rate) {
  return priceOf(nanoEur, rate).wei;
}

/**
 * The other direction: what a PTP quantity is worth in nanoeuros at a sealed
 * rate.
 *
 * The same rational read backwards, with the same single truncation. It is a
 * DISPLAY and AUDIT conversion — the meter, the wallet, a tombstone's euro
 * figure — and never a payment: money in this network is always moved as the wei
 * quantity that actually arrived (see CREATOR_CREDIT_UNIT in core/params.mjs).
 *
 * It floors at 1 n€ for the same reason the forward direction floors at 1 wei: a
 * meter that reads zero while it bills is a trap, and here that is a display of
 * zero over a balance that really moved. The round trip is therefore not the
 * identity — two truncations cost at most 1 n€ — and that is stated rather than
 * hidden, because a caller who assumes it is exact will build a reconciliation
 * that never balances.
 */
export function ptpWeiToNanoEur(wei, rate) {
  const w = needWei(wei);
  const { eurPerBtcNano, poolSat, poolPtpWei } = needRate(rate);
  if (w === 0n) return 0n;
  const nano = (w * eurPerBtcNano * poolSat) / (SAT_PER_BTC * poolPtpWei);
  return nano === 0n ? 1n : nano;
}

/**
 * The satoshi leg, published at 1e8 sub-satoshi resolution.
 *
 * ARCHITECTURE §3 keeps both hops public and this is the first of them. At the
 * published scale the view price floor is 2,222,222 units with no error at all,
 * so a reader can check the oracle leg of a charge on its own. It is deliberately
 * NOT a step in `nanoEurToPtpWei`: an integer satoshi is where every fee in this
 * economy goes to zero, and this function exists to show that hop rather than to
 * settle through it.
 */
export function nanoEurToSubSat(nanoEur, eurPerBtcNano) {
  const n = needWei(nanoEur);
  if (typeof eurPerBtcNano !== 'bigint' || eurPerBtcNano <= 0n) throw new Error('ORACLE_STALE');
  return (n * SAT_PER_BTC * SAT_SCALE) / eurPerBtcNano;
}

// ── the four-way split ─────────────────────────────────────────────────────

/**
 * The ordinary fee vector and the publish vector, read out of a params edition.
 *
 * Two vectors, both summing to 10000. The publish vector has no creator leg — a
 * poster may not pay themselves, which would be a faucet needing no viewer at all
 * — and the remaining three are the params' own renormalisation over a base of
 * 6000, checked by assertInvariants at import. The same vector is the right one
 * for any fee where the payer IS the credited creator, which is why
 * ARCHITECTURE §8 states the shape as "the creator share is redirected".
 *
 * Taking them from a params object rather than from the module constants means a
 * world replayed under a sealed edition splits by THAT edition's numbers, which
 * is what makes a closed epoch recomputable.
 */
export function splitVectorsOf(params = PARAMS) {
  return {
    fee: Object.freeze({
      creator: params.splitCreatorBps,
      burn: params.splitBurnBps,
      capacity: params.splitCapacityBps,
      treasury: params.splitTreasuryBps,
    }),
    publish: Object.freeze({
      creator: 0n,
      burn: params.publishSplitBurnBps,
      capacity: params.publishSplitCapacityBps,
      treasury: params.publishSplitTreasuryBps,
    }),
  };
}

/** The two vectors of the shipped edition, for callers that hold no params. */
export const SPLIT_VECTORS = Object.freeze(splitVectorsOf(PARAMS));

/**
 * Split a fee four ways, exactly.
 *
 * The four parts sum to the input to the wei. There is no rounding policy to
 * argue about because there is no rounding: three legs are floored and the BURN
 * takes everything left over. That direction is chosen and not incidental — the
 * remainder must never land in a payout, because a payout that collects rounding
 * dust is a payout somebody can farm by choosing amounts. Sending it to the burn
 * destroys it, which no account can be paid for and which every account benefits
 * from equally.
 *
 * `vector` is `{ creator, burn, capacity, treasury }` in basis points, summing to
 * 10000. Both shipped vectors are handled by exactly this code — the publish and
 * self-attributed vector is the ordinary one with the creator leg at zero — so
 * there is no second path for a fee to take and no second place for it to be
 * wrong.
 */
export function splitFee(ptpWei, vector) {
  const total = needWei(ptpWei);
  if (vector === null || typeof vector !== 'object') throw new Error('BAD_AMOUNT');
  const creatorBps = needWei(vector.creator);
  const burnBps = needWei(vector.burn);
  const capacityBps = needWei(vector.capacity);
  const treasuryBps = needWei(vector.treasury);
  if (creatorBps + burnBps + capacityBps + treasuryBps !== BPS) throw new Error('BAD_AMOUNT');

  const creator = (total * creatorBps) / BPS;
  const capacity = (total * capacityBps) / BPS;
  const treasury = (total * treasuryBps) / BPS;
  const burn = total - creator - capacity - treasury;
  return { creator, burn, capacity, treasury };
}

// ── the price surface ──────────────────────────────────────────────────────

/**
 * What one engagement costs, in nanoeuros, given the poster's own view price.
 *
 * A like is 10× the post's view price and a comment 20×, expressed in basis
 * points of it so that they follow the poster's pricing rather than floating free
 * of it: a poster who prices low prices their whole surface low and cannot sell
 * cheap views alongside expensive comments.
 *
 * It lives here, in the price surface, because two independent readers need the
 * same answer from it — core/replay.mjs charges it and core/rules/v1.mjs
 * recomputes the burn it caused when the epoch closes. One function is what stops
 * those two from drifting apart by a multiplier.
 */
export function actionPriceNanoEur(viewPriceNano, kind, params = PARAMS) {
  const view = needWei(viewPriceNano);
  if (kind === 'view') return view;
  if (kind === 'like') return (view * params.likeMultiplierBps) / BPS;
  if (kind === 'comment') return (view * params.commentMultiplierBps) / BPS;
  throw new Error('BAD_AMOUNT');
}

// ── sealing an epoch's rate ────────────────────────────────────────────────

function medianOf(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  // Odd counts take the middle value. Even counts take the mean of the two
  // middles, truncated down — the direction that makes the sealed rate no higher
  // than the sources support, so a rounding can never raise a fee.
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * What an epoch freezes: the pair of rates every price in the next epoch is
 * computed from.
 *
 * `pool` is the pool at the close — its satoshi and wei reserves are the second
 * leg of the conversion, sealed so that no swap inside the epoch can move a fee.
 * `oracle` carries the EUR/BTC leg and may state it three ways, all of which end
 * in one integer sealed into the block:
 *
 *   sources[]           values from independent public sources. At least
 *                       `oracleQuorum` of them must have answered, and the median
 *                       is taken. Each source's value is carried through into the
 *                       sealed rate, because sealing only the median makes a lie
 *                       detectable in aggregate where sealing every value makes it
 *                       attributable to a named source.
 *   eurPerBtcNano       a rate stated directly, used when no sources are given —
 *                       this is how a genesis rate and a carried-forward rate
 *                       enter.
 *   prevEurPerBtcNano   the previously sealed rate. When present, the new rate is
 *                       clamped to ±oracleMaxMoveBps of it.
 *
 * THE CLAMP HAS A COST AND IT IS NOT HIDDEN. A genuine bitcoin move of more than
 * 10% in a day is mispriced until the rate catches up — three epochs for a 30%
 * move — and every fee in that window is wrong by the difference. That is the
 * cheaper side of the trade against an unclamped rate a manipulator can steer,
 * and the error is public while it happens because both the clamped rate and the
 * sources it was clamped from are in the block.
 *
 * What this function CANNOT check, stated plainly: that the sources are
 * independent, that there were five of them before any failed, or that any of
 * them is honest. It sees the values a producer sealed and nothing else. Those
 * are properties of the producer's configuration, and the block carries the
 * per-source values precisely so that a reader can judge them afterwards.
 */
// A rate arrives over HTTP, out of a JSON act body, or out of a sealed block —
// and JSON has no bigint. Demanding one here made the oracle PERMANENTLY
// UNREACHABLE: every closeEpoch carrying one answered 503, and the sealed rate
// stayed frozen at the genesis 90,000 EUR/BTC for the life of the network while
// the host went on reading, signing and publishing five live sources that
// nothing consumed. The clamp's honest cost, documented above as "three epochs
// for a 30% move", was in fact unbounded.
//
// So a rate is read the way core/replay.mjs reads every other quantity that
// crosses a transport: a bigint, or its own canonical decimal string, and
// nothing else. No Number, ever — a double cannot hold a nanoeuro rate at
// bitcoin's magnitude without losing digits, and this is the number every fee
// in the network is priced against.
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function readRate(v) {
  if (typeof v === 'bigint') return v > 0n ? v : null;
  if (typeof v === 'string' && DECIMAL_RE.test(v)) {
    const n = BigInt(v);
    return n > 0n ? n : null;
  }
  return null;
}

export function sealRate(pool, oracle) {
  if (pool === null || typeof pool !== 'object') throw new Error('POOL_EMPTY');
  const poolSat = readRate(pool.sat);
  const poolPtpWei = readRate(pool.ptp);
  if (poolSat === null) throw new Error('POOL_EMPTY');
  if (poolPtpWei === null) throw new Error('POOL_EMPTY');
  if (oracle === null || typeof oracle !== 'object') throw new Error('ORACLE_STALE');

  const values = [];
  if (Array.isArray(oracle.sources)) {
    for (const s of oracle.sources) {
      const v = readRate(s && typeof s === 'object' ? s.eurPerBtcNano : s);
      if (v !== null) values.push(v);
    }
    if (values.length < Number(ORACLE_QUORUM)) throw new Error('ORACLE_STALE');
  }

  const rate0 = values.length > 0 ? medianOf(values) : readRate(oracle.eurPerBtcNano);
  if (rate0 === null) throw new Error('ORACLE_STALE');
  let rate = rate0;

  const prev = readRate(oracle.prevEurPerBtcNano);
  if (prev !== null) {
    const hi = (prev * (BPS + ORACLE_MAX_MOVE_BPS)) / BPS;
    const lo = (prev * (BPS - ORACLE_MAX_MOVE_BPS)) / BPS;
    if (rate > hi) rate = hi;
    if (rate < lo) rate = lo;
  }

  const epoch = Number.isSafeInteger(oracle.epoch) && oracle.epoch >= 0 ? oracle.epoch : 0;
  return Object.freeze({ eurPerBtcNano: rate, poolSat, poolPtpWei, epoch });
}

// ── the euro the user reads ────────────────────────────────────────────────

// A narrow no-break space between digit groups and an ordinary no-break space
// before the sign. Both are no-break on purpose: a price that wraps across a line
// is a price that can be read as two numbers, and the app puts these strings into
// tight nodes beside buttons.
const GROUP_SPACE = ' ';
const SIGN_SPACE = ' ';

function groupFraction(digits) {
  const parts = [];
  for (let i = 0; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return parts.join(GROUP_SPACE);
}

function groupInteger(digits) {
  const parts = [];
  for (let end = digits.length; end > 0; end -= 3) {
    parts.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return parts.join(GROUP_SPACE);
}

/**
 * A nanoeuro amount as a euro string: "0.000 02 €".
 *
 * Nine fractional digits is exactly a nanoeuro, so every amount this network can
 * express prints exactly and NOTHING IS EVER ROUNDED TO ZERO. That is the whole
 * requirement: this network bills fractions of a cent per impression, and a meter
 * that reads "0.00 €" while it charges is the trap ARCHITECTURE §11 says a
 * per-impression network must not be.
 *
 * The shape: trailing zeros are dropped but at least two decimals are kept, so an
 * ordinary amount reads like money (1.20 €) and a micro-price keeps every digit
 * it needs (0.000 000 001 €). Digits are grouped in threes on both sides of the
 * point with a narrow no-break space, which is what makes 0.00002 legible as
 * "0.000 02" instead of a row of zeros nobody can count.
 *
 * Accepts a bigint, or a decimal string as it arrives on the wire. A Number is
 * refused: a nanoeuro amount past 2^53 read as a double is a different amount,
 * and this is the last place that mistake is still cheap to catch.
 */
export function formatEur(nanoEur) {
  let v;
  if (typeof nanoEur === 'bigint') v = nanoEur;
  else if (typeof nanoEur === 'string' && /^-?(0|[1-9][0-9]*)$/.test(nanoEur)) v = BigInt(nanoEur);
  else throw new Error('BAD_AMOUNT');

  const negative = v < 0n;
  if (negative) v = -v;
  const whole = v / NANO_EUR_PER_EUR;
  const frac = v % NANO_EUR_PER_EUR;

  let digits = frac.toString(10).padStart(9, '0').replace(/0+$/, '');
  if (digits.length < 2) digits = digits.padEnd(2, '0');

  return `${negative ? '-' : ''}${groupInteger(whole.toString(10))}.${groupFraction(digits)}${SIGN_SPACE}€`;
}
