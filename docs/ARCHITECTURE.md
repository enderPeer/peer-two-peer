# Peer two Peer — Architecture

The binding interface document. Every module below is implemented exactly as
specified here; the specification is the contract between the parts, and no
part may widen it unilaterally.

Lineage: this is the third iteration. `peernet` contributed non-custodial
Merkle distribution and the versioned-formula endpoint. `ToRuleThemAll`
contributed the four load-bearing ideas repeated here: **one rulebook read by
every reader**, **proof of burn as the only way in**, **weight linear in
satoshis destroyed**, and **the epoch chain that makes rewriting detectable
and publication attributable**. What is new in this iteration: pictures,
per-impression billing, a euro-denominated price surface over a single
constant-product pool, a second asset for device storage, a post that expires
and settles, and a fleet of build agents.

---

## 0. The five rules

| # | Rule | Where it is enforced |
|---|---|---|
| 1 | **The act log is the only truth.** Every number — balances, feeds, earnings, pool reserves — is a pure function of it. | `core/replay.mjs`, imported verbatim by server, client and chain |
| 2 | **One rulebook, three readers.** The server, the browser and the chain builder run the *same file*. A server may not accept what replay would skip. | `core/replay.mjs` is never forked; `test/one-rulebook.test.mjs` asserts byte identity of the imported module |
| 3 | **Burn is the only way in, and the burn is real.** Reserve comes from bitcoin destroyed at a keyless output and from nowhere else. | `server/burnwatch.mjs`, two independent explorers must agree |
| 4 | **Weight is linear in satoshis destroyed.** A stake split across twenty puppets weighs exactly what one account holding it weighs. | `core/rules/*.mjs`, `test/sybil.test.mjs` |
| 5 | **Money never buys reach.** No balance enters any feed score, any rank, any distribution weight beyond the burn that produced it. | `test/wall.test.mjs` |

Rule 1 has a corollary that shapes the whole codebase: **replay may never
consult a clock, a network, or a random source.** Anything time-dependent —
post expiry, epoch close, view cooldowns — happens because an *act landed*
carrying a timestamp, never because time passed while someone was reading.

---

## 1. Two assets, and why there are two

| | PTP **token** | PTP **coin** (CAP) |
|---|---|---|
| what it is | the money | a storage receipt |
| decimals | 18 | 6 |
| unit | wei | one CAP = one MB·day of stored, replicated bytes |
| transferable | yes | no — protocol-minted, protocol-burned |
| created by | epoch emission to creators; genesis liquidity | proven capacity served |
| destroyed by | the burn share of every action | consumption: publishing and maintaining a post |
| tradable | yes, in the one pool, against BTC | never |

The loop the two assets close:

```
  viewer pays a €-priced fee in PTP
        │
        ├──► creator share      ──► accrues to the post, paid at settlement
        ├──► burn share         ──► PTP destroyed forever            (deflation)
        ├──► capacity share     ──► the capacity pot
        └──► treasury share     ──► graph compute + protocol-owned liquidity

  poster buys CAP with PTP  ──► PTP joins the capacity pot
                            ──► CAP is burned as the post consumes MB·days

  capacity providers (members' devices) prove served bytes
        └──► paid out of the capacity pot in PTP
             └──► sold in the one pool for BTC  ──► real money for real work
```

Nobody is paid in a currency they cannot leave. That is the entire point of
having a pool at all.

---

## 2. The one pool

A single constant-product market, Uniswap-V2 arithmetic, integer-exact.

- Reserves: **BTC** (satoshis, integer) and **PTP** (wei, integer).
- Genesis liquidity: **0.01 BTC = 1 000 000 sat** against **10 000 PTP**.
  Genesis spot: 1 PTP = 100 sat = 1e-6 BTC.
- Swap: `out = rOut · (10000−fee)·Δin / (rIn·10000 + (10000−fee)·Δin)`,
  computed in BigInt, truncating. `k` grows on every swap; that growth is the
  liquidity providers' pay.
- Initial shares `√(a·b)`, with `MINIMUM_LIQUIDITY = 1000` shares **locked
  forever** so the pool can never be drained to zero.
- Adding liquidity takes the *proportional* part of an offer, so a skewed
  deposit cannot mint shares against existing providers.
