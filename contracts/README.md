# contracts/

Four Solidity files, `^0.8.24`, no imports, no OpenZeppelin, no proxies, no
libraries. Each one compiles standalone: what you deploy is exactly what you
read, with nothing fetched at compile time that a reader would have to go and
audit as well.

These contracts are the **mirror**, not the truth. The truth is `data/acts.jsonl`
replayed through `core/replay.mjs` (ARCHITECTURE.md rule 1). What the chain adds
is the one thing replay cannot produce on its own: a timestamp in a place the
poster cannot reach back into, so that "this commitment was made *then*" is
checkable by a stranger with no relationship to the network.

---

## What each contract can and cannot do

### `PtpToken.sol` — ERC-20 "Peer two Peer" (PTP), 18 decimals

| | |
|---|---|
| **CAN** | mint to any address, **distributor only**, up to `MAX_SUPPLY` |
| | burn your own coins (`burn`) |
| | burn coins you hold an allowance for (`burnFrom`) |
| | the ordinary ERC-20 three: `transfer`, `approve`, `transferFrom` |
| **CANNOT** | be paused, frozen, blacklisted, upgraded, or have its fee changed — none of those exist |
| | mint above `18_250_000e18`, ever, by anybody |
| | be minted by a human, if the distributor is a contract (see wiring) |
| | move, claw back, or freeze a balance that already exists — no owner, no admin |
| | regain mint headroom by burning (the cap is on `totalEmitted`, not `totalSupply`) |

`MAX_SUPPLY = 18 250 000 PTP` is the convergent sum of the emission curve, not a
round number somebody liked: 5 000 PTP per epoch, one epoch per day, decaying
×0.9 per year, so 1 825 000 in year one and

```
total = 1 825 000 × Σ(n≥0) 0.9ⁿ = 1 825 000 / (1 − 0.9) = 18 250 000
```

Three supply figures are published: `totalSupply` (live), `totalEmitted`
(monotone, what the cap binds), `totalBurned` (monotone). The identity
`totalEmitted − totalBurned == totalSupply` holds at every instant, and the pair
`(totalEmitted, totalBurned)` is exactly `supply: { emitted, burned }` in the
replayed `World`.

### `PtpPool.sol` — the one pool, wBTC/PTP

| | |
|---|---|
| **CAN** | swap either direction at `x·y=k` with the fee fixed at construction |
| | accept liquidity at the pool's current ratio and mint shares for it |
| | burn shares for the proportional slice of both reserves |
| **CANNOT** | be paused, drained, repriced, migrated, or skimmed — by anyone, including the deployer |
| | have its fee changed. `feeBps` is `immutable` and capped at 100 bps at construction |
| | be pointed at a different token pair. Both addresses are `immutable` |
| | give back tokens sent directly to the address. There is no rescue function and there will not be one |
| | fall to zero reserves. `MINIMUM_LIQUIDITY = 1000` shares sit at `address(0)` forever |

There is **no admin function of any kind**. Read the function list to confirm it:
`getReserves`, `amountOut`, `addLiquidity`, `removeLiquidity`, `swap`. Every
state-changing one is callable by anybody and does the same thing for everybody.

Units: wBTC has 8 decimals, so one raw wBTC unit is one satoshi and equals the
`sat` integer in the act log. Genesis liquidity from ARCHITECTURE.md §2 is
`1 000 000` wBTC units against `10 000e18` PTP — 0.01 BTC against 10 000 PTP,
spot 1 PTP = 100 sat.

The swap formula is the same expression as `core/amm.mjs`:

```
out = rOut·(10000 − fee)·Δin / (rIn·10000 + (10000 − fee)·Δin)
```

with the division deferred to the end so truncation never eats part of the fee.
`amountOut(amountIn, reserveIn, reserveOut, feeBps)` is `public pure` with the
same argument order as the JS, so the two can be tested against each other
argument for argument.

