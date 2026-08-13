// The constants edition: every number that decides who gets paid.
//
// This file is the authority. core/amm.mjs restates the swap fee as a literal so
// it can load alone, the epoch block seals a copy of this edition so a closed
// epoch stays recomputable, and every other module reads the values from here.
// A disagreement between any of those copies is detectable, which is the only
// reason more than one copy is tolerable.
//
// Everything is BigInt. Two of the parameters below are exponents that in an
// earlier draft were fractional; they are integers now because measurement drove
// both of them to exactly zero, and a zero needs no fraction. That is not a
// convenience — it is the finding, recorded in the type.
//
// ── WHAT THIS EDITION CORRECTS ────────────────────────────────────────────────
//
// The predecessor set emitted a FLAT 2000 PTP per epoch, unconditionally, while
// every cost in the network is denominated in euros. Nothing coupled the two, so
// the value of emission floated free of the fee economy and three things broke,
// all measured rather than argued:
//
//   A single account at zero DAU captured the whole 180 EUR/day emission for a
//   0.0001 EUR spend, and the break-even DAU for that attack rose LINEARLY with
//   the token price, so a rising price made the attack better.
//   Supply was inflationary below 10,302 DAU.
//   At 1,000 DAU fee inflow was 41.60 EUR/day against 180.00 EUR/day of emitted
//   creator sell pressure into a pool holding 900 EUR a side. The pool drained
//   structurally, with no attacker involved.
//
// Emission is now a pure function of PTP the epoch actually destroyed:
//
//   emission(epoch) = min( scheduledCap(epoch), emissionCapBps/10000 x burned )
//
// It reads no oracle, no pool, and no price. Every safety property below is
// therefore a ratio of basis points, invariant in the token price and in the
// DAU. Unemitted PTP is forfeited, never carried forward: a pot that survives
// the epoch that funded it is the flat rule again under a different name.
//
// ── THE IDENTITY THAT ORGANISES EVERY CHOICE HERE ────────────────────────────
//
//   creatorTake  =  creatorBps  +  emissionCapBps x burnBps / 10000
//                =  what a sybil recovers from its own spending, exactly,
//                   once distribution weight is linear in PTP burned.
//
// There is one free number in this economy, not three. You cannot pay creators
// more than you are willing to let a self-dealing loop recover, because to the
// arithmetic they are the same transaction. This edition sets it to 6520 bps.
// Every split below is a consequence of that number and of the requirement that
// the four splits sum to 10000.
//
// ── REFUSAL CODES USED HERE ──────────────────────────────────────────────────
// This file does not import core/errors.mjs, for the same reason core/amm.mjs
// does not: it must load in a browser, a server and a chain builder with nothing
// behind it. It throws `new Error(code)` with one of these literal strings, and
// core/errors.mjs must carry an entry for each with its `why` and `fix`.
//
//   PARAMS_INVALID   an invariant assertion failed. The edition is not shippable
//                    and the module refuses to finish loading.
//   BAD_EPOCH        an epoch index is negative, fractional, or not a number.
//   BAD_AMOUNT       a wei quantity is negative or not a bigint.

// ── units ────────────────────────────────────────────────────────────────────

/** Basis-point denominator, the unit every split and ratio in this file uses. */
export const BPS = 10000n;

/** One PTP in wei. The token has 18 decimals (ARCHITECTURE section 1). */
export const WAD = 1000000000000000000n;

/** One euro in nanoeuros. The unit of account is the nanoeuro (section 3). */
export const NANO_EUR_PER_EUR = 1000000000n;

/** One bitcoin in satoshis. Both hops of the price rope pass through this. */
export const SAT_PER_BTC = 100000000n;

/** One CAP in its own smallest unit. CAP has 6 decimals (section 1). */
export const CAP_UNIT = 1000000n;

/**
 * An epoch is one day.
 *
 * Nothing in this file would break at another length, but four numbers below are
 * quoted per epoch and read as per day — the post lifetime, the emission decay
 * horizon of 365 epochs, the view cap per pair per epoch, and every EUR/day
 * figure in docs/ECONOMICS.md. Stating it here means those readings agree.
 *
 * Replay never consults a clock (ARCHITECTURE section 0). An epoch closes
 * because a closeEpoch act landed carrying a timestamp, not because this many
 * seconds elapsed while somebody was reading.
 */
export const EPOCH_SECONDS = 86400n;

// ── the price surface ────────────────────────────────────────────────────────
//
// Every user-visible price is a euro price held as an integer nanoeuro. The
// poster sets their own view price inside a published band; likes and comments
// are multiples of whatever that poster chose, so a poster who prices low prices
// their whole surface low and cannot sell cheap views alongside expensive
// comments.

/**
 * The default view price, 0.0001 EUR — one hundred micro-euros per billable
 * impression.
 *
 * This is the number the whole affordability case rests on. A viewer running the
 * calibrated honest day (150 views, 16 likes, 5 comments) pays 0.0410 EUR, which
 * is 1.23 EUR a month. The same day at 1,000 DAU produces 41.50 EUR of fee flow,
 * which reproduces the 41.60 EUR/day the failed calibration round measured on
 * the network it was modelling — so this price is anchored to an observation,
 * not chosen for how it reads.
 */
export const VIEW_PRICE_DEFAULT_NANO_EUR = 100000n;

/**
 * The band the poster may price inside: 0.00002 EUR to 0.0004 EUR, a 20x range.
 *
 * The band exists because a poster who cannot price cannot express anything, and
 * it is bounded because an unbounded band is a weapon. The 20x span was the
 * lever in the sharpest attack found against the proposed set: if distribution
 * weight had counted impressions, an attacker buying at the floor while honest
 * users bought at the ceiling would have taken 20x the weight per euro and
 * recovered 5.346x its spend. That attack is closed by making weight linear in
 * PTP burned rather than by narrowing the band, so the poster keeps the range.
 *
 * The band also sets what a creator must draw to break even. On views alone, at
 * a cost of 0.002012 EUR to publish a 2 MB picture and hold it for a day: 155
 * views at the floor, 31 at the default, 8 at the ceiling.
 */
export const VIEW_PRICE_MIN_NANO_EUR = 20000n;
export const VIEW_PRICE_MAX_NANO_EUR = 400000n;

/**
 * A like costs 10x the post's view price, a comment 20x.
 *
 * Expressed in basis points of the view price so they follow the poster's own
 * pricing rather than floating free of it. The ratio is a claim about attention:
 * a comment is a durable object other people read, a like is a signal, a view is
 * a glance. Pricing them 20:10:1 is what stops comment spam from being cheaper
 * than looking, and at the default price a comment is still 0.002 EUR.
 */
export const LIKE_MULTIPLIER_BPS = 100000n;
export const COMMENT_MULTIPLIER_BPS = 200000n;

/**
 * Publishing costs 0.002 EUR, flat, plus the first day's storage rent.
 *
 * This is the only anti-spam gate in the network and it is a real one: a poster
 * who draws fewer than 31 views at the default price loses money on the post. A
 * 50-post-per-day spammer drawing 2 views a post loses 2.48 EUR a month, and it
 * loses at every price it is allowed to set — 1.95 EUR/month at the floor,
 * 0.88 EUR/month at the ceiling.
 *
 * The honest limit, stated here because it is the weakest number in the file:
 * the gate makes spam unprofitable, not impossible. Fifty pictures a day costs
 * 0.10 EUR a day, and somebody willing to burn 3 EUR a month can post them. What
 * keeps that out of a feed is ranking, not price.
 *
 * The publish fee has no creator leg. A poster may not pay themselves, which is
 * why the four-way split is renormalised for this one act (see PUBLISH_SPLIT).
 */