- Every swap carries `minOut`; a fill at a price the screen never showed is
  refused, not executed.

### `core/amm.mjs`

```js
export const FEE_BPS;                                   // from params
export function amountOut(amountIn, reserveIn, reserveOut, feeBps): bigint
export function amountIn(amountOut, reserveIn, reserveOut, feeBps): bigint
export function spotSatPerPtp(pool): bigint              // scaled 1e18
export function quote(pool, side, amount, feeBps): { out, priceImpactBps, newPool }
export function addLiquidity(pool, satIn, ptpIn): { shares, used, newPool }
export function removeLiquidity(pool, shares): { sat, ptp, newPool }
```

All arguments and returns are `bigint`. No floats cross this boundary.

---

## 3. Prices are euros; settlement is PTP

Every user-visible price is a euro price. The unit of account is the
**nanoeuro** — integer, `1 €  =  1 000 000 000 n€`. One micro-cent is
`10 n€`, so micro-cent pricing is representable with two orders of magnitude
to spare.

Conversion reads two public rates — the EUR/BTC oracle and the pool — but it is
**one fused rational, never two hops**:

```
                nanoEur × 10⁸ × poolPtpWei
   ptpWei  =  ───────────────────────────────
                eurPerBtcNano × poolSat
```

**Why fused, measured rather than argued.** The obvious two-hop rope —
n€ → satoshi → PTP wei — returns **`0n` wei for every price in this economy, at
every token price**. A 0.0001 € view is 0.111 satoshi, so the first hop truncates
to zero and the second multiplies zero. The failure is on the *bitcoin* side and
is completely independent of what PTP is worth, so no amount of token
appreciation or decimal headroom fixes it. It also under-charged likes and
comments by 10% wherever it did not zero them outright. One rational, one
truncation, at the end.

**The rate is a sealed epoch TWAP, not the live spot.** Both legs — the oracle
rate and the pool ratio — are fixed at the epoch seal and used unchanged for the
whole epoch. A live pool spot would hand an attacker `r = 10` on a 90%
self-created dip: they move a 900 € pool, price their own actions against the
moved rate, and let it recover. The oracle is the median of at least five
independent sources with a three-source quorum, clamped to ±10% movement per
epoch, with every source's value sealed into the block. The clamp mis-prices a
genuine 30% BTC move for three epochs; that is the cheaper side of the trade
against a rate a manipulator can steer, and the error is public while it happens.

### `core/pricing.mjs`

```js
export function nanoEurToPtpWei(nanoEur, rate): bigint   // the fused rational; never two hops
export function ptpWeiToNanoEur(wei, rate): bigint
export function splitFee(ptpWei, vector): { creator, burn, capacity, treasury }
export function sealRate(pool, oracle): Rate             // what an epoch freezes
export function formatEur(nanoEur): string               // "0.000 02 €", never rounds to 0
```

`Rate` is `{ eurPerBtcNano, poolSat, poolPtpWei, epoch }` — the frozen pair, so a
price is reproducible from the block alone with no access to a live pool.

**The underflow rule.** `nanoEurToPtpWei` must never return `0n` for a non-zero
price. If truncation would reach zero it returns `1n` wei and the caller records
a `dust` flag. A price that silently becomes free is a free view, and a free view
is a sybil faucet. `test/pricing.test.mjs` sweeps every priced item at 1×, 10×,
100×, 1000× and 10⁶× the genesis price and asserts no zero.

### The oracle

`GET /api/v1/oracle` publishes `{ eurPerBtcNano, at, sources[], sig }`. It is
the median of at least three independent public sources, signed by the epoch
producer key, refreshed each epoch, and **sealed into the epoch block**. A
host that showed a different rate for a closed epoch contradicts its own
signature. Between epochs the last sealed rate is used — prices do not move
under a user mid-session.

---

## 4. Acts

One append-only JSONL file, `data/acts.jsonl`. One act per line, canonical
JSON, no trailing whitespace. Every act is **signed by the account's wallet
key** (EIP-191 `personal_sign` over the canonical act body minus `sig`) —
there are no PINs, no passwords, and no server-held secrets.

```jsonc
{ "i": 1042, "t": 1786445193465, "as": "0x7a…", "k": "view", "…": "…", "sig": "0x…" }
```