### `PtpAnchor.sol` — post anchoring, tombstones, epoch roots

| | |
|---|---|
| **anyone CAN** | `publish` a post, becoming its author. The `postId` is **derived, not supplied** |
| | `verifyProof` / `provenInEpoch` — check a merkle proof against a sealed root, `view`/`pure` |
| **the author CAN** | `extend` a live post's expiry, forward only |
| **the producer CAN** | `settle` a lapsed post: write its tombstone, once |
| | `epochRoot` the next closed epoch's three merkle roots, once |
| | `rotateProducer` — hand the office on |
| **NOBODY CAN** | revise a published post, a written tombstone, or a posted root |
| | settle a post before it has lapsed |
| | move a coin. This contract holds no token reference, no coins, and has no `payable` function |
| | shorten a post's expiry, or anchor under an id belonging to another address |
| | seal an epoch out of order, skip one, or start anywhere but `GENESIS_EPOCH` — including on the very first seal |
| | move `highestEpoch` by more than one, so `currentEpoch()` is a tally of sealed epochs and not a number a caller picks |

**`postId` is derived, and that is a fix.** `publish(cid, bytesLen, w, h, expires, nonce)`
returns `postId = keccak256(abi.encode(msg.sender, cid, nonce))`. It used to take
`postId` as an argument and then set `author = msg.sender` with no relationship
between the two — so a watcher could copy a pending publish, land first, and own
that permanent unrevisable record forever, while the real author's transaction
reverted with no repair path. The author is now inside the id's preimage, so a
front-runner replaying the same calldata derives a *different* id under their own
address. `postIdFor(author, cid, nonce)` is `public pure`, and `Published` carries
`nonce`, so the binding is checkable from the log alone.

**Epochs seal in order, one at a time, starting from epoch 0.** `epochRoot`
requires `epoch == currentEpoch()` — one comparison, no "unless", covering the
first seal and every later one. `GENESIS_EPOCH = 0` is a public constant, and it
is not a choice made in the contract: ARCHITECTURE.md §5 numbers a replayed
`World`'s epochs from zero, `PtpRules`' genesis entry governs from epoch 0, and
`currentEpoch()` already answered 0 before anything was sealed. So `highestEpoch`
is now the count of sealed epochs minus one — a tally, not an argument.

Two rounds were needed for that, and the first one is worth writing down. The
original defect was an unbounded `epoch`: one call rooting `type(uint256).max`
made `currentEpoch()` — `highestEpoch + 1` under checked arithmetic — revert
forever, disabling both `PtpRules.setRules` and `PtpRules.activeRules`. The fix
added `epoch < type(uint256).max` and `!anySealed || epoch == highestEpoch + 1`,
which removed the revert and left the harm one step to the side: the FIRST seal
was still free. A genesis seal at `type(uint256).max - 1` made `currentEpoch()`
return exactly the ceiling — no overflow, no revert — and `setRules` requires a
`fromEpoch` *strictly greater* than that. No `uint256` qualifies. One transaction
from the producer key still bricked the rule registry permanently. Pinning the
genesis seal is what closes it, and `PtpRules` carries an independent second
closure so that no clock value can lock `setRules` out at all.

A gap is refused rather than tolerated because the horizon *is* what "sealed"
means to `PtpRules`: skipping ahead would silently declare epochs sealed that
were never rooted, irreversibly. An unbound first seal was the largest such gap
available — 900 epochs claimed in one transaction, before anyone had anything to
compare it against.

`EMPTY_ROOT` is `sha256(0x02 ‖ "ptp/merkle/empty")`, the value `core/merkle.mjs`
returns from `rootOf([])`, mirrored here as a public constant. `emptyRoot()`
recomputes it from the preimage and the constructor compares the two, so the copy
cannot drift from the JavaScript without the deployment reverting.

**The merkle verifier mirrors `core/merkle.mjs`, which is normative.**

