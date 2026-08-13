// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PtpToken — "Peer two Peer" (PTP), the money of this network.
 *
 * The most boring ERC-20 that can carry the job. There is no owner, no pause,
 * no blacklist, no fee-on-transfer, no rebase, no upgrade proxy and no
 * privileged setter of any kind. Two things exist beyond the standard: a mint
 * reachable only by the distributor address wired in at construction, and a
 * burn reachable by anybody, for their own coins only.
 *
 * That shape is a security decision, not laziness. Every omitted knob is a key
 * that can be lost, phished or coerced, and on a token that people pair real
 * bitcoin against in PtpPool, "the deployer can mint more" is indistinguishable
 * from a rug pull whether or not anybody intends one. The network's entire
 * claim is that its numbers are checkable; a reader has to be able to establish
 * what this contract can do by reading it once, in full, without trusting a
 * dependency.
 *
 * No imports on purpose. This compiles standalone, so what is deployed is
 * exactly what is read here — nothing fetched at compile time that a reader
 * would have to go and audit as well.
 *
 * ── WHO CAN MINT ───────────────────────────────────────────────────────────
 * One address: `distributor`, immutable, set in the constructor and never
 * writable again. The intended deployment is that the distributor contract
 * creates this token from inside its own constructor —
 *
 *     ptp = new PtpToken(address(this));
 *
 * — so mint rights belong to code, not to a person, from the token's first
 * second of existence. There is no window in which a human holds them and no
 * transaction that transfers them afterwards. Passing an externally owned
 * account here is possible and is a different, weaker deployment; contracts/
 * README.md says so plainly rather than hiding it.
 *
 * The distributor is bounded even so. It can mint up to MAX_SUPPLY in total and
 * it can direct where those coins land — that is the whole of its power. It
 * cannot move a balance that already exists, cannot freeze one, cannot claw one
 * back, cannot burn on someone else's behalf without an allowance, and cannot
 * raise its own ceiling.
 *
 * ── THE CAP, AND THE ARITHMETIC BEHIND IT ──────────────────────────────────
 * ARCHITECTURE.md section 8: at every `closeEpoch`, `emission(epoch)` PTP is
 * minted and split among creators. The emission curve is the predecessor's,
 * unchanged — 5 000 PTP per epoch in year one, decaying by a factor of 0.9 each
 * year, one epoch per day:
 *
 *     year 0 emits   5 000 × 365            = 1 825 000 PTP
 *     year n emits   1 825 000 × 0.9^n
 *
 *     total = 1 825 000 × Σ(n≥0) 0.9^n
 *           = 1 825 000 × 1/(1 − 0.9)
 *           = 1 825 000 × 10
 *           = 18 250 000 PTP
 *
 * A geometric series with ratio < 1 converges, so the schedule never reaches
 * the cap and the cap is never a cliff that stops a scheduled emission — it is
 * the limit the curve approaches from below, written down as a literal so a
 * reader does not have to trust that the off-chain emission function agrees.
 * If the off-chain curve is ever wrong in the direction of inflation, this line
 * is what stops it. The floor of the constant is checked here and the curve is
 * checked in core/; two independent statements of the same number, which is the
 * point of stating it twice.
 *
 * ── THE CAP IS ON WHAT WAS EMITTED, NOT ON WHAT SURVIVES ───────────────────
 * `totalEmitted` only ever rises and is what the cap is measured against.
 * Burning lowers `totalSupply` and does NOT hand the distributor fresh headroom.
 * If the cap were checked against `totalSupply`, the burn share of every action
 * — which ARCHITECTURE.md section 1 makes a permanent part of the fee split —
 * would silently reopen the mint, and 18 250 000 would be a ceiling on the
 * amount in circulation at any instant rather than on the amount ever created.
 * Those are very different promises and only the second one is worth making.
 * The pair (totalEmitted, totalBurned) is exactly `supply: { emitted, burned }`
 * in the replayed World, so the chain and the log state the same two numbers.
 */