export const PUBLISH_BASE_FEE_NANO_EUR = 2000000n;

/**
 * Storage rent, 0.000002 EUR per megabyte per day, charged on the replicated
 * size: megabytes x REPLICATION x days.
 *
 * A 2 MB picture held for a day at replication 3 costs 0.000012 EUR, which is
 * 0.6% of the publish fee. Rent is close to free on purpose. It was tempting to
 * raise it, because a failed gate reported a 5 GB contribution earning 0.3072
 * EUR a month against 1.08 EUR a month of electricity for an always-on device,
 * and raising the tariff would have made that headline go away. It was not
 * raised, because the headline was wrong twice: it priced PLEDGED capacity when
 * payment is for bytes SERVED, and it priced them at the nominal rent when 99.8%
 * of what a provider is paid is the capacity share of engagement. Measured on
 * the honest mix at 1,000 DAU, the effective rate is 0.000832 EUR per MB-day —
 * 416x this number — and the rent line is 0.24% of provider pay.
 *
 * Rent is not revenue. It funds that post's own capacity escrow and nothing
 * else, which is what makes the capacity leg unfarmable (see CAPACITY_PAYOUT).
 */
export const STORAGE_RENT_NANO_EUR_PER_MB_DAY = 2000n;

/**
 * The payout floor, 0.0001 EUR — one default view.
 *
 * It gates the PAYOUT and never the settle act. That distinction is a closed
 * attack, not a nicety. If the floor gated settlement, a post earning less than
 * one view could never settle, so its picture would never be redacted, its
 * tombstone never written, and its CAP never released — and pinning a terabyte
 * on other members' devices forever would cost an attacker 1,006 EUR once.
 * Below the floor the credit sweeps to burn and the post settles, redacts and
 * tombstones anyway. Settlement after the grace period is permissionless and is
 * always accepted.
 */
export const MIN_SETTLEMENT_NANO_EUR = 100000n;

/**
 * The one-time account bond, 0.50 EUR.
 *
 * It prices puppets. A 200-wallet farm posts 100 EUR before it acts, and the
 * volume needed to move real weight past the per-pair epoch cap needs roughly
 * 900 wallets, so about 457 EUR. The bond is not what makes the sybil loop lose
 * — the splits do that, and they do it per euro at every scale — the bond is
 * what makes it lose slowly enough to be visible.
 */
export const NEW_ACCOUNT_BOND_NANO_EUR = 500000000n;

// ── the four-way split ───────────────────────────────────────────────────────
//
// Every action's fee splits four ways and the four must sum to 10000 exactly.
// Two independent reviews arrived at different splits and BOTH of them put the
// creator take at 6520 bps to the basis point:
//
//   4000 + 6000 x 4200 / 10000  =  4000 + 2520  =  6520
//   4000 + 7000 x 3600 / 10000  =  4000 + 2520  =  6520
//
// The product emissionCapBps x burnBps is 25,200,000 in both, so every sybil
// result, every creator earnings figure and the epoch at which the schedule cap
// starts to bind are IDENTICAL between them. The sets are not rival economies;
// they differ in one thing only — whether 600 bps of every fee euro is destroyed
// or retained as pool depth.
//
// This edition takes the second, and the arithmetic that picks it is below at
// SPLIT_BURN_BPS.

/**
 * The creator's direct share, 4000 bps.
 *
 * Forty percent of every fee reaches the person whose picture was looked at, on
 * the spot, before any emission. Raising it raises the sybil recovery one for
 * one, because a self-dealing loop is its own creator; that is the identity at
 * the head of this file, and it is why this number cannot be argued about on its
 * own.
 */
export const SPLIT_CREATOR_BPS = 4000n;

/**
 * The burn share, 3600 bps — PTP destroyed forever by every action.
 *
 * The choice between 3600 here and the 4200 the first review kept is the only
 * real disagreement in the whole reconciliation, and it is settled by the
 * constraint the brief names as binding: the pool holds 900 EUR a side, and it
 * is thin.
 *
 * Per fee euro, the pool's PTP reserve falls by (1 - emissionCapBps/10000) x
 * burnBps, because the PTP that gets burned was bought out of the pool and the
 * PTP that gets emitted is minted outside it:
 *
 *   4200 burn at cap 6000:  0.40 x 4200 = 1680 bps destroyed per fee euro
 *   3600 burn at cap 7000:  0.30 x 3600 = 1080 bps destroyed per fee euro
 *
 * At 1,000 DAU that is 6.97 EUR a day of PTP taken out of a 900 EUR side against
 * 4.48 EUR a day — 0.775%/day versus 0.498%/day, a factor of 1.56. The 600 bps
 * that stops being destroyed becomes treasury, and at PROTOCOL_LIQUIDITY_BPS
 * four fifths of it becomes pool depth the protocol owns: 6.97 EUR a day added
 * instead of 3.74, which halves the time to double the pool from 241 days to
 * 129.
 *
 * Nothing is given up for it. The creator take is unchanged at 6520 bps, the
 * maximally integrated attacker still loses 31.80%, the schedule cap still
 * starts to bind at the same fee flow of 714 EUR/day, and the economy is still
 * strictly deflationary at every DAU. The only thing that changes is that PTP is
 * destroyed more slowly and the market it trades in gets deeper faster.
 *
 * The reason to want the slower destruction is not caution. Any positive net
 * destruction against a pool of fixed depth appreciates the token mechanically,
 * and at 1,000 DAU the measured first-year appreciation is roughly an order of
 * magnitude either way. That is a windfall to whoever holds at genesis and it
 * sits badly against ARCHITECTURE section 13, which says PTP is not an
 * investment. No value of emissionCapBps removes it. The two levers that reduce
 * it are the net destruction rate and the depth, and this edition moves both.
 */
export const SPLIT_BURN_BPS = 3600n;

/**
 * The capacity share, 300 bps — the money that pays members for holding and
 * serving each other's pictures.
 *
 * Small as a fraction and large as a rate. Three percent of a 0.0001 EUR view of
 * a 2 MB picture is 1.5e-6 EUR per megabyte served, and because the network
 * egresses about 200 MB for every MB-day it stores, that works out to 0.000832
 * EUR per MB-day at 1,000 DAU. This is an egress economy wearing a storage
 * economy's units, which is the single fact that resolves the failed capacity
 * gate.
 *
 * An attacker running the storage nodes that hold its own posts recovers this
 * leg too, which is why the honest sybil figure is 6820 bps and not 6520, and
 * why assertInvariants checks the inequality with this leg included.
 */
export const SPLIT_CAPACITY_BPS = 300n;

/**
 * The treasury share, 2100 bps — graph compute and protocol-owned liquidity.
 *
 * It is the residual: 10000 - 4000 - 3600 - 300. It is not free money. At
 * PROTOCOL_LIQUIDITY_BPS, 1680 bps of every fee euro becomes pool depth held as
 * shares, and only 420 bps is spendable — about 1.74 EUR a day at 1,000 DAU.
 * That is thin, and it is affordable only because this network has almost no
 * running cost by construction: static files on hosts nobody here owns, pictures
 * on members' devices, and a chain builder that is a script.
 *
 * The honest consequence of coupling emission to burn is recorded here because
 * this is where it lands: emission is no longer a growth subsidy. At 10 DAU it
 * is 0.105 EUR an epoch across every creator in the network. Growth has to be
 * paid for out of this line, and this line is small.
 */
export const SPLIT_TREASURY_BPS = 2100n;

/**
 * The publish fee renormalised over three ways, because a poster may not pay
 * themselves.
 *
 * The creator leg is removed and the remaining three are scaled to sum to 10000
 * again: 3600/300/2100 over a base of 6000 gives 6000/500/3500. A publish fee
 * with a creator leg would be a poster paying themselves 40% to post, which is a
 * faucet that needs no viewer at all.
 *
 * The rent charged alongside the publish fee is not split. It goes whole to that
 * post's own capacity escrow.
 */