```
leaf  = sha256(0x00 ‖ contentDigest)
node  = sha256(0x01 ‖ min(a,b) ‖ max(a,b))     odd element rises unchanged
empty = sha256(0x02 ‖ "ptp/merkle/empty")      the root of a list with no leaves
```

sha256 (the precompile) and not keccak, because the same digest has to be
computable by the chain builder on `node:crypto`, the browser on `SubtleCrypto`
and a verifier with nothing installed. The domain bytes are load-bearing: without
them an interior node verifies as a leaf, and `root([a,b,c]) == root([H(ab),c])`
so the root does not fix the leaf count. If `core/merkle.mjs` changes, this
changes with it.

The third domain is why an epoch with no committable acts can seal at all.
`epochRoot` demands three non-zero roots and refuses gaps, so before `EMPTY_ROOT`
existed a quiet day had no root to post and the `+ 1` rule would have stopped the
chain permanently. `buildTree` still refuses an empty list — the sentinel never
enters proof checking — so nothing is ever a member of an empty epoch:
`verifyProof(leaf, [], EMPTY_ROOT)` would need `sha256(0x00 ‖ leaf)` to equal
`sha256(0x02 ‖ …)`. An empty epoch is therefore distinguishable from one whose
acts were withheld, which a shared or invented root could not have given.

**Structure survives, payload is retained.** At `settle` the contract clears
`cid`, `bytesLen`, `w`, `h` from storage and keeps `author`, `publishedAt`,
`expires`, `state`, `tombstone`. The `Settled` event carries **all** of it,
including the cleared fields, so an indexer building the permanent record needs
no storage read — by the time it could make one, the payload fields are
deliberately zero. That is the ARCHITECTURE.md §6 distinction made physical: the
structural commitment stays live state because later readers need it; the
payload commitment stays provable from the log but stops being state, because a
commitment whose payload has been deleted has no consumer left.

`currentEpoch()` returns `highestEpoch + 1`, or `GENESIS_EPOCH` before anything
is sealed. It is the only clock in these four files that is made of sealed facts
rather than `block.timestamp`, and `PtpRules` reads it. `epochRoot` checks its
argument against the same private expression, so the number this chain will
accept next and the number `PtpRules` reads as current are the same number by
construction rather than by two places agreeing. It cannot revert: the overflow
is ruled out at the write, because a view that reverts is a view every caller has
to handle and `PtpRules`' callers could not.

**It lags, and that limit is load-bearing.** `currentEpoch()` is one past the
highest *anchored* epoch, not the highest *closed* one. If the producer is behind,
this reads 11 while the network is at 50. Everything `PtpRules` can promise is
bounded by that, which limit 7 states exactly.

### `PtpRules.sol` — the rule key

| | |
|---|---|
| **CAN** | `setRules(version, sourceHash, fromEpoch)` with `fromEpoch` strictly greater than **both** `PtpAnchor.currentEpoch()` and the last entry's `fromEpoch` |
| | `rotateRuleKey` — hand the key on |
| **CANNOT** | mint. There is no token address anywhere in the file |
| | move a balance. There is no `transfer`, no `payable`, no `call`, no `delegatecall` |
| | touch the pool. There is no pool address anywhere in the file |
| | alter a sealed root. The only outward reference is `IPtpAnchorClock`, whose single function is `view` |
| | change the answer `rulesFor` gives for any epoch **at or below the anchor's sealed horizon** — see limit 7 for the epochs above it, where it can |
| | schedule at or under an entry already scheduled. `fromEpoch` strictly increases |
| | **remove an entry.** The schedule is append-only; there is no `pop` in the file |
| | be locked out by the anchor. No value `currentEpoch()` can return leaves `setRules` with no acceptable argument |

That list is checkable rather than promised: the whole outward surface of this
contract is one `view` function on one interface, which by the compiler's own
rules cannot write anything anywhere. Every state-changing line writes to either
`schedule` or `ruleKey`. There is no third destination.

