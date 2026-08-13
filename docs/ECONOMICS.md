# PTP — the economy

Two assets, one pool, and a per-impression price surface denominated in euros.
This document states every constant in `core/params.mjs`, where its value came
from, and what it does under attack. It is written for somebody deciding whether
to burn bitcoin to get in.

Lineage: the emission schedule is the predecessor's — 0.9 a year, decaying over
365 epochs — and the one rule below is the same wall, carried across intact. What
is new is that emission is no longer a schedule. It is a function of destruction.

## The one rule everything else protects

**Weight is linear in PTP destroyed.** Not in accounts, not in balances, not in
impressions, not in unique viewers. A stake split across twenty puppets weighs
exactly what one account holding it weighs, and there is a test that splits one
twenty ways and gets the same number back.

Three parameters in this economy exist only because that rule is enforced
literally: `viewRepeatDecayAlpha`, `pairDiminishingBeta` and `qualityExponent`
are all **zero**. Each of them was proposed as a way to make engagement "fairer",
and each of them, measured, paid an attacker for splitting one identity into
many. They survive in feed ranking, where the same intuitions are correct and
where they move no money.

---

## What broke, and what replaced it

The previous calibration emitted a flat 2,000 PTP an epoch, unconditionally,
while every cost in the network is priced in euros. Nothing connected the two, so
the value of emission floated free of the fee economy. Three things followed, all
measured:

| | measured under the flat rule |
|---|---|
| sybil | at 0 DAU one account captured the whole 180 EUR/day emission for a 0.0001 EUR spend, and the break-even DAU rose **linearly with the token price** — a rising price made the attack better |
| supply | inflationary below 10,302 DAU |
| pool | at 1,000 DAU, 41.60 EUR/day of fee inflow against 180.00 EUR/day of emitted sell pressure into a pool holding 900 EUR a side |

Emission is now a pure function of PTP the epoch actually destroyed:

```
  emission(epoch) = min( scheduledCap(epoch),  emissionCapBps/10000 x burnedPtp(epoch) )

  scheduledCap(epoch) = 2000 PTP x (9/10)^floor(epoch/365)
```

It reads no oracle, no pool and no price. Every property below is a ratio of
basis points and is therefore invariant in the token price and in the DAU.
Unemitted PTP is **forfeited**, never carried forward — a pot that outlives the
epoch that funded it is the flat rule wearing a different name.

---

## The constants

Every value is an integer. Euro amounts are nanoeuros, 1 EUR = 1e9 n€.

### The price surface

| constant | value | in euros | where it came from |
|---|---|---|---|
| `viewPriceDefaultNanoEur` | 100000 | 0.0001 | anchored to an observation, not chosen: the calibrated honest day (150 views, 16 likes, 5 comments) costs 0.0410 EUR and produces 41.50 EUR/day at 1,000 DAU, reproducing the 41.60 EUR/day the failed round measured |
| `viewPriceMinNanoEur` | 20000 | 0.00002 | the poster's floor. Bounded because a 20x band was the lever in the sharpest attack found: had weight counted impressions, buying at the floor against honest users at the ceiling would have taken 20x the weight per euro and recovered 5.346x the spend |
| `viewPriceMaxNanoEur` | 400000 | 0.0004 | the poster's ceiling. Kept because the attack it enabled is closed by burn-linear weight, not by narrowing the band |
| `likeMultiplierBps` | 100000 | 10x the view | a like is a signal, a comment is a durable object, a view is a glance. 20:10:1 is what stops comment spam being cheaper than looking |
| `commentMultiplierBps` | 200000 | 20x the view | as above; a comment is still 0.002 EUR at the default price |
| `publishBaseFeeNanoEur` | 2000000 | 0.002 | the only anti-spam gate. Sets break-even at 31 views a post at the default price |
| `storageRentNanoEurPerMbDay` | 2000 | 0.000002 | **not raised**, though raising it would have made a failed gate's headline go away. The headline was wrong twice — see *What a contribution earns* |
| `minSettlementNanoEur` | 100000 | 0.0001 | one default view. Gates the payout and never the settle act |
| `newAccountBondNanoEur` | 500000000 | 0.50 | prices puppets: a 200-wallet farm posts 100 EUR before it acts |