export const PUBLISH_SPLIT_BURN_BPS = 6000n;
export const PUBLISH_SPLIT_CAPACITY_BPS = 500n;
export const PUBLISH_SPLIT_TREASURY_BPS = 3500n;

// ── emission ─────────────────────────────────────────────────────────────────

/**
 * The genesis supply, 10,000 PTP, all of it in the pool.
 *
 * Nobody is allocated anything. The only PTP that exists on day one is the side
 * of the pool it opens against, and the only way to hold any is to buy it with
 * bitcoin.
 */
export const GENESIS_SUPPLY_PTP = 10000n;

/**
 * The first year's per-epoch emission CEILING, 2000 PTP.
 *
 * Read the word ceiling. Under the flat rule this was a quantity minted every
 * epoch whether or not anybody did anything; it is now the upper rail of a
 * min(), and the coupled term is what actually determines emission at every
 * realistic level of activity.
 *
 * It was expected to be decorative and it is not. The coupled term reaches this
 * rail at a burn of 2857 PTP an epoch, which is a fee flow of 7937 PTP an epoch
 * — 714 EUR a day at the genesis price, about 17,200 DAU. The rail matters most
 * on day one at scale, because the maximum burn an epoch can possibly produce is
 * itself bounded by the pool's PTP reserve, and a launch into a large audience
 * against a 900 EUR side can ask for nearly the whole ceiling immediately.
 *
 * Above the rail the min() only ever makes an attacker poorer: emission falls
 * from 25.20% of fee value to 21.69% at 20,000 DAU, 8.67% at 50,000 and 2.17% at
 * 200,000, taking the maximally integrated attacker's recovery from 68.20% down
 * to 45.17%. This is why it must stay min() and never max().
 */
export const EPOCH_EMISSION_PTP = 2000n;

/**
 * The schedule decays by 9/10 every 365 epochs, held as a rational so the decay
 * is computed in integers and never in a float.
 *
 * Inherited from the predecessor economy, where the same 0.9-per-year shape ran
 * against a fixed cap. It survives here because the closed form is exact and
 * because a schedule that halves quickly would make the launch rail bind for
 * longer than the launch.
 */
export const EMISSION_DECAY_NUM = 9n;
export const EMISSION_DECAY_DEN = 10n;
export const EMISSION_DECAY_EPOCHS = 365n;

/**
 * The coupling constant, 7000 bps: an epoch may emit at most 70% of the PTP it
 * destroyed.
 *
 * This is the parameter the whole correction turns on, and three separate facts
 * pin it rather than one.
 *
 * It must be below 10000 or deflation stops being structural. Net supply change
 * is (emissionCapBps/10000 - 1) x burned, which is zero at exactly 10000 and
 * positive above it. Note what does NOT force the bound: at these splits the
 * sybil loop stays loss-making all the way to 15,833 bps, so it is the deflation
 * property and not the sybil property that puts the ceiling at 10000. The two
 * invariants are checked separately for that reason.
 *
 * Its product with the burn share is fixed at 25,200,000 by the creator take.
 * Given SPLIT_BURN_BPS of 3600 that makes 7000 the only value consistent with
 * paying creators 6520 bps, which is the number both reviews independently
 * defended as the most that can be paid while a self-dealing loop still loses at
 * least 30% of every euro it spends. Measured loss at D = 1, with the attacker
 * also running the storage nodes holding its own posts: 31.80%.
 *
 * It leaves room for a bad edit. If somebody set this to the legal ceiling of
 * 9999 the attacker would still lose 21.0% at these splits, against 15.0% at the
 * alternative splits — 6 points of extra margin against a fat finger, for free.
 */
export const EMISSION_CAP_BPS = 7000n;

/**
 * A burn spike may lift emission by at most 1.5x the median of the previous
 * seven epochs.
 *
 * Emission reads no oracle, so an oracle lie cannot flip the sign of any
 * property in this file — but it can change the SCALE of an epoch, and so can a
 * one-epoch wash. Without this rail a single distorted epoch converts straight
 * into a single distorted emission. With it, converting a sustained distortion
 * costs a sustained lie.
 *
 * It is a third term inside the same min(), so it can only ever lower emission
 * and therefore cannot break any property that is stated as an upper bound —
 * which is all of them. The cost is real and is stated plainly: a genuine viral
 * day at three times normal activity emits only 1.5x, and the difference is
 * forfeited, not deferred. The epoch is simply more deflationary than the
 * coupling alone would make it.
 *
 * When there is no history the rail is inactive rather than binding at zero. A
 * median of zero means there is no baseline to spike against, and a rule that
 * emitted nothing after seven quiet epochs would punish a network waking up.
 */
export const EMISSION_BURN_SPIKE_CAP_BPS = 15000n;
export const EMISSION_BURN_SPIKE_MEDIAN_EPOCHS = 7n;

/**
 * Unemitted PTP is forfeited, never carried forward.
 *
 * A roll-forward would rebuild the thing this edition exists to remove: a pot
 * that exists independently of the burn in the epoch it is paid out of. The
 * predecessor's rounding dust and empty epochs carried over, which was correct
 * for a flat schedule and is exactly wrong for a coupled one.
 */
export const EMISSION_ROLL_FORWARD = false;

/**
 * The lifetime ceiling, 7,310,000 PTP.
 *
 * The closed form is exact: 365 epochs a year at 2000 PTP, decaying 9/10 a year,
 * sums to 365 x 2000 x 1/(1 - 9/10) = 7,300,000, and the 10,000 genesis PTP
 * makes 7,310,000. assertInvariants recomputes that identity from the three
 * schedule constants, so an edit to any of them that breaks the cap will not
 * load.
 *
 * In integers the schedule never reaches it. Summed epoch by epoch in wei until
 * the schedule truncates to zero at year 466, the total is 83,585 wei short of
 * the closed form — the ceiling is an upper bound, approached and not touched.
 *
 * Under coupling the binding fact is far stronger than the ceiling and it is
 * worth stating in the same breath, because the ceiling is the weaker of two
 * true things. Supply obeys
 *
 *   supply = 10,000 - (1 - emissionCapBps/10000) x cumulative burn
 *
 * so total supply is monotonically non-increasing from 10,000 PTP and 7,310,000
 * is unreachable by construction, not merely unreached. The honest headline is
 * not "capped at 7.31 million" but "starts at ten thousand and only ever falls".
 */
export const MAX_SUPPLY_PTP = 7310000n;

// ── distribution weight ──────────────────────────────────────────────────────
//
// Emission is split among creators by the PTP that engagement with their
// pictures destroyed. Not by impressions, not by unique viewers, not by account
// count, not by balance. ARCHITECTURE rule 4 states this as law — a stake split
// across twenty puppets weighs exactly what one account holding it weighs — and
// the three parameters below are all consequences of applying it to the money.

/**
 * Weight is measured in PTP burned. This is the whole anti-sybil argument.
 *
 * The bound at the head of this file assumes every euro buys the same weight.
 * The moment it does not, the real condition is
 *
 *   creatorBps + emissionCapBps x burnBps x r / 10000 < 10000
 *
 * where r is the attacker's weight-per-euro advantage, and it breaks at
 * r = 2.381. Three separate mechanisms in the proposed set handed out more than
 * that: counting impressions across a 20x price band gave r up to 20, per-pair
 * decay in the weight gave r up to 3.867, and converting fees at the live pool
 * spot gave r = 10 for a 90% self-created dip. Burn-linear weight sets r to
 * exactly 1 for the first two and FEE_PRICE_SOURCE closes the third, after which
 * the bound is not an approximation of the attacker's position — it is the
 * attacker's position.
 */