**The schedule is append-only and strictly increasing.** Two rules, both fixes,
and each one closes what the other's absence opened.

`setRules` used to `pop` entries whose `fromEpoch` was above
`PtpAnchor.currentEpoch()`. That clock is the *sealed* horizon and it lags the
network, so an entry that had already governed a closed-but-unanchored epoch
could be deleted — after which `rulesFor` named the wrong module for an epoch
that had already been cut. Nothing is deleted now.

Removing the `pop` also removed the requirement that `fromEpoch` increase, and
that cost twice. A push could land *under* an existing entry, which changes the
published answer for the epochs between them — the deletion defect arrived at by
addition. And the loop that announced the shadowed tail then grew with the
schedule, so a key pushing descending epochs (1000, 999, 998, …) paid O(n²) gas
until `setRules` exceeded the block gas limit and could never be called again.
Strict increase closes both: nothing is ever shadowed, so there is nothing to
announce, so **the loop and the `RulesSuperseded` event are gone** and `setRules`
costs one tail read and one push regardless of how long the schedule is.

The schedule is therefore **sorted**: entry *i* governs `[fromEpoch_i,
fromEpoch_{i+1})` and the last entry governs from its own epoch on. `rulesFor` is
still a backwards linear scan — see limit 15.

**What `rulesFor` actually guarantees, stated narrowly.** An answer is frozen
once the sealed horizon passes it: every push names a `fromEpoch` above
`currentEpoch()`, a push at *F* changes the answer only for epochs ≥ *F*, and the
horizon never moves backwards — so any epoch the anchor has sealed keeps its
answer forever. Above the horizon the schedule is an **announcement, not a
commitment**: the clock lags, so an entry can name an epoch that already closed
off-chain, and `rulesFor` will then describe an epoch with a module that did not
compute it. The contract cannot detect this, and no arrangement of Solidity can,
because the contract does not know the true epoch number.

**The real gate is replay.** `core/replay.mjs` refuses a `rulesSet` act whose
`fromEpoch` is not strictly greater than the *true* current epoch — see
`RULES_EPOCH_PAST` in `core/errors.mjs` — and the world state knows that number
because it was built from the log. An on-chain entry that replay never accepted
governs nothing; it is a published claim the log contradicts. ARCHITECTURE.md
rule 1 decides which of the two wins, and it is not the contract. So §8's "every
past epoch stays recomputable with the module that actually computed it" is held
up by the log and by the source served at `GET /api/v1/rules/:version`. What this
contract adds is a timestamped public record of each claim, and the freeze below
the horizon.

`rulesFor(epoch)` answers for every epoch that has ever existed and every one
that has not, because entry 0 governs from epoch 0 and can never be removed.

---

## Deploy order and wiring

Deploy in this order. Steps 1–2 have no prerequisites beyond an address; step 3
is the one that matters for mint rights.

```
1.  PtpAnchor(producer)
        producer = the epoch producer / elected writer address.
        No dependencies. Deploy first, because PtpRules reads its clock.
        The first epochRoot call must name epoch 0 and each one after it
        exactly one more, so an anchor deployed after the network has run
        catches up oldest-first, one transaction per closed epoch.

2.  PtpRules(anchor, ruleKey, "v1", sha256(core/rules/v1.mjs))
        anchor     = the address from step 1
        ruleKey    = the rule key address
        version0   = "v1"
        sourceHash0 = sha256 over the exact bytes core/rules/v1.mjs ships with

3.  The distributor deploys PtpToken from inside its own constructor:

            ptp = new PtpToken(address(this));

        so `distributor` is hardwired to code from the token's first second.
        There is never a window in which a human holds mint rights, and no
        transaction afterwards that transfers them — `distributor` is
        `immutable`.

4.  PtpPool(ptp, wbtc, 30)
        ptp    = the token address created in step 3
        wbtc   = the wrapped-BTC token on the target chain
        feeBps = 30  (0.3%; the constructor refuses anything above 100)

5.  Seed genesis liquidity. From the liquidity account:
        wbtc.approve(pool, 1_000_000)
        ptp.approve(pool,  10_000e18)
        pool.addLiquidity(1_000_000, 10_000e18, 0, <lp address>)
    First deposit only: minShares 0 is safe here because nobody else can see
    the pool yet. It is careless everywhere afterwards.
```