### The four-way split

| constant | value | what it funds |
|---|---|---|
| `splitCreatorBps` | 4000 | the person whose picture was looked at, on the spot |
| `splitBurnBps` | 3600 | PTP destroyed forever |
| `splitCapacityBps` | 300 | the members holding and serving the picture |
| `splitTreasuryBps` | 2100 | graph compute, and protocol-owned liquidity |

They sum to 10000 exactly. The publish fee has **no creator leg** — a poster may
not pay themselves — so those three are renormalised over a base of 6000 to
6000/500/3500 for that one act. Rent is not split at all; it goes whole to that
post's own capacity escrow.

### Emission and supply

| constant | value | where it came from |
|---|---|---|
| `epochEmissionPtp` | 2000 | now a **ceiling**, not a quantity. Expected to be decorative and is not: the coupled term reaches it at a burn of 2,857 PTP an epoch, which is 714 EUR/day of fee flow — about 17,200 DAU at the genesis price |
| `emissionDecay` | 9/10 per 365 epochs | the predecessor's shape. Exact closed form; slow enough that the launch rail does not outlive the launch |
| `emissionCapBps` | 7000 | three facts pin it, below |
| `emissionBurnSpikeCapBps` | 15000 | a burn spike lifts emission by at most 1.5x the 7-epoch median. Inactive when there is no history |
| `emissionRollForward` | false | forfeited, not banked |
| `maxSupplyPtp` | 7310000 | 365 x 2000 x 1/(1-9/10) = 7,300,000, plus 10,000 genesis |
| `genesisSupplyPtp` | 10000 | all of it in the pool. Nobody is allocated anything |

### Weight, and the pool

| constant | value | where it came from |
|---|---|---|
| `weightBasis` | `burnWei` | the whole anti-sybil argument. See *The sybil inequality* |
| `viewRepeatDecayAlpha` | 0 | overrides ARCHITECTURE §4 on measured grounds |
| `pairDiminishingBeta` | 0 | overrides ARCHITECTURE §8's second fixed shape, same grounds |
| `qualityExponent` | 0 | the unique farm-neutral and split-neutral value |
| `maxViewsPerPairPerEpoch` | 12 | the rate limiter that stands after the two decays are removed |
| `viewCooldownSec` | 900 | twelve views at fifteen minutes is three hours, so the count binds and the cooldown stops a burst |
| `viewMinViewportPct` / `viewDwellMs` | 60 / 1500 | ARCHITECTURE §4 names both and no lens pinned either. Product numbers: they change how many views qualify, never what one costs |
| `swapFeeBps` | 30 | Uniswap-V2's number; `core/amm.mjs` restates it and the two must agree |
| `protocolLiquidityBps` | 8000 | the only parameter that addresses depth directly |

### Arithmetic, oracle and settlement

| constant | value | where it came from |
|---|---|---|
| `satScaleExp` | 8 | without it every priced item in this table converts to **zero wei** |
| `feePriceSource` | `epochSealedTwap` | a live pool spot lets an attacker set its own weight per euro |
| `poolTwapEpochs` | 1 | a whole epoch. A close-of-epoch snapshot is sandwichable in one block |
| `oracleMinSources` / `oracleQuorum` | 5 / 3 | strictly tighter than §3's "at least three" |
| `oracleMaxMoveBps` | 1000 | ±10% an epoch; a sustained 2x distortion needs eight epochs of public lying |
| `creatorCreditUnit` | `wei` | a euro credit converted at settlement is a free timing option for the creator |
| `minSettlementGates` | `payout` | gating the settle act lets an attacker pin storage forever |
| `capacityPayout` | `perPostEscrow` | a global pro-rata pot pays a griefer 361% |
| `replication` | 3 | ARCHITECTURE §7 |
| `serveOnMeteredConnection` | false | serving on a 5 EUR/GB plan costs 3,255x the revenue |

### The rest of the edition

Named here so that this document states every constant the epoch block seals.