export const WEIGHT_BASIS = 'burnWei';

/**
 * The repeat-view creator decay, ZERO. This overrides ARCHITECTURE section 4 on
 * measured grounds and the override is deliberate.
 *
 * Section 4 sets it to 1.0 and gives the reason: ten views from one admirer
 * should lose to one view from ten people, while the admirer still pays ten
 * times. The intuition is sound and it belongs in feed ranking, where audience
 * breadth is a quality signal and moves no money. In the distribution weight it
 * does the opposite of what it is for.
 *
 * At 1.0 it prices puppet count. Twelve views on one pair credit H(12) = 3.1032
 * where twelve views on twelve pairs credit 12, so an attacker who spreads the
 * same spend across more accounts buys 3.867x the weight per euro and the loop
 * turns profitable at 1.3745x recovery. Routing the withheld creator remainder
 * into the burn — the cleverest available repair, and it does work — pulls that
 * back to a 1.15x advantage at these splits, still loss-making at worst but
 * still 15% off Rule 4's "exactly".
 *
 * It buys nothing, because the self-view loop already loses 34.80% per cycle at
 * zero. And it taxes the one thing the product wants: a genuine repeat viewer
 * pays full price every time, and at 1.0 their twelfth view credits the creator
 * 0.0833 of their first.
 *
 * The rate limiter is the hard cap, not the decay. Below MAX_VIEWS_PER_PAIR_PER_EPOCH
 * every accepted view is worth what it cost; at the cap the act is refused, so
 * it earns nothing and costs nothing. The ratio among accepted acts stays 1.
 */
export const VIEW_REPEAT_DECAY_ALPHA = 0n;

/**
 * Per-pair damping in the distribution weight, ZERO. Same override, same reason,
 * this time against ARCHITECTURE section 8's second fixed shape.
 *
 * At the proposed 0.25 an attacker spreading 1200 views one per puppet instead
 * of twelve per puppet took 2.02x the weight, which cut the loss from 31.80% to
 * 6.09% — four fifths of the entire margin. At 0.5 the sybil loop is outright
 * profitable at 112.35% recovery. A damping term whose purpose is to punish
 * concentration rewards dispersal by construction, and dispersal is what a farm
 * is made of.
 *
 * It survives as a FEED RANKING parameter, where the same intuition is correct
 * and where it moves no money.
 */
export const PAIR_DIMINISHING_BETA = 0n;

/**
 * The quality exponent, ZERO, and this is the one number that must never be
 * nudged upward "a little".
 *
 * Under the reading where unique viewers multiply a creator's weight by U^q, a
 * farm chooses the sock ratio, so it chooses the multiplier. With 1,000 socks
 * any q above about 0.118 pays; with a million socks any q above 0.059 pays. The
 * critical q falls as the farm grows, so there is no safe positive value — only
 * values that are safe against farms smaller than the one that will show up.
 * Under the alternative reading where the exponent applies to aggregate weight,
 * splitting one creator identity n ways gains n^(1-q), so every q below 1 pays
 * for splitting.
 *
 * Zero is the unique value that is neutral under both readings: a split gain of
 * exactly 1 for every sock count, at every scale. It is not a tuning parameter.
 * It is a hole that has been filled in, and it is written as an integer so that
 * nobody types 0.1 into it.
 */
export const QUALITY_EXPONENT = 0n;

/**
 * At most twelve billable views of the same (viewer, post) pair per epoch, and
 * at least 900 seconds between them.
 *
 * Twelve views at fifteen-minute spacing is three hours of a day, so the count
 * is the binding limit and the cooldown is what stops a burst. Together they are
 * the rate limiter that the removal of the two decay terms leaves standing, and
 * they are the right shape for it: a refusal costs nothing and earns nothing,
 * where a decay charges full price for a discounted credit.
 */
export const MAX_VIEWS_PER_PAIR_PER_EPOCH = 12n;
export const VIEW_COOLDOWN_SEC = 900n;

/**
 * A billable impression needs 60% of the viewport for 1500 continuous
 * milliseconds.
 *
 * ARCHITECTURE section 4 names both thresholds and no lens pinned either value.
 * They are product numbers, not economic ones: they change how many views
 * qualify, never what one costs or what it is worth, and every result in this
 * file is invariant to them. They are here because replay cannot validate a view
 * act without them, and a threshold that lives in the client is a threshold two
 * readers can disagree about.
 */
export const VIEW_MIN_VIEWPORT_PCT = 60n;
export const VIEW_DWELL_MS = 1500n;

// ── the pool ─────────────────────────────────────────────────────────────────

/**
 * The swap fee, 30 bps, Uniswap-V2's number. core/amm.mjs restates it as a
 * literal so it can load alone; this is the authority and the two must agree.
 */
export const SWAP_FEE_BPS = 30n;

/**
 * Four fifths of the treasury becomes protocol-owned liquidity.
 *
 * Depth is the binding constraint of this whole design and this is the only
 * parameter that addresses it directly. At 1,000 DAU it adds 6.97 EUR a day to a
 * pool holding 900 EUR a side, which doubles the depth in 129 days; at the
 * alternative 6000 bps against a smaller treasury it adds 3.74 EUR a day and
 * takes 241.
 *
 * The mechanism, because it is not obvious: the treasury is paid in PTP and a
 * proportional deposit needs both sides, so the treasury sells half its POL
 * allocation into the pool for satoshis and deposits both halves back. The net
 * effect on the satoshi side is zero and the net effect on the PTP side is the
 * whole allocation, so POL deepens the pool without ever asking it for bitcoin.
 * The shares are held by the protocol and the growth in k accrues to them.
 *
 * If the treasury's operating line ever proves too thin, this is the number to
 * move. The splits above cannot be moved to fund operations, because they carry
 * the sybil identity.
 */
export const PROTOCOL_LIQUIDITY_BPS = 8000n;

/** Genesis liquidity, restated from ARCHITECTURE section 2 and core/amm.mjs. */
export const GENESIS_SAT = 1000000n;
export const GENESIS_PTP_WEI = 10000n * WAD;

/**
 * The margin a self-dealing loop must lose: 3000 bps of every euro it spends.
 *
 * The inequality the brief states is a SIGN test — it asks whether the loop pays
 * for itself, and it is satisfied by a set that recovers 99.99% as surely as by
 * one that recovers 68%. That is not enough to ship on. A margin of four basis
 * points is inside the error bars on D, on any weight implementation, and on
 * whether an attacker can also capture the capacity leg.
 *
 * Both reviews independently used the same selection rule for emissionCapBps:
 * take the largest value that keeps the maximally integrated attacker — D = 1,
 * running the storage nodes that hold its own posts — losing at least 30%. This
 * edition measures 31.80%, so it clears the floor by 180 bps. Recording the rule
 * as an assertion rather than as a paragraph is what stops the next edit from
 * spending the margin without noticing it had one.
 */
export const SYBIL_LOSS_FLOOR_BPS = 3000n;

// ── the price rope ───────────────────────────────────────────────────────────