**On step 3, honestly.** Deploying `PtpToken(<an EOA>)` also works and is a
weaker deployment: a person holds mint rights up to the cap, and the only thing
stopping over-emission is that person following the curve. The contract cannot
tell the two apart. If the distributor is an EOA, say so publicly rather than
implying the stronger arrangement.

**Nothing wires backwards.** The token does not know about the pool, the pool
does not know about the anchor, the anchor does not know about the token. The
only cross-reference in the whole folder is `PtpRules → PtpAnchor.currentEpoch()`,
and it is a `view`.

---

## How to compile

`solc` is a devDependency and is **not installed here**, so nothing in this
folder has been compiled or tested against a VM. It has been written to be
obviously correct on the page; that is not the same thing as verified, and the
limits below say so.

```bash
npm install                       # pulls solc (devDependency)
npm run compile                   # ops/compile.mjs — writes <Name>.build.json
```

Or directly, with the settings the predecessor used and these files assume —
Solidity 0.8.24, optimizer ON, 200 runs:

```bash
npx solcjs --optimize --optimize-runs 200 --bin --abi \
  contracts/PtpToken.sol contracts/PtpPool.sol \
  contracts/PtpAnchor.sol contracts/PtpRules.sol
```

Or paste any single file into Remix, select 0.8.24, optimizer ON / 200 runs.
Each file resolves nothing, so all four compile there with no import setup.

---

## Known limits

Stated plainly, because a contract that overstates itself is worse than no
contract.

1. **Not compiled, not tested.** No `solc` in this environment. There is no
   build artifact, no gas measurement, and no test run behind these files.
   Compile before deploying anything, and read the compiler's warnings.

2. **wBTC is somebody else's contract.** `PtpPool` uses stored reserve
   accounting and credits the amount it asked for, not a `balanceOf` delta. If
   wBTC ever became fee-on-transfer or rebasing, the stored reserve would sit
   above the real balance and the shortfall would land on whoever withdrew last.
   The defence would be balance-delta accounting; it is deliberately absent
   because it costs two extra external calls per leg and turns a one-line
   invariant into a conditional one. If wBTC changes, the answer is a new pool
   people migrate to knowingly — not a defensive branch here pretending it was
   ready.

3. **`swap` has no deadline parameter.** ARCHITECTURE.md fixes the signature as
   `swap(sellPtp, amountIn, minOut, to)`. `minOut` covers price; nothing covers
   *time*. A signed transaction held in a mempool or a builder's pocket and
   included hours later still executes if the price is inside the bound, at a
   moment the caller may no longer have wanted to trade. Callers who care must
   manage their own nonces.

4. **MEV is not solved and is not claimed to be.** Sandwiching, reordering and
   priority-fee games are all possible against every function here. `minOut`,
   `minShares`, `minWbtc` and `minPtp` turn a bad fill into a revert; they do
   not prevent the attempt.

5. **Tokens sent directly to `PtpPool` are gone.** No rescue function, by
   design, because a rescue function is an admin key. Such a donation does not
   even reprice the pool — stored reserves ignore it — it simply sits there
   until somebody's swap is paid out of it.

6. **The producer key is a liveness dependency.** If it is lost, no further
   tombstone and no further epoch root is written. Posts still settle, earnings
   are still paid, and the log still replays — the act log is the truth. What
   stops is the mirror. `rotateProducer` is one step with no accept handshake, so
   a rotation to a mistyped address ends anchoring exactly as losing the key
   does; a two-step handshake was rejected because it prevents neither.