contract PtpToken {
    string public constant name = "Peer two Peer";
    string public constant symbol = "PTP";
    uint8 public constant decimals = 18;

    /// The hard ceiling on everything this contract will ever create:
    /// 1 825 000 / (1 − 0.9) = 18 250 000 PTP, in wei. See the header for the
    /// series. Constant, so it is in the bytecode and not in storage where a
    /// setter could one day be pointed at it.
    uint256 public constant MAX_SUPPLY = 18_250_000e18;

    /// The only address `mint` will answer to. Immutable: written once by the
    /// constructor, and there is no function anywhere below that assigns it.
    address public immutable distributor;

    /// Live supply: rises on mint, falls on burn. This is the ERC-20 number.
    uint256 public totalSupply;

    /// Everything ever minted, monotone. The cap is enforced against this one.
    uint256 public totalEmitted;

    /// Everything ever destroyed, monotone. totalEmitted − totalBurned ==
    /// totalSupply at every instant; that identity is the whole accounting.
    uint256 public totalBurned;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// Carries the running total so an indexer following only logs can state
    /// the destroyed supply without a storage read or a sum over history.
    event Burned(address indexed from, uint256 value, uint256 totalBurned);

    constructor(address distributor_) {
        require(distributor_ != address(0), "PTP: distributor is the zero address");
        distributor = distributor_;
    }

    // ── ERC-20 ─────────────────────────────────────────────────────────────

    /// Move `value` of your own coins to `to`. Returns true or reverts; it
    /// never returns false, because a token that answers false is a token whose
    /// callers forget to check.
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// Set `spender`'s allowance to exactly `value`. The well-known race (an
    /// old allowance spent before a new one lands) is left as the standard
    /// leaves it: increase/decrease helpers are not part of ERC-20 and adding
    /// non-standard ones would make routers guess which shape this token has.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value);
        return true;
    }

    // ── Mint — distributor only, never above the cap ────────────────────────

    /**
     * Create `amount` PTP directly into `to`.
     *
     * Only the distributor may call this. The cap is enforced here rather than
     * only in the caller, so even a distributor with a bug in its emission
     * curve cannot exceed 18 250 000 PTP: this is the last line of defence and
     * it does not depend on anything outside this file being correct.
     *
     * Minting straight into the recipient is deliberate — a coin exists for the
     * first time already belonging to the person who earned it, so neither the
     * operator nor the distributor ever holds user coins. That is the strongest
     * available form of "non-custodial", and it is structural: there is no
     * treasury balance here for anyone to reach into, because there is no
     * intermediate hop.
     */
    function mint(address to, uint256 amount) external {
        require(msg.sender == distributor, "PTP: only the distributor may mint");
        require(to != address(0), "PTP: mint to the zero address");
        uint256 emitted = totalEmitted + amount;
        require(emitted <= MAX_SUPPLY, "PTP: max supply reached");
        totalEmitted = emitted;
        totalSupply += amount;
        unchecked {
            // Cannot overflow: this balance is a share of totalSupply, which
            // was just checked and is bounded by MAX_SUPPLY.
            balanceOf[to] += amount;
        }
        // The zero-address `from` is the ERC-20 convention for a mint, and
        // indexers rely on it to see supply come into existence.
        emit Transfer(address(0), to, amount);
    }

    // ── Burn — the deflation path ───────────────────────────────────────────

    /**
     * Destroy `amount` of your own PTP, permanently.
     *
     * This is the burn share of every action in ARCHITECTURE.md section 1,
     * arriving on-chain. Burnt coins are gone from `totalSupply` — not parked
     * at a dead address where a supply figure has to be corrected by hand, and
     * not swept to a contract that could one day be given a way to move them.
     * The reduction is arithmetic, so `totalSupply` needs no footnote.
     *
     * A Transfer to address(0) is emitted alongside Burned because that is what
     * every explorer and indexer already understands as destruction; `Burned`
     * adds the one thing that event cannot carry, the running destroyed total.
     * Note the deliberate asymmetry with the plain `_transfer`, which REFUSES
     * address(0): sending coins to the zero address by accident is a mistake,
     * while destroying them is a decision, and the two get different functions
     * so the second one cannot happen by fat-finger.
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * Destroy `amount` of `account`'s PTP, spending your allowance for it.
     *
     * This is how a settlement contract or a distributor burns the protocol's
     * share without ever holding it: the payer approves, the burner destroys,
     * and the coins never sit in an intermediate balance that somebody could be
     * persuaded to redirect. The allowance check is the same one transferFrom
     * uses — there is no path here that burns another account's coins without
     * that account having granted it.
     */
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    function _transfer(address from, address to, uint256 value) internal {
        // Refused rather than silently allowed: this token has exactly one
        // destruction mechanism, `burn`, and two different ways to destroy
        // coins would make every supply figure ambiguous about which of them
        // it counted.
        require(to != address(0), "PTP: transfer to the zero address");
        uint256 bal = balanceOf[from];
        require(bal >= value, "PTP: balance too low");
        unchecked {
            balanceOf[from] = bal - value;
            // Cannot overflow: the sum of all balances is totalSupply.
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _burn(address from, uint256 value) internal {
        uint256 bal = balanceOf[from];
        require(bal >= value, "PTP: balance too low");
        unchecked {
            balanceOf[from] = bal - value;
            // Cannot underflow: value <= bal <= totalSupply.
            totalSupply -= value;
            // Cannot overflow: bounded by totalEmitted, itself <= MAX_SUPPLY.
            totalBurned += value;
        }
        emit Transfer(from, address(0), value);
        emit Burned(from, value, totalBurned);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 allowed = allowance[owner][spender];
        // An infinite allowance is left untouched rather than decremented —
        // the near-universal convention, and what routers and pools expect.
        if (allowed != type(uint256).max) {
            require(allowed >= value, "PTP: allowance exceeded");
            unchecked {
                allowance[owner][spender] = allowed - value;
            }
        }
    }
}