| constant | value | where it came from |
|---|---|---|
| `epochSeconds` | 86400 | an epoch is a day. Four numbers here are quoted per epoch and read as per day; stating it makes those readings agree |
| `postDefaultLifetimeSec` | 86400 | a post lives a day and is extended by paying rent |
| `settlementGraceSec` | 3600 | settlement is an act, not a timer. An hour is enough for the author, the auto-extend, or a passer-by to send it |
| `publishSplitBurnBps` | 6000 | the fee split with the creator leg removed and the rest renormalised over a base of 6000 |
| `publishSplitCapacityBps` | 500 | as above |
| `publishSplitTreasuryBps` | 3500 | as above |
| `emissionDecayNum` / `emissionDecayDen` | 9 / 10 | held as a rational so the decay is computed in integers, never in a float |
| `emissionDecayEpochs` | 365 | one year of epochs |
| `emissionBurnSpikeMedianEpochs` | 7 | the window the spike rail measures against |
| `genesisSat` | 1000000 | 0.01 BTC, ARCHITECTURE §2 |
| `genesisPtpWei` | 10000e18 | the other side of the same deposit; genesis spot is 1 PTP = 100 sat |
| `capCoinPerMbDay` | 1000000 | one CAP is one MB-day, at CAP's six decimals |
| `capacityHoldingCapNanoEurPerMbDay` | 2000 | equals the rent charged. You cannot draw more rent than was paid |
| `capacitySurplusTo` | `burn` | where fewer nodes prove than replication asks for, the surplus is destroyed rather than shared, so under-replication costs money instead of paying a bonus for it |
| `capPledgeBondNanoEurPerGb` | 200000000 | 0.20 EUR/GB. Twenty invented node-ids against a refundable bond cost 10 EUR and took a sixth of a pro-rata pot |
| `capPledgeBondSlashable` | true | a refundable bond prices nothing |
| `capProofLatencyBoundMs` | 2000 | concurrent random-range challenges bounded at two seconds. Three disks answer, one disk pretending to be three does not |
| `oracleSealPerSourceValues` | true | sealing each source's value, not only the median, makes a lie attributable to a named source rather than merely visible in aggregate |
| `settlementDustSweepTo` | `burn` | credit below the payout floor is destroyed and the post settles, redacts and tombstones anyway |

---

## Deflation is structural

Net supply change in an epoch is

```
  net  =  emitted - burned  <=  (emissionCapBps/10000 - 1) x burned  =  -0.30 x burned  <=  0
```

The two terms are the same quantity of the same asset measured in the same epoch,
so `burned` cancels and the ratio is **-30% at every level of activity**. There is
no break-even DAU. There is not a break-even DAU that moves with the price, which
is what the flat rule had — its break-even was 8,891 DAU at 0.045 EUR/PTP, 17,782
at 0.09, and 177,824 at 0.90.

One correction to how this is usually stated. The strict form, `net < 0 at every
DAU including zero`, is **false at literally zero activity**: nothing burned means
nothing emitted, so net is exactly 0, not negative. The true claim is `net <= 0`,
strict whenever any action occurs. Supply is constant in a dead epoch and falling
in a live one; it is never inflationary.

That gives the supply law, which is stronger than the hard cap and is the honest
headline:

```
  supply  =  10,000  -  0.30 x cumulative burn
```

Total supply is **monotonically non-increasing from 10,000 PTP**. It starts at ten
thousand and only ever falls.

### The hard cap survives anyway

The schedule sums in closed form to

```
  365 epochs/year x 2000 PTP x 1/(1 - 9/10)  =  365 x 2000 x 10  =  7,300,000 PTP
  + 10,000 genesis                            =  7,310,000  =  maxSupplyPtp
```

`min()` is monotone downward, so coupling can only lower it. Summed epoch by
epoch in integer wei until the schedule truncates to zero — which happens in year
466 — the discrete total is **83,585 wei short** of the closed form. The ceiling is
an upper bound, approached and never touched, and under coupling it is
unreachable by construction rather than merely unreached.

### Above the rail, emission shrinks