7. **The anchor's clock lags, so the on-chain schedule can misdescribe a past
   epoch.** This is the sharpest limit in the folder and it is not closable in
   Solidity. `currentEpoch()` is one past the highest *anchored* epoch, not the
   highest *closed* one. Suppose `highestEpoch` is 10, so `currentEpoch()` is 11,
   while the network is really at epoch 50 and epochs 12–50 were cut under module
   A. `setRules("B", …, 12)` is accepted here, and `rulesFor(20)` then names B for
   an epoch that ran under A. The contract cannot see the act log, does not know
   the true epoch, and has no way to tell the two situations apart.

   What the contract *does* guarantee, exactly: **an answer is frozen once the
   sealed horizon passes it.** Every entry names a `fromEpoch` above
   `currentEpoch()` and above every entry already scheduled, nothing is ever
   removed, and the horizon never moves backwards — so no epoch at or below
   `highestEpoch` can ever have its answer changed. Above the horizon the
   schedule is an *announcement*, not a commitment. (The single exception is the
   ceiling clause in `setRules`, which skips the horizon floor when the clock
   returns `type(uint256).max`. `PtpAnchor` cannot return that: its horizon is a
   tally starting at `GENESIS_EPOCH` that advances one per transaction. The
   clause exists so that no clock value can make `setRules` permanently
   uncallable — see limit 20.)

   The real gate is replay. `core/replay.mjs` refuses a `rulesSet` act whose
   `fromEpoch` is not strictly greater than the true current epoch
   (`RULES_EPOCH_PAST`), and the world state knows that number because it was
   built from the log. So the harmful entry above never lands in the log at all;
   the on-chain row would be a claim with no matching act, contradicted by any
   replay. ARCHITECTURE.md rule 1 is what settles it: the act log is the truth,
   and these contracts are the mirror.

8. **The anchor cannot back-fill an epoch, and cannot start in the middle.**
   `epochRoot` requires `epoch == currentEpoch()`, which is `GENESIS_EPOCH` for
   the first seal and one past the horizon after that. So if one epoch's roots
   are never posted, no later epoch's ever can be either, and an anchor deployed
   after the network has already run must catch up one transaction per closed
   epoch, oldest first. Both are the deliberate cost of refusing gaps: starting at
   today's number would be a silent, irreversible claim that every epoch before
   today was sealed here when none of them was.

9. **A scheduled rule entry cannot be taken back.** `fromEpoch` strictly
   increases, so an entry cannot be superseded, shadowed, or overwritten — only
   outlived by an entry starting later. A mistyped `fromEpoch` of 1000 therefore
   means no module can be scheduled for any epoch before 1000: the intended
   change waits, in public, alongside the visible mistake. That is the price of
   closing the two defects in limit 7's neighbourhood, and it is deliberately
   paid: the alternative was the ability to rewrite a claim about an epoch that
   may already have run. The extreme case is a `fromEpoch` of
   `type(uint256).max`, which is the schedule's terminus — nothing is above it, so
   that entry is the last one the key can ever publish. Self-inflicted, visible,
   and in the same class as `rotateRuleKey` to an address nobody holds. It is the
   only way `setRules` can stop accepting entries; no other key and no clock value
   can do it.

10. **The rule key is a real power.** A captured key can publish a distribution
    formula that pays the wrong people, from a future epoch onward. It is public
    and committed in advance, which is the mitigation, not a removal. Somebody
    has to decide how the pot is divided; the alternatives move the trust rather
    than remove it.

11. **This contract cannot read a JavaScript file.** `setRules` does not check
    that the version exists, that the hash hashes anything, or that the module is
    sane. It records a claim. Readers check the claim against the source served
    at `GET /api/v1/rules/:version`.

12. **`postId` is not verified against the log.** The anchor has no idea what a
    post is. A `publish` for a post that never happened is somebody committing to
    words that match nothing, discovered the moment a reader checks. What the
    derived id *does* guarantee is narrower and worth stating exactly: the row is
    bound to the address that created it and to no other. Unforgeable is not the
    same as true.