/**
 * The satoshi intermediate is published at 1e8 sub-satoshi resolution, and the
 * settling conversion is a single fused rational.
 *
 * This is the most severe finding in either review and it is an arithmetic bug,
 * not a parameter choice. At 90,000 EUR/BTC one satoshi is 900,000 nanoeuros, so
 * the two-hop rope in ARCHITECTURE section 3 — nanoeuro to integer satoshi to
 * wei — truncates the view price floor (0.0222 sat), the default (0.1111), the
 * ceiling (0.4444), the storage rent (0.0022) and the settlement floor (0.1111)
 * ALL TO ZERO, and under-charges likes and comments by exactly 10%. Section 3's
 * own underflow rule then substitutes 1 wei, which at the genesis price is
 * 9.0e-20 EUR — a discount of 1.1e15, which is the sybil faucet the rule was
 * written to prevent. Every fee in this file, as specified, does not exist.
 *
 * The failure is on the bitcoin side and has nothing to do with the PTP price,
 * so raising view prices does not fix it and neither does a deeper pool.
 *
 * core/pricing.mjs must therefore evaluate the conversion as ONE rational:
 *
 *   wei = nanoEur x 1e8 x poolPtpWei / (eurPerBtcNano x poolSat)
 *
 * with the intermediate satoshi never materialised. Swept across every priced
 * item at one, ten, a hundred, a thousand and a million times the genesis price,
 * the smallest value that form produces anywhere is 22,222,222 wei. The two-hop
 * form returns zero in twenty cells out of twenty, at every price.
 *
 * Both hops stay public, as section 3 requires — the satoshi hop is published at
 * the sub-satoshi scale below, where the view price floor is 2,222,222 units
 * with no error at all. What is forbidden is settling money through it.
 */
export const SAT_SCALE_EXP = 8n;
export const SAT_SCALE = 100000000n;

/**
 * Fees convert at one price sealed per epoch, a whole-epoch time-weighted
 * average, and never at the live pool spot.
 *
 * ARCHITECTURE section 3 already seals the EUR/BTC hop. It does not seal the
 * second hop, and the second hop is the one an attacker owns: with burn-linear
 * weight, weight equals fee euros divided by price, so an actor converting at a
 * lower price than everybody else buys r = p_others / p_attacker weight per
 * euro. A 58% self-created dip inside one epoch is break-even and a 90% dip
 * returns 292% of the spend, for a wash costing 3.70 EUR in a 900 EUR pool. Left
 * open, burn-linear weight is WORSE than impression weight, because the attacker
 * controls the denominator.
 *
 * A whole-epoch average sealed into the block makes r exactly 1 for every actor,
 * by construction. Sustaining a 50% depression for a full epoch costs at least
 * 9.50 EUR against six arbitrage rounds a day and at least 151.92 EUR against
 * ninety-six. A close-of-epoch snapshot is NOT sufficient — it is sandwichable
 * inside one block.
 *
 * The average is computed over the acts of the closed epoch and used to price
 * the next one, so it stays a pure function of the log and replay never consults
 * a clock.
 */
export const FEE_PRICE_SOURCE = 'epochSealedTwap';
export const POOL_TWAP_EPOCHS = 1n;

/**
 * The oracle: five independent sources, a quorum of three, a 10% per-epoch move
 * clamp, and every source's value sealed in the block.
 *
 * Section 3 asks for a median of at least three; five with a quorum of three is
 * strictly tighter and satisfies it. Oracle manipulation cannot flip the sign of
 * any property here — emission reads no oracle and every property is a ratio of
 * basis points, checked across seventeen oracle multipliers spanning four orders
 * of magnitude with zero sign flips — but it does change the scale of an epoch,
 * and a 50% low lie doubles fees in satoshis and therefore doubles burn.
 *
 * The clamp has a cost worth stating: in a genuine bitcoin move of more than 10%
 * in a day, the rate lags and fees are mispriced until it catches up, three
 * epochs for a 30% move. That is a bounded and public error, and it is the
 * cheaper side of the trade against an unclamped rate a manipulator can steer.
 *
 * Sealing per-source values rather than only the median makes a lie attributable
 * to a named source instead of merely detectable in aggregate.
 */
export const ORACLE_MIN_SOURCES = 5n;
export const ORACLE_QUORUM = 3n;
export const ORACLE_MAX_MOVE_BPS = 1000n;
export const ORACLE_SEAL_PER_SOURCE_VALUES = true;

// ── capacity ─────────────────────────────────────────────────────────────────

/** One CAP is one MB-day, held at CAP's six decimals. */
export const CAP_COIN_PER_MB_DAY = 1000000n;

/** Every picture is held by three nodes. Placement is rendezvous (section 7). */
export const REPLICATION = 3n;

/**
 * Capacity is paid PER POST, out of that post's own escrow, and never out of a
 * global pot.
 *
 * A pot divided pro rata by bytes stored pays for something cheap to
 * manufacture. At 1,000 DAU a griefer posting 10 MB pictures nobody looks at,
 * holding 90% of the network's stored bytes, spends 0.1449 EUR a day and
 * extracts 0.6677 — a 361% return — while diluting every honest provider. Paid
 * per post, the same attack yields 0.0189 EUR against the same cost and loses.
 *
 * Each post carries two escrows and they are funded differently on purpose:
 *
 *   HOLDING is that post's own rent, released to the nodes proven to hold its
 *   shards, pro rata by proven MB-days and capped at the tariff actually
 *   charged. You cannot draw more rent than was paid. Where fewer nodes prove
 *   than REPLICATION asks for, the surplus is swept to burn rather than shared
 *   among the survivors, so under-replication destroys money instead of paying a
 *   bonus for it.
 *
 *   SERVING is the capacity share of that post's own engagement, released to the
 *   nodes that actually delivered the bytes. It is not capped by the rent
 *   tariff, and it does not need to be: it is bounded by what that post's own
 *   viewers paid, and it is attested by an unrelated third party — the viewer —
 *   so a node that never served is never named.
 *
 * This is what makes the effective rate 416x the nominal rent without the rent
 * being a lie. Both lines are honest; they are paid for different work.
 */
export const CAPACITY_PAYOUT = 'perPostEscrow';
export const CAPACITY_HOLDING_CAP_NANO_EUR_PER_MB_DAY = 2000n;
export const CAPACITY_SURPLUS_TO = 'burn';

/**
 * A pledge posts 0.20 EUR of bond per gigabyte, and the bond is slashable rather
 * than refundable.
 *
 * Rendezvous placement is a pure function of node id, so k invented ids win k
 * independent placements. Twenty of them cost 10 EUR and, against a refundable
 * bond and a pro-rata pot, took a sixth of the pot forever with a payback under
 * five days. Per-post escrow removes most of the prize; what remains is a
 * durability fraud rather than a payment one — three replicas answered from one
 * disk is one disk pretending to be three, and the network's promise of three
 * independent holders quietly becomes a promise of one.
 *
 * The proof that distinguishes them is latency. Random byte-range challenges
 * issued concurrently and bounded at two seconds are answerable by three disks
 * and not by one, so one disk's own IOPS becomes the distinctness test. A bond
 * that is slashed rather than returned is what makes failing that test cost
 * something.
 */
export const CAP_PLEDGE_BOND_NANO_EUR_PER_GB = 200000000n;
export const CAP_PLEDGE_BOND_SLASHABLE = true;
export const CAP_PROOF_LATENCY_BOUND_MS = 2000n;

/**
 * The client never serves shards over a metered connection.
 *
 * Serving pays 1.5e-6 EUR per megabyte. A 5 EUR-per-gigabyte mobile plan costs
 * 0.004883 EUR per megabyte. A member serving on that plan pays 3,255 times what
 * they earn, and they would have no way of knowing. This is the one parameter in
 * the file that protects the member from the network rather than the network
 * from an attacker, and it defaults to off for that reason.
 */
export const SERVE_ON_METERED_CONNECTION = false;

// ── the post lifecycle ───────────────────────────────────────────────────────

/**
 * A post lives one day and settles an hour after it lapses.
 *
 * The grace period exists because settlement is an act rather than a timer
 * (ARCHITECTURE section 6): somebody has to send it, and an hour is enough for
 * the author, the client's auto-extend, or any passer-by to do so. After the
 * grace anybody may settle, and the settle act is always accepted.
 */