Where the schedule binds, emission falls as a share of fee value, and everything
downstream of it falls too:

| DAU | fee flow | burn | emission | emission / fee | attacker recovery |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 42 EUR/d | 166 PTP | 116 PTP | 25.20% | 68.20% |
| 17,000 | 706 EUR/d | 2,822 PTP | 1,975 PTP | 25.20% | 68.20% |
| 20,000 | 830 EUR/d | 3,320 PTP | 2,000 PTP | 21.69% | 64.69% |
| 50,000 | 2,075 EUR/d | 8,300 PTP | 2,000 PTP | 8.67% | 51.67% |
| 200,000 | 8,300 EUR/d | 33,200 PTP | 2,000 PTP | 2.17% | 45.17% |

This is why the rule must stay `min()` and never `max()`. The rail only ever makes
an attacker poorer.

---

## The sybil inequality

An attacker who spends F on its own pictures gets back, at most:

```
  creatorBps x D x F/10000   +   (emissionCapBps/10000) x (burnBps x F/10000)
```

where D <= 1 is the combined credit factor. With weight linear in PTP burned, an
attacker that is 100% of an epoch's burn captures 100% of that epoch's emission —
so this is the whole of what comes back, and D = 1 is the attacker's best case.
Worked at D = 1:

```
  4000  +  7000 x 3600 / 10000   =   4000 + 2520   =   6520 bps        loss 34.80%
```

An attacker that also runs the storage nodes holding its own posts recovers the
capacity leg too:

```
  4000 + 300 + 2520             =   6820 bps        loss 31.80%
```

`assertInvariants()` checks both, in integers with no division, and also checks
that the loss clears a 3,000 bps floor — because the bare inequality is a **sign
test**, and a set recovering 99.99% passes it.

Measured against the closed form: a 200-wallet farm doing 500 self-views a day,
cross-viewing at D = 1 and running its own storage nodes, spends 11.2089 EUR a day
and recovers 7.3356 — a loss of 3.8733 EUR a day, and 2,900.71 EUR over two years
including the bond. Recovery stays between 65.00% and 65.77% across every DAU from
0 to 100,000, and it does not move with the price. Under the flat rule the same
attacker's return ranged from 0.40x to 43,374x across the same grid.

### The identity underneath

```
  creatorTake  =  creatorBps + emissionCapBps x burnBps / 10000  =  sybilRecovery
```

exactly, once weight is burn-linear. **You cannot pay creators more than you are
willing to let a self-dealing loop recover**, because to the arithmetic they are
the same transaction. There is one free number in this economy, not three, and it
is 6520 bps.

### What the bound assumes, and what would break it

The bound treats D as the only free variable. That is true only if every euro
buys the same weight. If it does not, the real condition is

```
  creatorBps + emissionCapBps x burnBps x r / 10000  <  10000        break-even r = 2.381
```

where r is the attacker's weight-per-euro advantage. Three mechanisms in the
proposed set handed out more than 2.381:

| mechanism | r | recovery |
|---|---:|---:|
| impressions counted across the 20x price band | up to 20 | 5.346x |
| `viewRepeatDecayAlpha` 1.0, splitting views one per puppet | 3.867 | 1.3745x |
| alpha x beta together | 5.561 | 1.8015x |
| fees converted at the live pool spot, 90% self-created dip | 10 | 2.92x |
| **weight linear in PTP burned, one price sealed per epoch** | **1.000** | **0.652x** |

All of them close with one rule and one seal. That is why `weightBasis`,
`feePriceSource` and the three zeroed exponents are invariants in
`core/params.mjs` and not conventions.

### Why the three exponents are zero

**`qualityExponent`.** Under the reading where unique viewers multiply weight by
U^q, the farm chooses the sock ratio and therefore chooses the multiplier. With
1,000 socks any q above 0.118 pays; with a million, any q above 0.059. The
critical q falls as the farm grows, so there is no safe positive value — only
values safe against farms smaller than the one that shows up. Under the reading
where the exponent applies to aggregate weight, splitting one creator n ways gains
n^(1-q), so every q below 1 pays for splitting. Zero is the unique value neutral
under both.