`i` is assigned by the writer on acceptance; `t` is the writer's stamp; `as`
is the acting address; `k` is the kind.

| kind | fields | what it does |
|---|---|---|
| `register` | `handle` | binds a handle to the address, once |
| `burnClaim` | `txid`, `vout`, `sat` | records bitcoin destroyed at the keyless output; grants reserve |
| `swap` | `sell` (`"btc"`\|`"ptp"`), `amt`, `minOut` | trades in the one pool |
| `liqAdd` / `liqRemove` | `sat`,`ptp` / `shares` | liquidity provision |
| `post` | `cid`, `bytes`, `mime`, `w`, `h`, `viewPriceNano`, `days` | publishes a picture; anchors it; pays publish fee + first day's rent |
| `view` | `pid`, `dwellMs`, `seq` | one **billable impression** |
| `like` | `pid` | |
| `comment` | `pid`, `text` | |
| `extend` | `pid`, `days` | pays maintenance rent for further days |
| `settle` | `pid` | expiry: computes earnings, pays the creator, redacts the payload, tombstones to chain |
| `capBuy` | `ptp` | pays PTP into the capacity pot, receives CAP |
| `capPledge` | `mb`, `endpoint` | a device announces storage it is serving |
| `capProof` | `challenge`, `answer` | answers a random byte-range challenge |
| `capClaim` | — | mints CAP for proven MB·days; claims PTP from the capacity pot |
| `rulesSet` | `version`, `hash`, `fromEpoch` | **rule key only** — swaps the distribution module for a future epoch |
| `closeEpoch` | — | seals the epoch |

### Billable views — the definition that stops a scroll from costing €4

A `view` act is only accepted, and only billed, when **all** hold:

1. the post occupied ≥ 60 % of the viewport,
2. for ≥ `viewDwellMs` continuous milliseconds,
3. and at least `viewCooldownSec` have passed since the last billable view of
   the same (viewer, post) pair,
4. and the pair is below `maxViewsPerPairPerEpoch`.

The viewer pays the poster's full `viewPriceNano` on every billable view —
views are counted and charged many times per person, by design. What decays
is the **creator's reward**, not the viewer's bill: the *n*-th view by the
same viewer credits the creator `1/(1 + α·(n−1))`. Ten views from one admirer
lose to one view from ten people, while the admirer still pays ten times.
That asymmetry is what makes the self-view loop lose money.

### Refusals

`core/errors.mjs` is a catalogue: every refusal has a stable `code`, the
mechanism that produced it, and the next step. `GET /api/v1/errors` publishes
all of them. A refused act answers with all four fields so a bot never parses
a sentence to learn what happened.

---

## 5. `core/replay.mjs` — the one rulebook

```js
export const EDITION;                       // sha256 of this file, self-reported
export function emptyWorld(params): World
export function applyAct(world, act): { ok: true } | { ok: false, code, msg, next }
export function replay(acts, params): World
export function actError(world, act): null | { code, msg, next }   // the validator both readers use
```

`applyAct` is total: an act that does not validate is **skipped whole**, never
half-applied. Balances never move, no number ever becomes `NaN`, and the
world after a rejected act is `===`-identical in content to the world before.
There is a test that fires negative amounts, infinities, overdrafts and
self-paired swaps straight at it.

The server validates with `actError` run over its live world before appending.
The browser validates with the *same function* before offering a button. The
refusal sentence is identical in both places because it comes from the same
line of code.

### `World`

```js
{
  accounts: { [addr]: { handle, sat, ptp, cap, joined, acts } },
  posts:    { [pid]: { author, cid, bytes, mime, w, h, viewPriceNano,
                       created, expires, state,            // "live" | "settled"
                       views, uniqueViewers, likes, comments,
                       grossNano, creditWei, paidWei, tombstone } },
  comments: { [cid]: { pid, author, text, at } },
  pool:     { sat, ptp, shares, locked },
  supply:   { emitted, burned },
  capacity: { potPtp, providers: { [addr]: { mbDays, proven, paidPtp } } },
  rules:    { version, hash, setBy, fromEpoch },
  epoch:    { n, closedAt, oracle },
  seq:      { post, comment }
}
```

---

## 6. The post lifecycle

