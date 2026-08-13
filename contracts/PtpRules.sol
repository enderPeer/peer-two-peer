// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PtpRules — the rule key, and the exact size of what it can do.
 *
 * ARCHITECTURE.md section 8: a named `ruleKey` address may swap the module that
 * divides each epoch's emission among creators, for FUTURE epochs only. This
 * contract is the on-chain half of that: a published, timestamped, append-only
 * schedule of which formula version was CLAIMED to govern from which epoch.
 *
 * Read that sentence exactly. It is a schedule of claims, and the difference
 * between a claim and a fact is the whole of the section headed THE NARROW
 * GUARANTEE below. This contract cannot see the act log, cannot see the true
 * epoch, and therefore cannot promise that a past epoch is described here by the
 * module that actually computed it. What it can promise is that once the anchor
 * has sealed an epoch, this contract's answer for that epoch never changes
 * again.
 *
 * ── WHAT THE RULE KEY CANNOT DO ────────────────────────────────────────────
 * It cannot mint. It cannot move a balance. It cannot touch the pool. It cannot
 * alter a sealed root. It cannot recompute an epoch's emission — nothing here
 * computes an emission at all — and it cannot change what this schedule says
 * about any epoch the anchor has already sealed.
 *
 * That is not a promise, it is the shape of the file, and a reader should check
 * it rather than believe it. This contract holds no token address, no pool
 * address, and no coins; it has no payable function, no `transfer`, no
 * `delegatecall`, no `call`, and no way to reach an arbitrary address. The ONLY
 * outward reference it has is `clock`, and the interface it is reached through
 * declares exactly one function, `view`, which by the compiler's own rules
 * cannot write anything anywhere. Every state-changing line in this file writes
 * to one of two places: the schedule below, or `ruleKey` itself. There is no
 * third.
 *
 * So the worst a captured rule key can do is publish a distribution formula
 * that pays the wrong people from a future epoch onward — in public, in
 * advance, with the source hash committed before the epoch it applies to
 * begins. That is a real power and it is not being minimised here. It is also
 * the smallest form the power can take: somebody has to decide how a pot is
 * divided, and the alternatives move the trust rather than remove it. An oracle
 * committee is a rule key with more addresses; a token vote is a rule key
 * elected by whoever holds the most; an on-chain replay of the whole act log is
 * a rewrite of the engine in Solidity paid for by everyone. What is done here
 * instead is to make the role SMALL, its every use PUBLIC, and its reach
 * strictly FORWARD.
 *
 * ── APPEND-ONLY, AND STRICTLY INCREASING ───────────────────────────────────
 * Two rules, and both are load-bearing:
 *
 *   1. Nothing is ever removed from the schedule, moved inside it, or
 *      overwritten. Only `push`. There is no `pop` in this file.
 *   2. Every pushed `fromEpoch` is strictly greater than the last one, and
 *      strictly greater than the epoch PtpAnchor reports as current.
 *
 * Together they make the schedule a sorted partition of the epoch line: entry i
 * governs [fromEpoch_i, fromEpoch_{i+1}) and the last entry governs everything
 * from its own epoch on. Nothing is ever superseded, because nothing can ever be
 * pushed underneath something already there. `_rulesFor` reads that partition
 * off with a backwards scan: the last entry at or below the asked-for epoch.
 *
 * ── THE TWO DEFECTS THAT SHAPE EXISTS TO PREVENT ───────────────────────────
 * `setRules` used to POP pending entries off the end before pushing, where
 * "pending" meant `fromEpoch > clock.currentEpoch()`. The clock is PtpAnchor's
 * SEALED horizon and it lags the network by however far the producer is behind
 * on anchoring. So an entry could be dropped that had already begun governing a
 * real, closed-but-unanchored epoch: the epoch was cut with module B, the entry
 * naming B was deleted, and `rulesFor(thatEpoch)` afterwards named A. Nothing
 * here pops, and rule 1 is why.
 *
 * The round that removed the pop also removed rule 2, and that cost twice. It
 * let a push land at or below an existing entry, which meant a published answer
 * for an epoch could still be changed — the deletion defect wearing a different
 * coat. And it made the announcement loop that walked the shadowed tail grow
 * with the schedule, so a key pushing descending epochs (1000, 999, 998, …) paid
 * O(n^2) gas until `setRules` exceeded the block gas limit and could never be
 * called again. Rule 2 closes both: with a strictly increasing schedule no
 * earlier entry is ever shadowed, so there is nothing to announce, so the loop
 * is gone entirely and `setRules` costs the same gas at entry one thousand as at
 * entry two — one tail read, one push.
 *
 * ── THE NARROW GUARANTEE ───────────────────────────────────────────────────
 * Stated exactly, because the version of it that was written here before was
 * bigger than the code:
 *
 *   AN ANSWER IS FROZEN ONCE THE SEALED HORIZON PASSES IT. Every push names a
 *   `fromEpoch` strictly above `clock.currentEpoch()`, and a push at F changes
 *   the answer for epochs >= F and for no others. `currentEpoch()` never goes
 *   backwards — PtpAnchor's horizon only advances. So for any epoch e that the
 *   anchor has sealed, every future push has F > currentEpoch() > e, and
 *   `rulesFor(e)` is fixed forever. The one clause that steps around this floor
 *   is the ceiling clause in `setRules`, which applies only when the clock
 *   returns type(uint256).max — a value PtpAnchor cannot reach, because its
 *   horizon is a tally that starts at GENESIS_EPOCH and advances one per
 *   transaction. Against a clock that is not that anchor, this guarantee was
 *   never available in the first place: a clock free to return the ceiling is
 *   equally free to return 0.
 *
 *   ABOVE THE HORIZON THE SCHEDULE IS AN ANNOUNCEMENT, NOT A COMMITMENT. The
 *   clock is the SEALED horizon and it lags the network by an amount nothing on
 *   chain can measure. With the anchor at epoch 10 (`currentEpoch()` = 11) while
 *   the network is really at epoch 50, a push naming epoch 12 is accepted here,
 *   and `rulesFor(20)` then names a module for an epoch that was cut under
 *   another one. This contract cannot detect that and does not pretend to. It
 *   knows one number, and that number is not the epoch.
 *
 *   THE REAL GATE IS REPLAY. core/replay.mjs refuses a `rulesSet` act whose
 *   `fromEpoch` is not strictly greater than the TRUE current epoch — see
 *   RULES_EPOCH_PAST in core/errors.mjs — and the world state knows that number
 *   because it was built from the log. An entry here that replay never accepted
 *   governs nothing: it is a claim the log contradicts, discoverable by anyone
 *   who replays. ARCHITECTURE.md rule 1 settles which of the two wins, and it is
 *   not this one.
 *
 * So ARCHITECTURE.md section 8's "every past epoch stays recomputable with the
 * module that actually computed it" is a property of the LOG and of the source
 * the API serves, held up by replay's own gate. This contract contributes the
 * timestamped public record of each claim and the freeze below the horizon. It
 * does not contribute the promise, and a reader should not take it as one.
 *
 * ── ONE VERSION STRING, ONE HASH ───────────────────────────────────────────
 * `version` is the human name, `sourceHash` is sha256 of the module's bytes.
 * The hash is what binds: `GET /api/v1/rules/:version` publishes the full source
 * of any earlier version, and a reader who hashes what they were served and
 * compares it to the word committed here either matches bits or has caught
 * somebody serving a different file under an old name. The version string alone
 * would be a label; the hash is what makes it a commitment.
 *
 * No imports on purpose. The interface below is declared locally, so this file
 * compiles standalone and what is deployed is exactly what is read here.
 */