**`pairDiminishingBeta`.** At the proposed 0.25, an attacker spreading 1,200 views
one per puppet instead of twelve per puppet took 2.02x the weight, cutting the
loss from 31.80% to 6.09% — four fifths of the margin. At 0.5 the loop is outright
profitable at 112.35%. A damping term meant to punish concentration rewards
dispersal by construction, and dispersal is what a farm is made of.

**`viewRepeatDecayAlpha`.** ARCHITECTURE §4 sets it to 1.0 and gives a sound
reason: ten views from one admirer should lose to one view from ten people. In the
distribution weight it does the opposite of what it is for. Twelve views on one
pair credit H(12) = 3.1032 where twelve views on twelve pairs credit 12, so
spreading buys 3.867x the weight per euro. Routing the withheld creator remainder
into the burn — the best available repair, and it does work — pulls that back to a
**1.15x** advantage at these splits: still loss-making at worst, still 15% off
Rule 4's "exactly". It buys nothing, because the self-view loop already loses
34.80% at zero, and it taxes the one thing the product wants: a genuine repeat
viewer pays full price every time, and at 1.0 their twelfth view credits the
creator 0.0833 of their first. The hard cap is the correct rate limiter — below
it every accepted view is worth what it cost, at it the act is refused, so the
ratio among accepted acts stays exactly 1.

---

## The pool

One constant-product market, 1,000,000 sat against 10,000 PTP, **900 EUR on each
side** at a 90,000 EUR/BTC reference. This is thin and it is the binding
constraint on the whole design.

### It cannot be structurally drained

Every euro of fee requires a euro of PTP, and users buy that PTP from the pool
with bitcoin. What can come back out is bounded:

| leg | bps of fee inflow |
|---|---:|
| creators, direct | 4000 |
| creators, via emission | 2520 |
| capacity providers | 300 |
| treasury, operating | 420 |
| **total sell pressure** | **7240** |
| **bitcoin retained, permanently** | **2760** |

Protocol-owned liquidity nets to zero on the bitcoin side: the treasury sells half
its allocation into the pool for satoshis and deposits both halves back, so the
satoshi side is unchanged and the PTP side gains the whole allocation. Bitcoin
therefore only ever accumulates. Over 730 days at a pessimistic sell fraction of
1.0, net bitcoin into the pool measured +2,287.96 EUR at 0 DAU, +7,088.03 at
1,000, and +467,552.98 at 100,000. Zero failed swaps, zero dust events, minimum
satoshi reserve always the genesis 1,000,000. Dumping the entire 7.3 million
lifetime cap into it extracts 898.76 EUR of the 900 and cannot empty it.

### What it does lose is PTP

The burn consumes PTP that was bought out of the pool, while emission mints PTP
outside it. Per fee euro the PTP reserve falls by

```
  (1 - emissionCapBps/10000) x burnBps  =  0.30 x 3600  =  1080 bps
```

At 1,000 DAU that is 4.48 EUR a day out of a 900 EUR side — 0.498% a day —
against 6.97 EUR a day of protocol-owned liquidity going in. The pool thickens on
the bitcoin side, thins on the PTP side, and the price ratchets up. It is never
insolvent. It is not always a market. See *What this does not stop*.

---

## What five euros buys

At the default price, with the calibrated mix:

| | actions for 5 EUR |
|---|---:|
| realistic mix, default price | 20,853 |
| after the 0.50 EUR account bond | 18,768 |
| all views, minimum price | 249,999 |
| all views, default price | 50,000 |
| all comments, default price | 2,500 |
| **all comments, maximum price** | **625** |

The last row is the one corner that fails a literal reading of "5 EUR buys at
least 2,000 actions": a user who engages only with pictures priced at 0.0004 and
only ever comments. Closing it would force `viewPriceMax` down to 125,000 n€ and
take the pricing band away from posters, so it is documented rather than
parameterised away. The running session total in the header (ARCHITECTURE §11)
prices it before it is spent, which is the actual protection.