```
 publish ──► live (1 day) ──► extend ──► live (n days) ──► lapse ──► settle
                                                                       │
                        earnings paid to creator  ◄───────────────────┤
                        image deleted from every node ◄───────────────┤
                        metadata sealed into the epoch block ◄────────┘
```

- **Publish** costs `publishBaseFeeNano` + one day of `storageRentNanoPerMbDay`
  × the picture's megabytes × the replication factor. Both are paid in PTP at
  the sealed rate, and the poster must hold enough CAP to cover the MB·days —
  CAP they bought with PTP, which is how the capacity pot gets funded.
- **Live** is where views, likes and comments accrue. Every action credits the
  post's `creditWei` and moves PTP the same instant.

  **A post accrues a PTP quantity, never a euro liability.** The euro price is
  converted to PTP once, at the moment the act lands, against the epoch's sealed
  rate — and that quantity is what settlement pays. Accruing `creditNano` and
  converting at settlement instead would hand the creator an option on the pool:
  every one of the five independent stress reports found that timing game, and
  fixing the quantity at act time is what removes it. It also means a settlement
  needs no oracle at all.
- **Extend** buys further days. The client offers auto-extend funded from the
  post's own earnings, so a post that earns can keep itself alive.
- **Lapse** happens when the paid-for day ends. After `settlementGraceSec`
  anybody may send `settle` — it is an act, not a timer, so replay stays pure.
- **Settle** pays `creditNano` to the creator in PTP, redacts the image, and
  writes the tombstone.

### The tombstone — what survives deletion

Redaction takes the **payload** and leaves the **structure**. Each act is
committed twice in the epoch block:

- a **structural hash** over the act minus `cid`/`text` — invariant under
  every lawful deletion;
- a **payload hash** sealed at close and simply *kept* afterwards: the
  retained commitment residue. It proves a picture existed and exactly which
  bytes it was, without the bytes.

So a settled post leaves on chain: author, `cid`, byte length, dimensions,
lifetime, total views, unique viewers, likes, comments, gross euros, PTP paid,
and the block that sealed it. The picture itself is gone from every node.
Every earnings number for the epoch still reproduces, because deletion moves
no balance — the same scoring-neutral-removal property the predecessor paid
for twice.

---

## 7. Capacity — the device data-space

The client asks for persistent storage (`navigator.storage.persist()`) and
keeps shards of other members' pictures in the **Origin Private File System**,
falling back to IndexedDB. A member who grants 5 GB is a storage node.

- **Placement.** A picture's `cid` (sha256 of the bytes) is split into shards;
  shards are placed on the `REPLICATION` nodes whose node-id is closest to
  `sha256(cid ‖ shardIndex)` — rendezvous hashing, so placement is a pure
  function of the set of live nodes and needs no coordinator.
- **Proof.** The writer issues a challenge: *"return sha256 of bytes
  [o, o+4096) of shard s"*, with `o` derived from the epoch seed. Only a node
  actually holding the bytes can answer. Answers land as `capProof` acts.
- **Payment.** `capClaim` mints CAP for proven MB·days and draws the
  provider's pro-rata slice of the capacity pot in PTP.
- **Consumption.** Publishing and maintaining a post burns CAP. Supply and
  demand for storage therefore clear in CAP, while the money settles in PTP.

`app/storage.mjs` and `server/capacity.mjs` share `core/placement.mjs` — one
rulebook again, so a browser node and a server node agree on who should hold
what.

---

## 8. Distribution, and the key that can change it

At every `closeEpoch`, PTP is minted to creators. **Emission is a per-creator
rebate on burn actually caused, not a pot distributed by weight.**

```js
// core/rules/v1.mjs — the swappable part
export const VERSION = "v1";
export function credit(world, epochActs) : { [addr]: bigint }  // credited fee wei per creator
```

```
mint_i = min( scheduledCap_i(epoch),  emissionCapBps/10000 × burnBps/10000 × creditedFee_i )
```

`creditedFee_i` is the fee PTP that creator *i*'s own content caused during the
epoch. The rule reads no oracle and no pool price — it is a pure function of
PTP quantities the epoch actually destroyed.