export const POST_DEFAULT_LIFETIME_SEC = 86400n;
export const SETTLEMENT_GRACE_SEC = 3600n;

/**
 * The creator's credit accrues in PTP WEI at the instant of each action, not in
 * nanoeuros converted at settlement.
 *
 * ARCHITECTURE section 5 gives the post a creditNano field and the natural
 * reading is that a euro amount is owed and converted when the post settles.
 * That reading hands the creator a free option: depress the price, settle,
 * restore. Break-even is a credit of 1.58 EUR, and many posts can settle inside
 * one depression, so the cost of the wash amortises toward zero.
 *
 * Accruing the wei the viewer actually paid closes it completely and is also
 * simply true — those wei exist, they arrived, and the protocol never owes a
 * euro amount it did not receive. grossNano and creditNano survive as the
 * display and audit accumulators; creditWei is the one that pays.
 */
export const CREATOR_CREDIT_UNIT = 'wei';

/** The settlement floor gates the payout only. Dust below it is burned. */
export const MIN_SETTLEMENT_GATES = 'payout';
export const SETTLEMENT_DUST_SWEEP_TO = 'burn';

// ── the edition ──────────────────────────────────────────────────────────────

/**
 * Every constant above, in one frozen object, in the shape the epoch block seals
 * as `constants`. A block that carries this is a block whose numbers can be
 * recomputed by somebody who has nothing of ours.
 */
export const PARAMS = Object.freeze({
  epochSeconds: EPOCH_SECONDS,

  viewPriceDefaultNanoEur: VIEW_PRICE_DEFAULT_NANO_EUR,
  viewPriceMinNanoEur: VIEW_PRICE_MIN_NANO_EUR,
  viewPriceMaxNanoEur: VIEW_PRICE_MAX_NANO_EUR,
  likeMultiplierBps: LIKE_MULTIPLIER_BPS,
  commentMultiplierBps: COMMENT_MULTIPLIER_BPS,
  publishBaseFeeNanoEur: PUBLISH_BASE_FEE_NANO_EUR,
  storageRentNanoEurPerMbDay: STORAGE_RENT_NANO_EUR_PER_MB_DAY,
  minSettlementNanoEur: MIN_SETTLEMENT_NANO_EUR,
  newAccountBondNanoEur: NEW_ACCOUNT_BOND_NANO_EUR,

  splitCreatorBps: SPLIT_CREATOR_BPS,
  splitBurnBps: SPLIT_BURN_BPS,
  splitCapacityBps: SPLIT_CAPACITY_BPS,
  splitTreasuryBps: SPLIT_TREASURY_BPS,
  publishSplitBurnBps: PUBLISH_SPLIT_BURN_BPS,
  publishSplitCapacityBps: PUBLISH_SPLIT_CAPACITY_BPS,
  publishSplitTreasuryBps: PUBLISH_SPLIT_TREASURY_BPS,

  genesisSupplyPtp: GENESIS_SUPPLY_PTP,
  epochEmissionPtp: EPOCH_EMISSION_PTP,
  emissionDecayNum: EMISSION_DECAY_NUM,
  emissionDecayDen: EMISSION_DECAY_DEN,
  emissionDecayEpochs: EMISSION_DECAY_EPOCHS,
  emissionCapBps: EMISSION_CAP_BPS,
  emissionBurnSpikeCapBps: EMISSION_BURN_SPIKE_CAP_BPS,
  emissionBurnSpikeMedianEpochs: EMISSION_BURN_SPIKE_MEDIAN_EPOCHS,
  emissionRollForward: EMISSION_ROLL_FORWARD,
  maxSupplyPtp: MAX_SUPPLY_PTP,

  weightBasis: WEIGHT_BASIS,
  viewRepeatDecayAlpha: VIEW_REPEAT_DECAY_ALPHA,
  pairDiminishingBeta: PAIR_DIMINISHING_BETA,
  qualityExponent: QUALITY_EXPONENT,
  maxViewsPerPairPerEpoch: MAX_VIEWS_PER_PAIR_PER_EPOCH,
  viewCooldownSec: VIEW_COOLDOWN_SEC,
  viewMinViewportPct: VIEW_MIN_VIEWPORT_PCT,
  viewDwellMs: VIEW_DWELL_MS,

  swapFeeBps: SWAP_FEE_BPS,
  protocolLiquidityBps: PROTOCOL_LIQUIDITY_BPS,
  genesisSat: GENESIS_SAT,
  genesisPtpWei: GENESIS_PTP_WEI,

  satScaleExp: SAT_SCALE_EXP,
  feePriceSource: FEE_PRICE_SOURCE,
  poolTwapEpochs: POOL_TWAP_EPOCHS,
  oracleMinSources: ORACLE_MIN_SOURCES,
  oracleQuorum: ORACLE_QUORUM,
  oracleMaxMoveBps: ORACLE_MAX_MOVE_BPS,
  oracleSealPerSourceValues: ORACLE_SEAL_PER_SOURCE_VALUES,

  capCoinPerMbDay: CAP_COIN_PER_MB_DAY,
  replication: REPLICATION,
  capacityPayout: CAPACITY_PAYOUT,
  capacityHoldingCapNanoEurPerMbDay: CAPACITY_HOLDING_CAP_NANO_EUR_PER_MB_DAY,
  capacitySurplusTo: CAPACITY_SURPLUS_TO,
  capPledgeBondNanoEurPerGb: CAP_PLEDGE_BOND_NANO_EUR_PER_GB,
  capPledgeBondSlashable: CAP_PLEDGE_BOND_SLASHABLE,
  capProofLatencyBoundMs: CAP_PROOF_LATENCY_BOUND_MS,
  serveOnMeteredConnection: SERVE_ON_METERED_CONNECTION,

  postDefaultLifetimeSec: POST_DEFAULT_LIFETIME_SEC,
  settlementGraceSec: SETTLEMENT_GRACE_SEC,
  creatorCreditUnit: CREATOR_CREDIT_UNIT,
  minSettlementGates: MIN_SETTLEMENT_GATES,
  settlementDustSweepTo: SETTLEMENT_DUST_SWEEP_TO,
});

// ── the emission rule ────────────────────────────────────────────────────────

function needEpoch(epoch) {
  if (typeof epoch === 'bigint') {
    if (epoch < 0n) throw new Error('BAD_EPOCH');
    return epoch;
  }
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error('BAD_EPOCH');
  }
  // Epoch counters reach this file from World.epoch.n, which is a plain number.
  // Accepting both types here rather than demanding a bigint keeps the coercion
  // inside the module that knows what an epoch is, instead of scattering it
  // across every call site, which is where that kind of mistake lives.
  return BigInt(epoch);
}

function needWei(wei) {
  if (typeof wei !== 'bigint' || wei < 0n) throw new Error('BAD_AMOUNT');
  return wei;
}

/**
 * The scheduled ceiling for an epoch, in wei.
 *
 *   scheduledCap(epoch) = epochEmissionPtp x (9/10)^floor(epoch / 365)
 *
 * The decay is exact until the single truncating division at the end. The
 * numerator carries the full 9^y and the denominator the full 10^y, so no
 * intermediate rounds and the result depends on no engine's idea of a power.
 * Computing in wei rather than in whole PTP is what buys the precision: the
 * schedule stays non-zero until year 466, where truncating in whole PTP would
 * have flattened it to zero at year 73.
 *
 * Under the coupled rule this is a rail and not a quantity. It is reached only
 * where a single epoch destroys more than 2857 PTP, and above that point it
 * makes emission a shrinking fraction of fee value — which makes an attacker
 * poorer, never richer. That is the whole reason it is a min().
 */