A viewer's ordinary day — 150 views, 16 likes, 5 comments — costs **0.0410 EUR**,
which is 1.23 EUR a month. Because fees are euro-denominated, a 100x move in the
token price leaves that bill identical.

---

## What a creator earns

Creator take is 65.20% of everything paid on their pictures: 40.00% directly and
25.20% through emission. Cost to publish a 2 MB picture and hold it for a day is
0.002012 EUR — 0.002 of publish fee and 0.000012 of rent at replication 3.

| archetype | views/post | revenue/post | net/post | per month |
|---|---:|---:|---:|---:|
| hobbyist, 1 post / 2 days | 300 | 0.053464 | +0.051452 | **+0.77 EUR** |
| regular, 1 post / day | 800 | 0.142571 | +0.140559 | **+4.22 EUR** |
| pro, 3 posts / day | 2,000 | 0.356427 | +0.354415 | **+31.90 EUR** |
| pro, 3 / day at the price ceiling | 2,000 | 1.425707 | +1.423695 | **+128.13 EUR** |
| spammer, 50 posts / day | 2 | 0.000356 | −0.001656 | **−2.48 EUR** |
| spammer at the price floor | 20 | 0.000713 | −0.001299 | **−1.95 EUR** |
| spammer at the price ceiling | 2 | 0.001426 | −0.000586 | **−0.88 EUR** |

Break-even, counted on views alone and ignoring likes and comments entirely: **155
views a post at the price floor, 31 at the default, 8 at the ceiling.** The
spammer loses at every price it is allowed to set, which is the property that
matters — a gate that only holds at one price is not a gate.

---

## What a capacity contribution earns

The failed gate reported a 5 GB contribution earning 0.3072 EUR a month against
1.08 EUR a month of electricity for a 5 W always-on device. That number is
reproducible and it is wrong twice: it priced **pledged** capacity, when payment
is for bytes **served**, and it priced them at the **nominal rent**, when the rent
is 0.24% of what a provider is paid. The tariff was not raised.

**This is an egress economy wearing a storage economy's units.** Three percent of a
0.0001 EUR view of a 2 MB picture is 1.5e-6 EUR per megabyte served, and the
network egresses about **200 MB for every MB-day it stores**. Measured on the
calibrated mix at 1,000 DAU:

| | |
|---|---:|
| capacity pot | 37.44 EUR/month (37.35 serving, 0.09 rent) |
| live replicated corpus | 1,500 MB |
| effective rate | 0.000832 EUR per MB-day = **416x the nominal rent** |
| stated as storage | 25.56 EUR per GB-month |
| stated as egress | 0.001536 EUR per GB served |

A contribution is paid out of the **escrow of each post it holds**, never out of a
global pot. Each post carries two escrows: *holding*, funded by that post's own
rent, released to the nodes proven to hold its shards and capped at the rent
actually charged; and *serving*, funded by the capacity share of that post's own
engagement, released to the nodes that delivered the bytes and named by the
viewer's own view act. A node that never served is never named.

### At what scale it beats its own power draw

| | |
|---|---:|
| 5 W always-on node, at 0.30 EUR/kWh | 1.08 EUR/month |
| covered by serving, continuously | **43 MB** |
| serving margin over WiFi energy alone | 3.60x |
| whole pot at 1,000 DAU | 37.44 EUR/month |
| dedicated 5 W nodes that pot can justify | **about 35** |

The honest limit is scale, not rate. The pot is a fixed fraction of fee revenue,
so it does not grow because more people plug in hardware — a dedicated node beats
its electricity only while it holds more than 2.88% of the network's served bytes.
At 1,000 DAU that means roughly thirty-five such nodes and no more. At 100,000 DAU
the pot is about 2,200 EUR a month and the arithmetic scales with it.

That is not the configuration this design intends. The client is a browser on a
device that is already powered, where the marginal cost of holding and serving
bytes is close to zero and any placement is profit. **The one thing a member must
not do is serve over a metered connection**: at 5 EUR/GB, serving costs 3,255x
what it earns, so the client refuses it by default.

---

## Where the two reviews disagreed, and how it was settled