**Why per-creator, and not a pot.** This is the single most load-bearing
decision in the economy, and it was reached by measurement. Under a shared pot
distributed by relative weight, a self-dealer's recovery is
`creatorBps + emissionCapBps·burnBps/10000·r`, where *r* is their weight-per-euro
advantage over honest creators. Break-even is `r = 2.381`, and the parameter set
hands out *r* up to 20 three separate ways — the 20× view-price range, the
repeat-decay rule, and any conversion at live pool spot. Equivalently: the bound
degrades to `creatorBps + κ·burnBps/ρ` where ρ is the honest share of credited
fees, breaching 1.0 once an attacker is a sixth of the volume. Both forms say the
same thing — **under a pot, an attacker extracts other people's burn.**

Per-creator, *r* and ρ do not appear. Nobody competes for anybody else's rebate,
so recovery is bounded by `creatorBps·D + emissionCapBps·burnBps/10000 < 10000`
at every DAU, every price and every value of *D*. Self-dealing loses money
arithmetically rather than statistically.

Three shapes are fixed across all versions, because they are what make the
distribution honest rather than farmable:

1. **Self-engagement never counts.** On a post the payer *is* the credited
   creator, so the creator share is redirected to burn: the split becomes
   `0 / 8200 / 300 / 1500`. Both vectors sum to 10000.
2. **Weight is linear in what was destroyed** — never in account count, never
   in balance, never in a quantity an attacker sets. Twenty puppets sharing a
   stake weigh what one account holding it weighs, exactly.
3. **No exponent on unique viewers.** `qualityExponent = 0` is a deliberate,
   load-bearing zero. Any positive exponent is defeated by enough puppets: the
   critical value falls as the farm grows — 0.118 at a thousand socks, 0.059 at
   a million — so there is no safe positive setting, only one not yet attacked
   at scale.

Per-pair damping and repeat decay still exist, but they live in **feed ranking**,
where they move no money. In the distribution weight they would only ever
reward splitting: 120 views concentrated on one pair credit 594 against 1200
spread one-per-puppet, a 2.02× gift to the farm. Damping belongs where it
shapes attention, not where it pays.

**The rule key.** A named `ruleKey` address may send `rulesSet(version, hash,
fromEpoch)` with `fromEpoch > world.epoch.n`. It takes effect for *future*
epochs only; a closed epoch is never re-cut.

**Replay is the gate, not the contract.** `PtpRules` compares `fromEpoch`
against the *sealed horizon*, which lags the true epoch by an amount nothing on
chain can measure — so the contract will accept a schedule entry landing inside
that lag, and `rulesFor` would then name a module for an epoch that ran under a
different one. This is not fixable in Solidity: the contract knows one number
and it is the wrong one. What the contract really guarantees is narrower and
worth stating exactly: **an answer is frozen once the sealed horizon passes the
epoch it answers for; above the horizon the schedule is an announcement, not a
commitment.** `core/replay.mjs` holds the real gate, because the world state
knows the true epoch — it refuses a `rulesSet` whose `fromEpoch` is not strictly
greater than `world.epoch.n`, with the code `RULES_EPOCH_PAST`. The key can change how the pot
is divided and nothing else: it cannot mint, cannot move a balance, cannot
touch the pool, cannot alter a sealed block. `GET /api/v1/rules` publishes the
active version, its hash and its full source; `GET /api/v1/rules/:version`
publishes any earlier one, so every past epoch stays recomputable with the
module that actually computed it.

---

## 9. The epoch chain

One signed, hash-linked block per closed epoch.

```
{ v, net, height, epoch, time, prev,
  range: { start, end },
  acts[], actsRoot,             // structural hash per act + merkle root
  payloads[], payloadsRoot,     // payload commitment per act + merkle root
  tombstones[],                 // pictures that settled in this epoch
  package, stateRoot,           // the epoch's full economic state, canonical
  oracle,                       // the EUR/BTC rate this epoch priced with
  constants,                    // params edition: fees, splits, emission curve
  editions,                     // sha256 of core/replay.mjs and core/rules/<active>.mjs
  producer, sig }               // Ed25519
```

A block claims exactly: *"at this close, the producer named here observed this
ordered act range, computed this state from it under these constants and these
formula editions, and signs that publication."* It does not decide what is
true — replay decides, hashes only carry. The chain makes silent rewriting
**detectable** and publication **attributable**.