export function scheduledCap(epoch) {
  const e = needEpoch(epoch);
  const years = e / EMISSION_DECAY_EPOCHS;
  const numerator = EPOCH_EMISSION_PTP * WAD * EMISSION_DECAY_NUM ** years;
  return numerator / EMISSION_DECAY_DEN ** years;
}

/**
 * What an epoch may emit, in wei:
 *
 *   min( scheduledCap(epoch),  emissionCapBps/10000 x burnedPtpWei )
 *
 * and, when the caller supplies a median, a third term inside the same min()
 * that stops a one-epoch burn spike becoming a one-epoch emission spike.
 *
 * `burnedPtpWei` is PTP ACTUALLY DESTROYED by the burn share of the acts in this
 * epoch. Not fees collected, not fees owed, not a euro amount — the quantity
 * that left the supply. This function reads no oracle, no pool and no price, and
 * that is what makes every property below invariant in the token price:
 *
 *   Deflation is structural. net = emitted - burned <= (7000/10000 - 1) x burned
 *   <= 0, with equality only when nothing was burned. There is no break-even
 *   DAU, at any price, because burned cancels out of the ratio.
 *
 *   Bootstrap is safe. Zero activity burns nothing, so this returns zero. There
 *   is no pot on day one, which is the whole of the fix to a predecessor that
 *   handed a single account 180 EUR a day for a 0.0001 EUR spend.
 *
 *   The sybil loop cannot pay. What comes back is at most creatorBps x D +
 *   emissionCapBps x burnBps / 10000, and assertInvariants holds that below
 *   10000 for D = 1, the attacker's best case.
 *
 * `medianBurnedPtpWei` is the median burn of the previous seven epochs. Zero
 * means no history, and then the spike rail does not apply: with no baseline
 * there is nothing to spike against, and binding at zero would refuse to pay a
 * network that just woke up.
 *
 * Whatever the rails withhold is forfeited. It is not minted, not banked, and
 * not owed to a later epoch.
 */
export function emission(epoch, burnedPtpWei, medianBurnedPtpWei = 0n) {
  const burned = needWei(burnedPtpWei);
  const median = needWei(medianBurnedPtpWei);

  // The spike rail caps the INPUT, so the coupling still reads a real burn
  // quantity and the two rails compose as a single min() rather than as a
  // discount applied twice.
  let effective = burned;
  if (median > 0n) {
    const ceiling = (EMISSION_BURN_SPIKE_CAP_BPS * median) / BPS;
    if (effective > ceiling) effective = ceiling;
  }

  // Truncating down, which favours the supply. An emission that rounded up
  // would be a rounding rule that mints.
  const coupled = (EMISSION_CAP_BPS * effective) / BPS;
  const scheduled = scheduledCap(epoch);
  return coupled < scheduled ? coupled : scheduled;
}

/**
 * One creator's rebate, before the epoch rail: the fraction of the burn THEIR
 * OWN content caused that comes back to them as newly minted PTP.
 *
 *   rebate_i = emissionCapBps/10000 x burnWei_i
 *
 * THIS IS THE FUNCTION THE SYBIL BOUND RESTS ON, and the reason it takes one
 * creator's burn rather than the epoch's is the single most load-bearing
 * decision in this economy. It was reached by measurement, three times, from
 * three directions:
 *
 *   * As a POT distributed by relative weight, a self-dealer's recovery is
 *     creatorBps + emissionCapBps x burnBps/10000 x r, where r is their
 *     weight-per-euro advantage over honest creators. Break-even is r = 2.381,
 *     and a pot hands out r up to 20 — through the 20x view-price band, through
 *     any repeat-decay rule, and through any conversion at live pool spot.
 *   * Equivalently, the bound degrades to creatorBps + kappa x burnBps / rho,
 *     where rho is the honest share of credited fees. That breaches 1.0 once an
 *     attacker is a sixth of the volume.
 *   * Measured directly: a 200-wallet farm recovered 190% of spend at 100 DAU
 *     under a pot.
 *
 * All three say one thing: UNDER A POT, AN ATTACKER EXTRACTS OTHER PEOPLE'S
 * BURN. Per creator, r and rho do not appear in the algebra at all — nobody
 * competes for anybody else's rebate, so an account can only ever be handed
 * back a fraction of what it itself destroyed. Recovery is then bounded by
 * creatorBps x D + emissionCapBps x burnBps/10000 < 10000 at every DAU, every
 * price and every D, which assertInvariants checks at D = 1.
 *
 * The corollary worth stating, because it looks like a missing safeguard:
 * per-pair damping and repeat decay are ZERO here (see WEIGHT_BASIS). Under a
 * pot they would be defences; per creator they are not needed, and in the money
 * weight they would actively pay a farm for splitting — 120 views concentrated
 * on one pair credit 594 against 1200 spread one-per-puppet, a 2.02x gift.
 * Damping lives in feed ranking, where it shapes attention and moves no money.
 */
export function creatorRebate(burnWeiCausedByCreator) {
  const burned = needWei(burnWeiCausedByCreator);
  return (EMISSION_CAP_BPS * burned) / BPS;
}

/**
 * Apply the epoch's rail to a whole round of per-creator rebates.
 *
 * The rail is `emission(epoch, totalBurned, median)` — the schedule ceiling and
 * the burn-spike ceiling. When the rebates already fit under it, every creator
 * is paid in full and nobody's number depends on anybody else's. When they do
 * not, every rebate is scaled by the SAME fraction.
 *
 * Uniform scaling is what keeps this from quietly becoming a pot. A pot lets a
 * larger share take a larger fraction of someone else's contribution; scaling
 * only ever reduces, and reduces everyone identically, so no attacker's
 * recovery RATIO improves by growing. The bound proved in `creatorRebate` is an
 * upper bound, and the rail can only push actual recovery further below it.
 *
 * `rebates` is a Map of address -> wei. Returns a new Map; the input is not
 * mutated. Dust from the division is left unminted rather than assigned to a
 * largest-holder, because a rounding rule that mints is a rounding rule that
 * can be farmed.
 */
export function applyEpochRail(rebates, epoch, totalBurnedPtpWei, medianBurnedPtpWei = 0n) {
  let asked = 0n;
  for (const wei of rebates.values()) asked += needWei(wei);

  const allowed = emission(epoch, totalBurnedPtpWei, medianBurnedPtpWei);
  const out = new Map();
  if (asked === 0n) return out;
  if (asked <= allowed) {
    for (const [addr, wei] of rebates) out.set(addr, wei);
    return out;
  }
  for (const [addr, wei] of rebates) out.set(addr, (wei * allowed) / asked);
  return out;
}

// ── the invariants ───────────────────────────────────────────────────────────

/**
 * Every claim this edition makes that can be checked by arithmetic, checked.
 *
 * It runs at module load. A bad edit does not ship, does not start a server, and
 * does not silently price a network — it throws before anything imports a number
 * from it. That is deliberate: this file is exactly the kind of file somebody
 * edits in a hurry to see what happens.
 */