Two independent verifications ran the coupled rule. Both passed every gate, both
confirmed the coupling works for the stated reason, and both arrived at a creator
take of **6520 bps to the basis point**:

```
  4000 + 6000 x 4200 / 10000  =  6520          4000 + 7000 x 3600 / 10000  =  6520
```

The product `emissionCapBps x burnBps` is 25,200,000 in both. So every sybil
result, every creator earnings figure, and the fee flow at which the schedule
rail starts to bind — 714 EUR a day, about 17,200 DAU — are **identical**. The two
sets are not rival economies. They differ in one thing: whether 600 bps of every
fee euro is destroyed or retained as depth.

| per fee euro | 4200 burn / 1500 treasury / cap 6000 | **3600 burn / 2100 treasury / cap 7000** |
|---|---:|---:|
| creator take | 6520 bps | 6520 bps |
| integrated sybil loss | 31.80% | 31.80% |
| net PTP destroyed | 1680 bps | **1080 bps** |
| protocol-owned liquidity | 900 bps | **1680 bps** |
| PTP taken from the pool, 1,000 DAU | 6.97 EUR/day (0.775%/day) | **4.48 EUR/day (0.498%/day)** |
| depth added, 1,000 DAU | 3.74 EUR/day | **6.97 EUR/day** |
| days to double the pool | 241 | **129** |
| recovery if `emissionCapBps` were mis-set to 9999 | 84.996% | **78.996%** |

The second is taken, and the reason is the constraint the design names as binding:
the pool holds 900 EUR a side. Nothing is given up for it — the creator take, the
sybil margin and the rail all stay exactly where they were — and the pool is
drained 1.56x more slowly and deepened 1.87x faster. It also leaves six more
points of margin against a bad edit.

Three further findings, each of which one review found and the other did not, are
all in the final set because a break either of them could not close had to be
closed: the sealed-epoch price (`feePriceSource`), the payout-only settlement
floor (`minSettlementGates`), and the combination of per-post capacity escrow
with a slashable pledge bond and latency-bounded proofs.

### The arithmetic bug both reviews found

At 90,000 EUR/BTC one satoshi is 900,000 nanoeuros. The two-hop rope in
ARCHITECTURE §3 — nanoeuro to integer satoshi to wei — truncates as follows:

| item | n€ | satoshis | two-hop | fused |
|---|---:|---:|---:|---:|
| view price, floor | 20,000 | 0.0222 | **0 wei** | 222,222,222,222,222 |
| view price, default | 100,000 | 0.1111 | **0 wei** | 1,111,111,111,111,111 |
| view price, ceiling | 400,000 | 0.4444 | **0 wei** | 4,444,444,444,444,444 |
| storage rent, per MB-day | 2,000 | 0.0022 | **0 wei** | 22,222,222,222,222 |
| settlement floor | 100,000 | 0.1111 | **0 wei** | 1,111,111,111,111,111 |
| like | 1,000,000 | 1.1111 | 10% under | 11,111,111,111,111,111 |
| comment, publish | 2,000,000 | 2.2222 | 10% under | 22,222,222,222,222,222 |

Section 3's underflow rule then substitutes 1 wei, which at the genesis price is
9.0e-20 EUR — a discount of 1.1e15, which is precisely the sybil faucet the rule
exists to prevent. **Every fee in this document, as originally specified, does not
exist.** The failure is on the bitcoin side and has nothing to do with the PTP
price, so a higher view price does not fix it and neither does a deeper pool.

`core/pricing.mjs` must evaluate the conversion as one fused rational —
`nanoEur x 1e8 x poolPtpWei / (eurPerBtcNano x poolSat)` — with the intermediate
satoshi never materialised. Swept across every priced item at 1x, 10x, 100x,
1000x and 1,000,000x the genesis price, the smallest value that form produces
anywhere is 22,222,222 wei. The two-hop form returns zero in twenty cells out of
twenty, at every price. Both hops stay public, at the sub-satoshi scale where the
view price floor is 2,222,222 units with no error at all; what is forbidden is
settling money through it.

---

## What this does not stop

Real numbers, and no adjectives.

