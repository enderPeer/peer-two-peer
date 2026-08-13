# Peer two Peer

A picture network where every impression is priced in euros, every action burns
PTP, and the pictures live on the members' own devices.

Post a photograph. It is anchored on chain and lives one day. People who look at
it pay you — every impression, not every person — at a price you set. Each day
it stays up costs you storage rent. When you stop paying, you are paid out, the
picture is deleted from every node that held it, and only its metadata stays on
chain.

> **Status: built and running locally.** 347 tests green, a complete journey
> verified end to end over HTTP, no contract deployed, no mainnet. PTP is not a
> payment instrument, not a share, not an investment.

This is the third iteration. [`peernet`](../peernet) contributed non-custodial
Merkle distribution and the versioned-formula endpoint;
[`ToRuleThemAll`](../ToRuleThemAll) contributed the four ideas the whole design
now rests on — one rulebook read by every reader, proof of burn as the only way
in, weight linear in what was destroyed, and an epoch chain that makes rewriting
detectable and publication attributable.

---

## 1. Run it

```bash
npm install
npm start
```

Then open <http://localhost:8787>. Mobile-first, black and white; the desktop is
the same app in the same shape — a centred column of phone width, not a reflowed
layout.

```bash
npm test                   # 347 tests: economics, replay, chain, client, hostile input
node agents/run.mjs --gate  # every part's checks, with a per-part table
node server/chain/build.mjs && node server/chain/verify.mjs
```

---

## 2. The five rules

| # | Rule | Where it is enforced |
|---|---|---|
| 1 | **The act log is the only truth.** Every balance, feed, earning and reserve is a pure function of it. | [`core/replay.mjs`](core/replay.mjs) |
| 2 | **One rulebook, three readers.** Server, browser and chain builder run the *same file*. A host may not accept what replay would skip. | [`test/one-rulebook.test.mjs`](test/one-rulebook.test.mjs) |
| 3 | **Burn is the only way in, and it is real.** Reserve comes from bitcoin destroyed at a keyless output, verified against two independent explorers that must agree. | [`server/burnwatch.mjs`](server/burnwatch.mjs) |
| 4 | **Weight is linear in what was destroyed.** A stake split across twenty puppets weighs exactly what one account holding it weighs. | [`test/sybil.test.mjs`](test/sybil.test.mjs) |
| 5 | **Money never buys reach.** No balance, burn total or fee volume enters any ranking. | [`test/wall.test.mjs`](test/wall.test.mjs) |

Rule 1 has a corollary that shapes everything: **replay never consults a clock, a
network, or randomness.** Post expiry, epoch close and view cooldowns all happen
because an *act landed* carrying a timestamp — never because time passed while
somebody was reading.

---

## 3. Two assets, and why there are two

| | PTP **token** | PTP **coin** (CAP) |
|---|---|---|
| what it is | the money | a storage receipt |
| unit | wei (18 decimals) | one MB·day (6 decimals) |
| transferable | yes, in the one pool, against BTC | never |
| created by | a per-creator rebate on burn | proven capacity served |
| destroyed by | the burn share of every action | consumption: publishing and maintaining a post |

```
  viewer pays a €-priced fee in PTP
        ├──► creator      40%   accrues to the post, paid at settlement
        ├──► burn         36%   destroyed forever
        ├──► capacity      3%   the post's own storage escrow
        └──► treasury     21%   graph compute + protocol-owned liquidity

  poster buys CAP with PTP  ──►  that PTP is destroyed
                            ──►  CAP is burned as the post consumes MB·days
  capacity providers prove served bytes  ──►  paid in PTP  ──►  sold for BTC
```

Nobody is paid in a currency they cannot leave. That is the entire reason there
is a pool.

---

## 4. Prices are euros; settlement is PTP

The unit of account is the integer **nanoeuro** (1 € = 10⁹ n€), so a micro-cent
is 10 n€ and has two orders of magnitude to spare.

| | price | note |
|---|---|---|
| view | **0.0001 €** | 1 € = 10,000 views. Poster may set 0.00002 – 0.0004 € |
| like | 10× the view price | one per pair, so always fully credited |
| comment | 20× the view price | |
| publish | 0.002 € + rent | |
| storage rent | 0.000002 € per MB·day | ×3 replication |

Conversion is **one fused rational**, never two hops:

```
ptpWei = nanoEur × 10⁸ × poolPtpWei / (eurPerBtcNano × poolSat)
```

The obvious rope — n€ → satoshi → PTP wei — returns **`0n` wei for every price in
this economy, at every token price**, because a 0.0001 € view is 0.111 satoshi
and the first hop truncates to zero. The failure is on the bitcoin side, so no
amount of token appreciation fixes it. One rational, one truncation, at the end.
Both legs are frozen at the epoch seal: a live pool spot would hand an attacker a
10× advantage on a 90% self-created dip.

### Views bill many times per person — that is the product

A view is billable only when ≥60% of the picture holds the viewport for ≥1500 ms,
outside a 900-second per-pair cooldown, up to 12 times per pair per epoch. A fast
scroll bills **literally nothing**. The viewer pays full price every time.

---

## 5. Why self-dealing loses money

Emission is a **per-creator rebate on burn actually caused**, not a pot:

```
mint_i = min( scheduleRail,  emissionCapBps/10000 × burnWei_i )
```

Under a pot distributed by weight, a self-dealer's recovery is
`creatorBps + κ·burnBps·r`, where `r` is their weight-per-euro advantage —
break-even at `r = 2.381`, and the parameter set hands out `r` up to 20 three
separate ways. Equivalently the bound degrades to `creatorBps + κ·burnBps/ρ`,
breaching 1.0 once an attacker is a sixth of credited volume. Both say the same
thing: **under a pot, an attacker extracts other people's burn.**

Per creator, `r` and `ρ` vanish from the algebra. Recovery is bounded by

```
creatorBps × D + emissionCapBps × burnBps / 10000  <  10000
4000        × 1 + 7000          × 3600   / 10000  =   6520   (+300 if they also host)
```

**A 31.80% loss floor at every DAU, every price, every D** — measured at 6819 bps
against a 200-wallet like farm. `assertInvariants()` checks this inequality at
module load, so a bad edit to the economy throws before anything can start a
server. Consequences worth stating:

- **Deflation is structural.** `net = emitted − burned ≤ (κ−1)·burned ≤ 0` at
  every DAU including zero. There is no break-even DAU; it does not exist.
- **Bootstrap is safe.** Zero activity burns nothing, so it mints nothing. The
  predecessor design handed one account 180 €/day for a 0.0001 € spend.
- **Like-farming is the binding attack**, not view-farming: cooldown and pair
  damping credit only 8.39% of a view farm's spend, but a like is one-per-pair
  and fully credited.
- **Per-pair damping and repeat decay are zero in the money weight.** They live
  in feed ranking, where they shape attention and move no money. In distribution
  weight they only ever reward splitting — 120 views concentrated on one pair
  credit 594 against 1200 spread one-per-puppet, a 2.02× gift to a farm.

Full derivation, supply curve and every worked number: [docs/ECONOMICS.md](docs/ECONOMICS.md).

---

## 6. The post lifecycle

```
 publish ──► live (1 day) ──► extend ──► live (n days) ──► lapse ──► settle
                                                                       │
                        earnings paid to the creator ◄─────────────────┤
                        picture deleted from every node ◄──────────────┤
                        metadata sealed into the epoch block ◄─────────┘
```

A post accrues `creditWei` — a **PTP quantity fixed when the act landed** — not a
euro liability converted at settlement. All five independent stress reports found
that timing option; fixing the quantity at act time removes it, and settlement
then needs no oracle at all.

Settlement leaves a tombstone: author, cid, byte length, dimensions, lifetime,
views, unique viewers, likes, comments, gross euros, PTP paid, and the block that
sealed it. The picture is gone. Every earnings number still reproduces, because
deletion moves no balance.

---

## 7. The chain, and what it does not claim

One signed, hash-linked block per closed epoch. Each act is committed **twice** —
a structural hash over the act minus its payload (invariant under every lawful
deletion) and a payload hash sealed at close and kept afterwards as the retained
commitment residue.

A block claims exactly: *"at this close, the producer named here observed this
ordered act range, computed this state from it under these constants and these
formula editions, and signs that publication."* It does not decide what is true —
replay decides, hashes only carry.

Act roots commit to the **order**, not the multiset. Pair-sorting is what makes a
Solidity proof four lines, but it left the root unchanged when two acts were
swapped — while replay is order-dependent all the way down. Positions are folded
into the leaf.