/// Deliberately one function wide, and deliberately `view`. This is the entire
/// outward surface of PtpRules, and a `view` interface is a compiler-enforced
/// statement that nothing this contract calls can change anything.
interface IPtpAnchorClock {
    function currentEpoch() external view returns (uint256);
}

contract PtpRules {
    struct Rule {
        /// The first epoch this entry governs. It governs from here up to the
        /// next entry's `fromEpoch`, or forever if it is the last one. Strictly
        /// greater than the entry before it — `setRules` enforces that, which is
        /// what makes the schedule sorted and makes this comment a description
        /// of the storage rather than of an intention.
        uint256 fromEpoch;
        /// sha256 of the rules module's source bytes.
        bytes32 sourceHash;
        /// Which key published it. Kept because the key can rotate, and "who
        /// set this" is not answerable later from the current holder.
        address setBy;
        /// Chain time at publication, never the caller's. Doubles as nothing —
        /// entry 0 exists from construction, so presence is length, not time.
        uint64 setAt;
        /// The module's human name, e.g. "v1". Declared last because a dynamic
        /// type takes a whole slot of its own whatever its position, and
        /// putting it here leaves `setBy` (20 bytes) and `setAt` (8 bytes)
        /// adjacent so they pack into one slot instead of two.
        string version;
    }

    /// The one clock, immutable. Wiring it at construction rather than letting
    /// it be set later is the difference between "cannot be retroactive" and
    /// "cannot be retroactive unless somebody repoints the clock".
    IPtpAnchorClock public immutable clock;

    /// The only address `setRules` and `rotateRuleKey` answer to.
    address public ruleKey;

    /// Append-only and sorted. Entry 0 is written by the constructor at
    /// whatever epoch the clock then read, no entry is ever removed, and every
    /// later entry names a strictly greater epoch — so the last entry is always
    /// the largest `fromEpoch` in the array, and an answer stays fixed once the
    /// sealed horizon has passed the epoch it answers for. `rulesFor` has an
    /// answer for every epoch from entry 0's onward, and refuses below it,
    /// because this registry genuinely did not govern those epochs.
    Rule[] private schedule;

    /// The only event a scheduling call emits, because a push under a strictly
    /// increasing rule shadows nothing: every earlier entry keeps the exact span
    /// it already governed. There is deliberately no "superseded" or "withdrawn"
    /// companion — an event for something that cannot happen would be a claim
    /// about the schedule that the schedule does not make.
    event RulesSet(
        uint256 indexed fromEpoch, string version, bytes32 sourceHash, address indexed setBy, uint64 at
    );
    event RuleKeyRotated(address indexed from, address indexed to);

    /**
     * The genesis rule is a constructor argument rather than a first
     * transaction, so there is never a moment in which this contract exists
     * with an empty schedule. It governs from the epoch the clock reads at
     * deployment — see the block inside the constructor for why that is not
     * simply 0 — and, like every entry in this schedule, can never be removed
     * or altered. A later entry takes over from its own epoch onward, which is
     * what scheduling a new module means, and it can never reach below that:
     * every one of them names an epoch strictly greater than this entry's. So
     * this entry's answer is final for its own span, and the schedule is sorted
     * from its first line.
     */
    constructor(address anchor_, address ruleKey_, string memory version0, bytes32 sourceHash0) {
        require(anchor_ != address(0), "PTP-RULES: anchor is the zero address");
        require(ruleKey_ != address(0), "PTP-RULES: rule key is the zero address");
        require(bytes(version0).length > 0, "PTP-RULES: version is empty");
        require(sourceHash0 != bytes32(0), "PTP-RULES: sourceHash is zero");
        clock = IPtpAnchorClock(anchor_);
        ruleKey = ruleKey_;

        // The genesis entry starts where the CLOCK is, not at epoch 0.
        //
        // Writing 0 unconditionally was a real defect, and one the rule key
        // could not reach: floor one refuses `fromEpoch <= 0`, so epoch 0's
        // answer is frozen the moment this line runs. That freeze is the
        // problem. If this contract is deployed after the anchor's horizon has
        // already advanced — a redeployment, or simply deploy step 2 landing a
        // few blocks after step 1 — then a genesis entry at 0 claims every
        // already-sealed epoch, at or below the horizon, where the "above the
        // horizon it is only an announcement" caveat does not apply. It would
        // permanently and unfixably name version0 for epochs that ran under
        // something else, which is exactly the misdescription this whole
        // contract exists to prevent.
        //
        // Anchoring to `currentEpoch()` makes the claim true by construction:
        // the genesis entry governs from the first epoch this registry could
        // possibly have influenced, and every epoch sealed before it is
        // reported as ungoverned rather than misreported as governed by
        // version0. On a clean deployment the clock reads GENESIS_EPOCH and
        // this is 0, so nothing changes for the intended path.
        uint256 from0 = clock.currentEpoch();
        schedule.push(
            Rule({
                fromEpoch: from0,
                sourceHash: sourceHash0,
                setBy: msg.sender,
                setAt: uint64(block.timestamp),
                version: version0
            })
        );
        emit RulesSet(from0, version0, sourceHash0, msg.sender, uint64(block.timestamp));
    }

    modifier onlyRuleKey() {
        require(msg.sender == ruleKey, "PTP-RULES: only the rule key");
        _;
    }

    /**
     * Schedule a distribution module for a future epoch. Two floors, and the new
     * entry must clear both.
     *
     * ── FLOOR ONE: THE SCHEDULE'S OWN TAIL ─────────────────────────────────
     * `fromEpoch` must be strictly greater than the last entry's. The tail is
     * the largest epoch in the array — entry 0 is the deployment epoch and
     * every push since has increased it, so that is an induction, not an
     * assumption — which means this one comparison keeps the whole schedule
     * sorted.
     *
     * What it buys is that a push can never land underneath an entry already
     * there. Every earlier entry keeps exactly the span it already governed, so
     * no published answer for any epoch below `fromEpoch` moves. Without it, a
     * push at a lower epoch reaches back over epochs an earlier entry already
     * covered, which is the deletion defect the pop caused, arrived at by
     * addition instead of removal.
     *
     * It also removes a gas trap the loop-free push had opened. When entries
     * could land under each other, `setRules` had to walk the shadowed tail to
     * announce it, so descending pushes (1000, 999, 998, …) cost O(n^2) and
     * eventually more than a block. Sorted, nothing is ever shadowed, there is
     * nothing to walk and no loop to walk it with: the cost of this function no
     * longer depends on the schedule's length at all.
     *
     * The price, stated because it is real: a mistyped `fromEpoch` cannot be
     * taken back. Naming epoch 1000 by accident means no module can be scheduled
     * for anything before epoch 1000 — the intended change waits, in public,
     * where everyone can see the mistake and the correction. That is worse
     * ergonomics and a strictly smaller power than the alternative, which was
     * the ability to rewrite a claim about an epoch that may already have run.
     *
     * The extreme of that price is the one terminus this schedule has. A key
     * that names type(uint256).max has published its final entry, because
     * nothing is above it and floor one is strictly greater. That is a rule key
     * ending its own office in one visible transaction — the same class of
     * self-inflicted, public, unrecoverable act as `rotateRuleKey` to an address
     * nobody holds, and it is listed as a limit in contracts/README.md. It is
     * also the ONLY way this function can stop accepting entries: no other key,
     * and no number the clock can return, can put the schedule there.
     *
     * ── FLOOR TWO: THE SEALED HORIZON ──────────────────────────────────────
     * `fromEpoch` must also be strictly greater than `clock.currentEpoch()`.
     * Equal is refused as firmly as smaller: the epoch the anchor reports as
     * current is already being accumulated against a formula, and changing the
     * formula halfway through it would mean the epoch was computed under two
     * rulebooks — the one thing "one rulebook, three readers" cannot survive.
     *
     * This floor is what freezes an answer once the horizon passes it, and it is
     * ALL it does. The horizon lags the true epoch; see THE NARROW GUARANTEE in
     * the header for exactly what that leaves standing and what replay has to
     * carry instead.
     *
     * THE CEILING CLAUSE, and why the check is conditional. `clock` is an
     * external contract, and a floor of type(uint256).max would have no epoch
     * above it: the requirement would be unsatisfiable and this function would be
     * permanently uncallable, for every caller, by every argument. That is
     * exactly how a producer key once bricked this contract — a single genesis
     * seal at type(uint256).max − 1 made `currentEpoch()` return the ceiling, and
     * "strictly greater" had no answer. PtpAnchor now pins its first seal to
     * GENESIS_EPOCH and advances one per transaction, so no key can drive it
     * there any more; this clause is the second, independent closure, and it
     * holds even if the address wired as `clock` is not that anchor. A number
     * with no successor is not an epoch, so it is not accepted as a floor.
     *
     * The clause gives up nothing that trusting the clock had not already given
     * up: a hostile clock could return 0 and defeat this floor completely. What
     * it removes is the one clock value that could take the rule key's whole
     * function away. For every uint256 the clock can return, some `fromEpoch` is
     * still accepted — which is what "cannot be locked out" has to mean.
     *
     * What it does not cover, said plainly: a `clock` that is not a clock. An
     * address with no code, or a contract that reverts, makes this function
     * revert with it, and no arrangement inside this file repairs a wrong
     * constructor argument. That is a deployment error, visible at the first call
     * and before anything depends on the answer. Catching it with a `try` would
     * be worse than leaving it: the only fallback would be to skip the floor,
     * which turns "never retroactive" into a silent no-op the moment the clock
     * misbehaves — trading a visible failure for an invisible one.
     *
     * Nothing here validates that the version actually exists, that the hash is
     * the hash of anything, or that the module is sane. This contract cannot
     * read a JavaScript file and refuses to pretend. What it provides is that a
     * claim was published, by that key, at that time, for that epoch — and
     * readers check the rest against the source the API serves.
     */
    function setRules(string calldata version, bytes32 sourceHash, uint256 fromEpoch) external onlyRuleKey {
        require(bytes(version).length > 0, "PTP-RULES: version is empty");
        require(sourceHash != bytes32(0), "PTP-RULES: sourceHash is zero");

        // Floor one. The schedule is never empty — the constructor pushes entry
        // 0 — so this read is always in range.
        uint256 last = schedule[schedule.length - 1].fromEpoch;
        require(fromEpoch > last, "PTP-RULES: fromEpoch must be above every entry already scheduled");

        // Floor two, skipped only for the one value that would leave nothing
        // above it. See the ceiling clause above.
        uint256 cur = clock.currentEpoch();
        if (cur != type(uint256).max) {
            require(fromEpoch > cur, "PTP-RULES: rules are never retroactive");
        }

        uint64 at = uint64(block.timestamp);
        schedule.push(
            Rule({
                fromEpoch: fromEpoch,
                sourceHash: sourceHash,
                setBy: msg.sender,
                setAt: at,
                version: version
            })
        );
        emit RulesSet(fromEpoch, version, sourceHash, msg.sender, at);
    }

    /**
     * Which module this schedule says governed `epoch` — for any epoch, past or
     * future.
     *
     * A backwards linear scan: the last entry whose `fromEpoch` is at or below
     * the asked-for epoch. Because `setRules` keeps the array strictly
     * increasing, that entry is unique and the scan is reading a sorted
     * partition rather than resolving a conflict between overlapping claims —
     * there are no overlapping claims to resolve.
     *
     * WHAT "FOREVER" MEANS HERE, precisely. An answer for `epoch` can only be
     * changed by a later push naming a `fromEpoch` at or below `epoch`, and
     * every push names one strictly above `clock.currentEpoch()`. So the answer
     * for every epoch the anchor has sealed is fixed for good, and the answer for
     * an epoch above the sealed horizon can still move. The horizon is not the
     * true epoch — read THE NARROW GUARANTEE in the header before quoting this
     * function as proof that a past epoch is described correctly. It proves the
     * schedule has not been edited. It does not prove the schedule was right.
     *
     * Linear rather than a binary search, which the sorted array would now
     * permit. Kept because it is a handful of entries added by hand over years,
     * because this is a `view` that costs an off-chain caller nothing, and
     * because a scan is checkable by reading it where a binary search is
     * checkable by trusting its bounds. `scheduleLength` and `ruleAt` are there
     * for a caller who would rather walk it themselves.
     *
     * Every epoch has an answer, including epochs that have not happened: entry
     * 0 governs from 0, so the scan always terminates on a real entry and never
     * returns an empty string that a caller might mistake for "unset".
     */
    function rulesFor(uint256 epoch)
        external
        view
        returns (string memory version, bytes32 sourceHash, uint256 fromEpoch, address setBy, uint64 setAt)
    {
        return _rulesFor(epoch);
    }

    /// The module governing the epoch the ANCHOR reports as current, by the same
    /// clock `setRules` is bound to. That is the sealed horizon and not the true
    /// epoch, so while the producer is behind on anchoring this names the module
    /// for an epoch the network has already left. A caller who needs the module
    /// for the epoch actually running asks replay, which knows the number.
    ///
    /// Calls the internal lookup rather than `this.rulesFor(...)`: a self
    /// STATICCALL would make the two functions capable of disagreeing if one
    /// were ever changed, and this way they are the same code by construction.
    function activeRules()
        external
        view
        returns (string memory version, bytes32 sourceHash, uint256 fromEpoch, address setBy, uint64 setAt)
    {
        return _rulesFor(clock.currentEpoch());
    }

    function _rulesFor(uint256 epoch)
        internal
        view
        returns (string memory version, bytes32 sourceHash, uint256 fromEpoch, address setBy, uint64 setAt)
    {
        uint256 i = schedule.length;
        while (i > 0) {
            unchecked {
                --i;
            }
            Rule storage r = schedule[i];
            if (r.fromEpoch <= epoch) {
                return (r.version, r.sourceHash, r.fromEpoch, r.setBy, r.setAt);
            }
        }
        // REACHABLE, since the genesis entry is anchored to the clock rather
        // than pinned to 0: any epoch sealed BEFORE this registry was deployed
        // is below entry 0's `fromEpoch` and is governed by no entry here.
        //
        // Reverting is the honest answer and the safe one. The alternative —
        // falling through to entry 0 — is precisely the misdescription the
        // constructor's anchoring exists to prevent: it would report version0
        // as having governed epochs that ran before this contract existed. A
        // caller that gets this revert learns something true (this registry
        // does not cover that epoch) instead of something false, and can go to
        // the epoch block itself, which seals the rule edition that actually
        // computed it.
        revert("PTP-RULES: epoch predates this registry");
    }

    function scheduleLength() external view returns (uint256) {
        return schedule.length;
    }

    /// The raw schedule, entry by entry, so a caller can rebuild the whole
    /// history without trusting this contract's own lookup. Every entry ever
    /// published is still here, in publication order, which is also epoch order
    /// — nothing was removed and nothing was pushed underneath anything.
    function ruleAt(uint256 i)
        external
        view
        returns (string memory version, bytes32 sourceHash, uint256 fromEpoch, address setBy, uint64 setAt)
    {
        require(i < schedule.length, "PTP-RULES: no such entry");
        Rule storage r = schedule[i];
        return (r.version, r.sourceHash, r.fromEpoch, r.setBy, r.setAt);
    }

    /**
     * Hand the rule key to another address. Callable by the rule key and by
     * nobody else, so this is a key passing itself along and never an admin
     * reassigning a role — there is no admin in this file to do the reassigning.
     *
     * Rotation grants the new holder exactly what the old one had, which the
     * header enumerates and which does not include a single coin. It does not
     * reopen a sealed entry, does not change what governed any past epoch, and
     * does not reach an entry already scheduled — the successor can only add
     * entries above the last one, in public, like anybody in the office would.
     *
     * One step, no accept handshake. A transfer to a mistyped address ends the
     * ability to schedule new modules, which freezes the distribution formula at
     * whatever is scheduled — an honest and survivable failure, since the
     * network keeps running on the last published rulebook. That risk is listed
     * in contracts/README.md rather than papered over with a second transaction
     * that fails identically when the key is simply lost.
     */
    function rotateRuleKey(address newRuleKey) external onlyRuleKey {
        require(newRuleKey != address(0), "PTP-RULES: rule key is the zero address");
        address old = ruleKey;
        ruleKey = newRuleKey;
        emit RuleKeyRotated(old, newRuleKey);
    }
}