export function assertInvariants(p = PARAMS) {
  const fail = (why) => {
    throw new Error(`PARAMS_INVALID: ${why}`);
  };

  // The four splits are the whole of the fee and nothing may fall out of them.
  const sum = p.splitCreatorBps + p.splitBurnBps + p.splitCapacityBps + p.splitTreasuryBps;
  if (sum !== BPS) fail(`the four splits sum to ${sum}, not 10000`);

  const psum = p.publishSplitBurnBps + p.publishSplitCapacityBps + p.publishSplitTreasuryBps;
  if (psum !== BPS) fail(`the publish splits sum to ${psum}, not 10000`);

  // The publish split must be the fee split with the creator leg removed and the
  // rest renormalised, or a poster is quietly paying themselves through a
  // different door.
  const base = p.splitBurnBps + p.splitCapacityBps + p.splitTreasuryBps;
  for (const [name, want, got] of [
    ['burn', (p.splitBurnBps * BPS) / base, p.publishSplitBurnBps],
    ['capacity', (p.splitCapacityBps * BPS) / base, p.publishSplitCapacityBps],
    ['treasury', (p.splitTreasuryBps * BPS) / base, p.publishSplitTreasuryBps],
  ]) {
    if (want !== got) fail(`publish ${name} leg is ${got} bps, renormalisation gives ${want}`);
  }

  // The sybil inequality at D = 1, in the form the brief states it: what a
  // self-dealing loop recovers from its own spending must be less than what it
  // spent. Integers throughout, no division, so there is nothing to round.
  const recovery = p.splitCreatorBps * BPS + p.emissionCapBps * p.splitBurnBps;
  if (recovery >= BPS * BPS) {
    fail(`sybil recovery at D=1 is ${recovery} of ${BPS * BPS}; the loop pays for itself`);
  }

  // The same inequality against an attacker that also runs the storage nodes
  // holding its own posts, and so recovers the capacity leg too. Strictly
  // tighter than the line above, and it is the number both reviews measured:
  // 68,200,000 of 100,000,000, a 31.80% loss floor.
  const integrated = (p.splitCreatorBps + p.splitCapacityBps) * BPS + p.emissionCapBps * p.splitBurnBps;
  if (integrated >= BPS * BPS) {
    fail(`integrated sybil recovery is ${integrated} of ${BPS * BPS}; capacity capture pays for the loop`);
  }

  // And it must lose by a margin rather than by a rounding. The two lines above
  // are sign tests; a set recovering 99.99% passes both and is not shippable.
  const lossBps = (BPS * BPS - integrated) / BPS;
  if (lossBps < SYBIL_LOSS_FLOOR_BPS) {
    fail(`the integrated sybil loop loses only ${lossBps} bps, under the ${SYBIL_LOSS_FLOOR_BPS} floor`);
  }

  // Deflation. At exactly 10000 net supply change is zero and the economy stops
  // being deflationary; above it, it inflates. This bound is NOT implied by the
  // sybil inequality above, which at these splits holds all the way to 15,833 —
  // the two are separate claims and are checked separately.
  if (!(p.emissionCapBps < BPS)) {
    fail(`emissionCapBps is ${p.emissionCapBps}; at or above 10000 supply stops falling`);
  }
  if (p.emissionCapBps <= 0n) fail('emissionCapBps must be positive');

  // The hard cap, recomputed from the schedule rather than trusted. The sum of
  // 365 epochs a year decaying by num/den is 365 x emission x den/(den-num).
  const seriesPtp =
    (EMISSION_DECAY_EPOCHS * p.epochEmissionPtp * p.emissionDecayDen) /
    (p.emissionDecayDen - p.emissionDecayNum);
  if (seriesPtp + p.genesisSupplyPtp !== p.maxSupplyPtp) {
    fail(`the schedule sums to ${seriesPtp} + ${p.genesisSupplyPtp} genesis, not ${p.maxSupplyPtp}`);
  }
  if (!(p.emissionDecayNum < p.emissionDecayDen)) fail('the emission decay does not decay');

  // Every price is a positive integer. A price of zero is a free act and a free
  // act is a sybil faucet; a price held as anything but a bigint is a price that
  // will disagree with itself between two readers.
  const prices = {
    viewPriceMinNanoEur: p.viewPriceMinNanoEur,
    viewPriceDefaultNanoEur: p.viewPriceDefaultNanoEur,
    viewPriceMaxNanoEur: p.viewPriceMaxNanoEur,
    likeMultiplierBps: p.likeMultiplierBps,
    commentMultiplierBps: p.commentMultiplierBps,
    publishBaseFeeNanoEur: p.publishBaseFeeNanoEur,
    storageRentNanoEurPerMbDay: p.storageRentNanoEurPerMbDay,
    minSettlementNanoEur: p.minSettlementNanoEur,
    newAccountBondNanoEur: p.newAccountBondNanoEur,
    capCoinPerMbDay: p.capCoinPerMbDay,
    capacityHoldingCapNanoEurPerMbDay: p.capacityHoldingCapNanoEurPerMbDay,
    capPledgeBondNanoEurPerGb: p.capPledgeBondNanoEurPerGb,
  };
  for (const [name, value] of Object.entries(prices)) {
    if (typeof value !== 'bigint') fail(`${name} is not a bigint`);
    if (value <= 0n) fail(`${name} is ${value}; every price must be positive`);
  }

  // The band has to be a band.
  if (!(p.viewPriceMinNanoEur <= p.viewPriceDefaultNanoEur)) fail('viewPriceMin exceeds the default');
  if (!(p.viewPriceDefaultNanoEur <= p.viewPriceMaxNanoEur)) fail('the default exceeds viewPriceMax');

  // The three weight exponents. Every one of them is zero and every one of them
  // has to stay zero: a positive quality exponent is bought by a large enough
  // farm, and a positive decay in the weight pays for splitting one identity
  // into many. They belong in feed ranking, where they move no money.
  for (const name of ['viewRepeatDecayAlpha', 'pairDiminishingBeta', 'qualityExponent']) {
    if (p[name] !== 0n) fail(`${name} is ${p[name]}; only zero is farm-neutral and split-neutral`);
  }
  if (p.weightBasis !== 'burnWei') {
    fail(`weightBasis is ${p.weightBasis}; only burn-linear weight makes the sybil bound exact`);
  }

  // The two arithmetic fixes, both of which are the difference between a fee
  // existing and not existing. They are settings rather than code here so that
  // they can be sealed into the epoch block and checked from outside.
  if (p.satScaleExp < 8n) fail(`satScaleExp is ${p.satScaleExp}; below 8 the view price truncates to zero`);
  if (p.feePriceSource !== 'epochSealedTwap') {
    fail(`feePriceSource is ${p.feePriceSource}; a live spot lets an attacker set its own weight per euro`);
  }

  // The rails may only ever lower emission, and unemitted PTP is forfeited.
  if (p.emissionRollForward !== false) fail('emissionRollForward rebuilds a pot the burn did not fund');
  if (p.emissionBurnSpikeCapBps <= BPS) {
    fail(`emissionBurnSpikeCapBps is ${p.emissionBurnSpikeCapBps}; at or below 10000 it would cap a normal epoch`);
  }

  // Settlement must always be able to complete, or a post can be pinned forever.
  if (p.minSettlementGates !== 'payout') {
    fail('the settlement floor must gate the payout, never the settle act');
  }
  if (p.creatorCreditUnit !== 'wei') {
    fail('a euro-denominated credit converted at settlement is a free timing option for the creator');
  }

  // Capacity: per-post escrow, and a holding line that cannot draw more than the
  // rent that funded it.
  if (p.capacityPayout !== 'perPostEscrow') {
    fail('a global pro-rata capacity pot pays 361% to a griefer who stores pictures nobody views');
  }
  if (p.capacityHoldingCapNanoEurPerMbDay > p.storageRentNanoEurPerMbDay) {
    fail('the holding payout cap exceeds the rent charged; the escrow would be short');
  }
  if (p.replication < 2n) fail('replication below 2 is not replication');

  // The pool.
  if (p.swapFeeBps <= 0n || p.swapFeeBps >= BPS) fail(`swapFeeBps is ${p.swapFeeBps}`);
  if (p.protocolLiquidityBps > BPS) fail('protocolLiquidityBps exceeds the treasury');

  return true;
}

assertInvariants();