13. **No EIP-2612 `permit` on `PtpToken`.** Every pool interaction needs a
    separate `approve` transaction. `permit` would have added a signature scheme,
    a domain separator and a nonce map to a token whose whole argument is that it
    can be read in one sitting.

14. **Shares are not a token.** `PtpPool` share accounting is internal and
    non-transferable. There is nothing to approve and no approval to phish, and
    also no way to sell an LP position without withdrawing it first.

15. **`rulesFor` is a backwards linear scan, by choice.** Strict increase makes
    the schedule sorted, so a binary search is available now; the scan is kept
    because it is a handful of entries added by hand over years, because it is a
    `view` that costs an off-chain caller nothing, and because a scan is checkable
    by reading it where a binary search is checkable by trusting its bounds.

16. **`PtpRules.schedule` only ever grows.** Nothing is removed, by design, so
    `rulesFor` and `activeRules` scan a list that lengthens for the life of the
    contract. They are `view`, so an off-chain reader pays nothing; a contract
    calling `activeRules` on-chain would eventually pay real gas for the scan.
    Only the rule key can extend it, one transaction at a time. `setRules` itself
    no longer walks the schedule at all — it reads the tail and pushes — so its
    gas does not depend on the length; the announcement loop that once did walk it
    is gone with the strict-increase rule that made it dead. Capping the length
    was rejected: it would brick `setRules` permanently, which is a worse failure
    than a slow view. `scheduleLength` and `ruleAt` are there for anyone who wants
    to walk it themselves.

17. **`postId` uses keccak256, so `core/` cannot recompute it.** Every other
    digest that crosses the on-chain/off-chain boundary is sha256, precisely so
    three readers sharing no dependencies can compute it. `postIdFor` is the
    exception: it is the EVM's cheap hash, and nothing off-chain needs to derive
    a postId it did not create — the id arrives in the indexed topic of
    `Published`, alongside the `author`, `cid` and `nonce` that produced it.
    Anything that *does* want to recompute it needs a keccak256 implementation
    (`ethers` has one; `core/` does not, and stays dependency-free).

18. **The Solidity merkle verifier has not been run against `core/merkle.mjs`.**
    It is written to be bit-identical — same sha256, same `0x00`/`0x01`/`0x02`
    domain bytes, same pair-sorting, same unchanged rise of an odd element — and
    `core/merkle.mjs` is the normative copy. But with no `solc` here, "identical"
    is an argument on the page and not a passing test. The one part checked
    without a compiler is `EMPTY_ROOT`, whose literal, whose `emptyRoot()`
    preimage and whose value in `core/merkle.mjs` were compared digit for digit;
    the constructor makes the deployment repeat that comparison. The rest of the
    cross-check belongs in `test/contracts.test.mjs`, run against the same vectors
    `test/merkle.test.mjs` uses, the day the compiler is installed.

19. **A post whose author never lets it lapse never gets a tombstone.** `extend`
    only moves `expires` forward and has no ceiling, so an author can push expiry
    out indefinitely and `settle` stays unreachable. Nobody else is harmed by it —
    the row is the author's own, and rent is charged against the act log, not
    here — but the on-chain lifecycle for that post simply never completes.

20. **`PtpRules` trusts the address wired as its clock.** `clock` is `immutable`
    and set at construction, which is what stops anybody repointing it later, but
    nothing verifies that the address is a `PtpAnchor` — the contract cannot. A
    clock that lies about the epoch defeats the horizon floor completely (a
    hostile one returning 0 accepts anything), and a clock that reverts, or an
    address with no code, makes `setRules` revert with it. Deploy step 1 before
    step 2, check the address, and note that the failure is visible at the first
    call rather than silent. A `try/catch` fallback was rejected: its only
    fallback would be to skip the floor, which converts a visible failure into an
    invisible one.