**The token appreciates mechanically, and that is a windfall to whoever holds at
genesis.** Any positive net destruction against a pool of fixed depth pushes the
price up whether or not anyone wants it to. At 1,000 DAU the measured first-year
appreciation is roughly an order of magnitude, and the pool's PTP reserve falls
from 10,000 to around 5,100 in the process. No value of `emissionCapBps` removes
this; the only levers are the destruction rate and the depth, and this edition
moves both in the gentler direction — 1080 bps a fee euro instead of 1680, and
1680 bps into depth instead of 900. It reduces the effect. It does not remove it,
and it sits badly against ARCHITECTURE §13.

**The genesis pool is too thin for a fast launch.** One day of 1,000-DAU fee demand
is 4.61% of the 900 EUR PTP side, and reaches 10% at 2,169 DAU. At 100,000 DAU the
worst single-day price move measured is 227.7%, and the price is 84x genesis by day
30. The pool is never drained — constant product cannot be emptied — but for the
first weeks at high DAU it is a ratchet rather than a market. At 0.02x the genesis
price, one day of 1,000-DAU demand exceeds the entire PTP reserve and simply
cannot execute. This is a depth problem and nothing in the emission rule touches
it. Seeding beyond 0.01 BTC, or throttling early growth, is the fix, and neither
is a parameter in this file.

**Spam is unprofitable, not impossible.** Fifty pictures a day costs 0.10 EUR a
day. A spammer loses 2.48 EUR a month at the default price and 0.88 EUR a month at
the ceiling, and somebody willing to pay that can post them. What keeps them out
of a feed is ranking, not price.

**Five euros does not always buy 2,000 actions.** A user who only ever comments,
and only on pictures priced at the ceiling, gets 625. The band stays.

**A genuine viral day is under-paid.** The burn-spike rail lets emission rise only
1.5x above the 7-epoch median, so an honest day at three times normal activity
emits half what the coupling alone would give. The difference is forfeited, not
deferred. The epoch is simply more deflationary than intended, which is the
conservative direction to fail in but is still a real cost to the creators who
happened to be there that day.

**A real bitcoin move of more than 10% in a day is mispriced until the oracle
catches up.** The ±10%-per-epoch clamp takes three epochs to absorb a 30% move,
and fees are wrong for that long. It is the cheaper side of the trade against an
unclamped rate a manipulator can steer, and it is public while it happens.

**Emission is no longer a growth subsidy.** At 10 DAU, emission is 0.105 EUR an
epoch across every creator in the network. That is the direct cost of removing the
faucet, and it is not recoverable elsewhere: growth has to be funded from the
treasury's operating line, which is 420 bps of fee value — about 1.74 EUR a day at
1,000 DAU. If that proves too thin, the number to move is `protocolLiquidityBps`.
The splits cannot be moved, because they carry the sybil identity.

**The honest-user subsidy is closed by one rule, and only by that rule.** Emission
is funded by everyone's burn and split by weight, so the entire defence rests on
weight-per-euro parity. It holds at r = 1 with burn-linear weight and a sealed
epoch price, and it has 138% of drift tolerance before the printer reopens at
r = 2.381. Any future `core/rules/vN.mjs` that reintroduces a weight term which is
not linear in PTP burned reopens it, and the rule key can ship such a module for a
future epoch without touching a single number in `core/params.mjs`. That is the
one hole this parameter file cannot close by itself, and `test/sybil.test.mjs` is
what has to.

**A dedicated storage fleet is not a business.** At 1,000 DAU the whole capacity
pot is 37.44 EUR a month, which justifies about thirty-five always-on 5 W nodes
and no more. The design intends browsers on devices that are already powered,
where the marginal cost is near zero. It does not intend a rack.

---

## What this is not

No exchange, no bridge, no custody, no redemption, no promise. The host holds no
wallet and no spendable key; the burn address has no key by construction, so
nobody can spend what was destroyed — including the operator, including the
network. PTP is not an investment, and the only thing any of it buys is a place in
this network. That the arithmetic above makes it appreciate is a property of the
mechanism, stated here so that nobody has to discover it, and it is not an offer.
This is a construction intent, not legal advice.