The block seals the sha256 of all five consensus-critical modules — replay,
rules, merkle, canonical, params. That list started at two, and was widened the
way these things usually are: `core/merkle.mjs` changed, every sealed block
stopped verifying, and the chain could say `ACTS_ROOT_MISMATCH` but not *why*.
Detectable is not attributable.

---

## 8. Decentralisation, honestly stated

| | state |
|---|---|
| the app | anyone can host it: Pages, any static server, any IPFS gateway |
| the record | act log + chain + media, packed into a deterministic CAR with a reproducible CID |
| the numbers | replay + the chain's signed roots — checkable with every machine of ours off |
| the pictures | shards on members' devices, 3-way, rendezvous-placed with no coordinator |
| **writes** | **one writer at a time — but the writer is an elected, rotating office** |

Four rules hold the election up, each a bug closed rather than a principle
stated: silence is not a mandate; an incumbent yields only to a *strictly* longer
record; never follow someone who follows you; and claims are checked, not
believed. See [docs/DECENTRALIZATION.md](docs/DECENTRALIZATION.md) and
[docs/MIRRORS.md](docs/MIRRORS.md).

---

## 9. Layout

```
core/      the one rulebook — pure, isomorphic, dependency-free
           replay · pricing · amm · params · merkle · canonical · placement · errors · rules/v1
server/    node:http, no framework — log, media, burnwatch, oracle, capacity, chain/
app/       the mobile-first client — index.html, app.mjs, storage.mjs, wallet.mjs, sw.js
contracts/ PtpToken · PtpPool · PtpAnchor · PtpRules
agents/    the build fleet: one manifest per part, with the checks that hold it
ops/       IPFS pack, deploy, and the self-owned name
docs/      ARCHITECTURE · ECONOMICS · DESIGN · DECENTRALIZATION · AGENTS · MIRRORS
```

The only runtime dependency is `ethers`. No framework, no CSS library, no build
step, no web fonts, no CDN — so the app runs offline and ships nothing to
anybody else's server.

---

## 10. What this does not stop

Written with numbers rather than adjectives, because a network with an unstated
failure mode is a way to lose other people's money.

- **Reach can be bought; money cannot.** Keeping the app usable (5 € ≥ 2,000
  actions) caps the view price, so manufacturing 1,000 impressions costs about
  0.04 € against a 2–10 € advertising CPM. Economic sybil resistance against
  reach-buying is arithmetically unattainable at any price that keeps the product
  usable. Self-dealing always loses money — that protects the *money*. Reach is
  protected structurally by Rule 5, which is why emission weight and ranking
  weight are separated.
- **Spam is unprofitable, not impossible.** 50 pictures a day costs 0.10 €. The
  spammer loses about 2.48 €/month at the default price and 0.88 €/month at the
  ceiling. Keeping spam out of feeds is ranking's job, not the economy's.
- **The pool is thin.** 900 € a side at genesis. A 5 € top-up costs 0.85% in fee
  and slippage; 90 € moves the price 21%. Protocol-owned liquidity accrues from
  the treasury share, but there is a window between roughly 1,500 and 3,000 DAU
  where the price is genuinely fragile.
- **Mechanical appreciation is not closed.** Positive net destruction against a
  fixed-depth pool appreciates PTP whether or not anyone wants it to.
- **Dedicated storage does not scale as a business.** The capacity share is a
  fixed 3% of fee revenue, so it does not grow with pledged hardware. Browsers on
  already-powered devices are the intended configuration; a rack is not.
- **The rule key can reopen the printer.** It may ship a rules module for a
  future epoch that reintroduces a non-burn-linear weight without touching a
  single number in `core/params.mjs`. `assertInvariants` pins the weight basis;
  it cannot pin a module that does not exist yet.
- **Writes still pass through one host at a time.** An elected, rotating office
  with deterministic fork healing — but never concurrent.
- **A partition elects one writer per side** until it heals. That is the price of
  staying available, and CAP is not negotiable.

---

## 11. What this is not

No exchange, no bridge, no custody, no redemption, no promise. The host holds no
wallet and no spendable key; the burn address has no key by construction, so
nobody can spend what was destroyed — including the operator, including the
network. The only thing any of it buys is a place in this network.

This is a construction intent, not legal advice.
