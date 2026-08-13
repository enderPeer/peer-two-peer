// The distribution module, version 1 — the swappable part of ARCHITECTURE §8.
//
// At every epoch close, PTP is minted to creators. Emission is a PER-CREATOR
// REBATE ON BURN ACTUALLY CAUSED, not a pot distributed by weight, and this file
// computes the one input that rebate takes: how much PTP each creator's own
// content destroyed during the epoch.
//
//   mint_i = min( scheduledCap(epoch),  emissionCapBps/10000 × credit_i )
//
// applied through core/params.mjs — `creatorRebate` per entry, then
// `applyEpochRail` over the round. Nothing in this file reads an oracle, a pool
// price or a balance. It reads acts and returns quantities of PTP that left the
// supply, which is the whole of what ECONOMICS.md means by "weight is linear in
// PTP destroyed".
//
// ── WHAT IS NOT HERE, AND WHY EACH ABSENCE IS DELIBERATE ───────────────────
//
// There is no per-pair damping, no repeat-view decay and no exponent on unique
// viewers. All three were proposed, all three were measured, and all three pay an
// attacker for splitting one identity into many:
//
//   viewRepeatDecayAlpha at 1.0  — twelve views on one pair credit H(12) = 3.1032
//     where twelve views on twelve pairs credit 12, so spreading the same spend
//     across more accounts buys 3.867× the weight per euro.
//   pairDiminishingBeta at 0.25  — 1,200 views spread one per puppet took 2.02×
//     the weight of 120 concentrated on one pair, cutting the sybil loss from
//     31.80% to 6.09%. At 0.5 the loop is outright profitable.
//   qualityExponent — the farm chooses the sock ratio, so it chooses the
//     multiplier. The critical exponent FALLS as the farm grows (0.118 at a
//     thousand socks, 0.059 at a million), so there is no safe positive value.
//
// Each of them is a correct intuition about attention and a wrong rule about
// money. They live in feed ranking, where they shape what people see and move no
// money at all. In here, weight is linear in what was destroyed, and a stake split
// across twenty puppets weighs exactly what one account holding it weighs —
// ARCHITECTURE rule 4, held as an assertion by test/sybil.test.mjs.
//
// The one shape that IS enforced here is that self-engagement never counts. On a
// post where the payer is the credited creator, the fee's creator leg is
// redirected away from them (core/pricing.mjs SPLIT_VECTORS.publish), and the
// burn it caused credits nobody. core/replay.mjs refuses a self-view, a self-like
// and a self-comment at the door, so in a well-formed log these acts never
// appear; the check is repeated here because a rules module is a pure function of
// the acts it is given and may not assume a particular gate ran upstream.

import { PARAMS } from '../params.mjs';
import { actionPriceNanoEur, nanoEurToPtpWei, splitFee, splitVectorsOf } from '../pricing.mjs';

/** The version key a `rulesSet` act names, and the key the epoch block seals. */
export const VERSION = 'v1';

/** The act kinds that pay a fee somebody else's content caused. */
const CREDITED_KINDS = new Set(['view', 'like', 'comment']);

/**
 * The credited burn per creator for one epoch.
 *
 * Returns `Map(address -> creditedBurnWei)`: for each creator, the PTP that
 * engagement with THEIR OWN pictures destroyed during this epoch. A Map rather
 * than an object because that is what `applyEpochRail` in core/params.mjs
 * consumes, and because an address-keyed plain object is one bad key away from a
 * prototype it never asked for.
 *
 * `epochActs` is the ordered list of acts that LANDED in the closing epoch —
 * acts replay accepted, not acts somebody sent. `world` supplies what an act
 * alone does not carry: who owns the post, what the poster priced it at, and the
 * rate this epoch sealed. Recomputing the fee here rather than reading an
 * accumulator is what makes the module genuinely swappable: a future version can
 * weigh the same acts differently without replay having kept a number shaped for
 * this one.
 *
 * PUBLISH FEES AND RENT ARE NOT CREDITED, and that is the load-bearing exclusion.
 * A publish fee burns 6000 bps of a poster's own money; crediting it back would
 * rebate 42% of every publish to the poster with no viewer involved anywhere — a
 * faucet that needs no audience, which is exactly what the publish vector's zero
 * creator leg exists to prevent. Only fees that somebody ELSE paid to engage with
 * the creator's content are credited.
 */
export function credit(world, epochActs) {
  const params = (world && world.constants) || PARAMS;
  const rate = world && world.epoch ? world.epoch.oracle : null;
  const vector = splitVectorsOf(params).fee;
  const out = new Map();
  if (!Array.isArray(epochActs) || epochActs.length === 0) return out;

  for (const act of epochActs) {
    if (!act || typeof act !== 'object') continue;
    if (!CREDITED_KINDS.has(act.k)) continue;

    const post = world.posts[act.pid];
    if (!post) continue;

    // Self-engagement never counts, in every version of the rules.
    if (post.author === act.as) continue;

    // The euro price is the poster's own, and the conversion is the epoch's
    // sealed rate — the same two numbers replay charged with, so the burn
    // credited here is the burn that actually happened.
    const nanoEur = actionPriceNanoEur(post.viewPriceNano, act.k, params);
    const wei = nanoEurToPtpWei(nanoEur, rate);
    const { burn } = splitFee(wei, vector);
    if (burn <= 0n) continue;

    out.set(post.author, (out.get(post.author) || 0n) + burn);
  }

  return out;
}