Numbers are committed under canonical JSON: sorted keys, shortest round-trip
decimals, non-finite values refused, inexact values rounded to the published
quantum (1e-9). Two verifiers either match bits or can attribute the
difference. There is no third outcome.

```bash
node server/chain/build.mjs      # seal every closed epoch (incremental, refuses forks)
node server/chain/verify.mjs     # replay everything; check every root and signature
```

Published at `GET /api/chain` and `GET /api/chain/head`.

---

## 10. Decentralised hosting

Writes pass through **one writer at a time — an elected, rotating office.**
Reads pass through anything.

| | how |
|---|---|
| the app | static files: Pages, any static host, any IPFS gateway |
| the record | act log + chain + media, packed into a deterministic CAR with a reproducible CID |
| the numbers | replay + the chain's signed roots — checkable with every machine of ours off |
| the pictures | shards on members' devices, `REPLICATION`-way, rendezvous-placed |
| the writer | elected by longest sealed chain, then longest log, then liveness |

Four rules hold the election up, each one a bug closed rather than a principle
stated: silence is not a mandate (a host that has heard from no peer does not
write); an incumbent yields only to a *strictly* longer record; never follow
someone who follows you; and claims are checked, not believed — a peer's
advertised numbers only start a handover, the record is fetched and verified
before the pen moves.

**The address book.** `status.json` beside the app is rewritten every fifteen
minutes by a scheduled job on machines we do not own, so it keeps answering
when everything of ours is off. When nothing answers it points the app at the
published archive on purpose: a working read-only network beats a dead
address. The link is never dead.

**The name.** `ops/domain/` holds the self-owned name: a DNSLink `TXT` record
pointing at the current CID, an IPNS key, and the mirror list. The name is
ours, the content address is arithmetic, and either one alone reaches the
network.

---

## 11. The design

Mobile-first, black and white, and the desktop is the same app in the same
shape — a centred column of phone width, not a reflowed layout. One
implementation, one set of breakpoints that only ever change the frame around
the column.

- Two colours: ink `#000`, paper `#FFF`. Grey only for disabled states and
  hairlines. Colour appears nowhere except the pictures themselves, which is
  the point — the interface is the frame, the photograph is the content.
- Type only. No icon fonts, no external assets, no web fonts, no CDN. The app
  is `system-ui` and geometry, so it works offline and ships nothing to
  anybody else's server.
- Smooth means: 60 fps scroll with `content-visibility: auto`, images
  decoded off-thread, no layout shift (every picture reserves its
  `aspect-ratio` from the act before the bytes arrive), and momentum that
  never fights the platform.
- `prefers-reduced-motion` removes every transition.
- Prices are always visible and always in euros. A running session total sits
  in the header, because a network that bills per impression and hides the
  meter is a trap.

---

## 12. Repository layout

```
PeerTwoPeer/
├─ core/           the one rulebook — pure, isomorphic, dependency-free
│  ├─ replay.mjs · amm.mjs · pricing.mjs · params.mjs · placement.mjs
│  ├─ canonical.mjs · merkle.mjs · errors.mjs
│  └─ rules/v1.mjs
├─ server/         node:http, no framework
│  ├─ index.mjs · log.mjs · media.mjs · burnwatch.mjs · capacity.mjs
│  └─ chain/       build.mjs · verify.mjs · election.mjs · keys.mjs
├─ app/            the mobile-first client (static, installable)
│  ├─ index.html · app.mjs · style.css · storage.mjs · sw.js
├─ contracts/      PtpToken.sol · PtpPool.sol · PtpAnchor.sol · PtpRules.sol
├─ agents/         the build fleet — one manifest per part
├─ ops/            domain, mirrors, IPFS pack, deploy
├─ .github/workflows/
├─ test/           node:test
└─ docs/           this file · ECONOMICS.md · DECENTRALIZATION.md · AGENTS.md
```

---

## 13. What this is not

No exchange, no bridge, no custody, no redemption, no promise. The host holds
no wallet and no spendable key; the burn address has no key by construction,
so nobody can spend what was destroyed — including the operator, including the
network. PTP is not an investment and the only thing any of it buys is a place
in this network. This is a construction intent, not legal advice.
