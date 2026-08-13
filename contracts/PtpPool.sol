// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PtpPool — the one pool. wBTC against PTP, constant product, nothing else.
 *
 * ARCHITECTURE.md section 2 says "a single constant-product market", and this
 * contract refuses to be more general than that sentence. There is no factory,
 * no pair registry, no named pools, no second market. Both token addresses and
 * the fee are fixed at construction and immutable afterwards, which means the
 * entire configuration of this contract is decided before it has ever held a
 * coin and can never be revisited.
 *
 * ── THERE IS NO ADMIN ──────────────────────────────────────────────────────
 * No owner, no pause, no fee switch, no sweep, no rescue, no migration, no
 * upgrade proxy, no privileged function of any kind. Nobody — including
 * whoever deployed it — can stop this pool, drain it, reprice it, or take a
 * cut. Read the function list: every state-changing function is callable by
 * anyone and does the same thing for everyone. That is the only acceptable
 * number of keys on a contract holding other people's bitcoin.
 *
 * The honest consequence, stated once and not hedged: there is no rescue
 * either. A user who sends tokens directly to this address instead of calling
 * addLiquidity has donated them to the shareholders, and no function here will
 * give them back. Stored reserves are the accounting (see below), so such a
 * donation does not even move the price — it simply sits there, unowned and
 * unreachable, until somebody's swap happens to be paid out of it.
 *
 * ── UNIT NOTE ──────────────────────────────────────────────────────────────
 * wBTC has 8 decimals, so one raw wBTC unit is one satoshi and the reserve here
 * is the same integer the act log calls `sat`. PTP has 18 decimals and its
 * reserve is the same integer the log calls `ptp` (wei). Genesis liquidity from
 * ARCHITECTURE.md section 2 is therefore 1 000 000 wBTC units against
 * 10 000e18 PTP units — 0.01 BTC against 10 000 PTP, spot 1 PTP = 100 sat.
 *
 * ── THE ARITHMETIC ─────────────────────────────────────────────────────────
 * x·y = k with a fee in basis points, in the exact form core/amm.mjs computes
 * in BigInt:
 *
 *     out = rOut·(10000 − fee)·Δin / (rIn·10000 + (10000 − fee)·Δin)
 *
 * The division is deferred to the very end so no integer truncation eats part
 * of the fee, and the same expression appears in both implementations so the
 * price a browser showed and the price the chain charged are the same number
 * rather than two numbers that usually agree.
 *
 * The fee is never taken out of the pool. It stays in the reserve, so k grows
 * on every swap and that growth IS the liquidity providers' pay. There is no
 * separate fee balance to administer, to account for, or to steal — the
 * absence of that balance is why there is no admin function to sweep it.
 *
 * ── RESERVES ARE STORED, NOT READ ──────────────────────────────────────────
 * The reserves below are stored accounting, credited with the amount the
 * contract asked for, not with a balanceOf() difference. Say the assumption out
 * loud, because it is one: both tokens must move exactly what they are told to
 * move. PTP is this repository's own token and can never change. wBTC is
 * somebody else's contract, and if it ever became fee-on-transfer or rebasing,
 * this pool would credit more than it received, the stored reserve would sit
 * above the real balance, and the shortfall would land on whoever withdrew
 * last. Balance-delta accounting would defend against that; it is deliberately
 * not here, because it costs two extra external calls on every leg and trades a
 * one-line invariant ("reserves are what people put in") for a conditional one
 * ("reserves are whatever the token chose to hand over"). If wBTC ever becomes
 * a fee-on-transfer asset it is a different asset than this pool was written
 * for, and the honest answer that day is a new pool people migrate to knowing
 * why — not a defensive branch here pretending it was ready.
 *
 * Rounding, everywhere it appears, favours the pool: minted shares round down,
 * amounts pulled in round up, amounts paid out round down. The dust that
 * strands belongs to every shareholder pro rata and to no particular caller.
 *
 * No imports on purpose; the IERC20 below is declared locally so this file
 * compiles standalone and what is deployed is exactly what is read here.
 */

interface IERC20 {
    // Declared with `returns (bool)` and every call is wrapped in a require: a
    // token that answers false must revert the whole act, never leave the pool
    // believing coins arrived that did not.
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PtpPool {
    /// The PTP side. Immutable, so the pool cannot be pointed at another token.
    address public immutable ptp;

    /// The wBTC side. Immutable for the same reason.
    address public immutable wbtc;

    /// Swap fee in basis points, fixed at construction. There is no setter.
    uint256 public immutable feeBps;

    /**
     * Share units locked forever at the first deposit. UniswapV2's constant,
     * kept for UniswapV2's reason: without it the first depositor can seed the
     * pool with dust, donate directly to the contract to inflate the price of
     * one share, and then rob the next depositor by rounding. Locking a
     * thousand units makes that inflation cost more than it earns.
     *
     * "Locked forever" is literal. The units are credited to address(0), an
     * address nobody can send a transaction from, so they are exactly as
     * unremovable as burnt. A consequence worth stating: totalShares can
     * therefore never reach zero, so every division by it below is safe and the
     * pool can be thinned but never closed.
     */
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    /// Reserves in raw token units. wBTC units are satoshis; PTP units are wei.
    uint256 public reserveWbtc;
    uint256 public reservePtp;

    /// Share accounting, internal and non-transferable. Shares are not a token:
    /// there is nothing here to approve, nothing to phish an approval for, and
    /// no second contract that has to be trusted to hold them.
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event LiquidityAdded(address indexed by, address indexed to, uint256 wbtcIn, uint256 ptpIn, uint256 shares);
    event LiquidityRemoved(address indexed by, address indexed to, uint256 wbtcOut, uint256 ptpOut, uint256 shares);
    /// The last field is deliberately not called `amountOut`: that name belongs
    /// to the pure function below, and an event parameter that shadows it would
    /// compile with a warning nobody should have to read past.
    event Swapped(address indexed by, address indexed to, bool sellPtp, uint256 amountIn, uint256 out);

    /**
     * The reentrancy lock: one storage flag, checked and flipped by hand.
     *
     * WHAT IT DOES. Every function below hands control to an external token
     * contract at the end. If either token gained a transfer hook — wBTC is not
     * this repository's contract and its behaviour is not this repository's to
     * promise — a recipient could call back into this pool from inside that
     * hook. The lock makes the second entry revert instead of running against
     * half-updated state. Together with checks-effects-interactions ordering
     * (reserves and shares are written BEFORE any token moves) this closes the
     * question twice rather than once: even if the lock were removed, a
     * re-entrant caller would find reserves that were already correct.
     *
     * WHAT IT DOES NOT PROTECT AGAINST, plainly:
     *   - being reordered. A trade landing ahead of yours moves the price. That
     *     is minOut's job, not the lock's, and no lock can help there.
     *   - a lying token. If wBTC took a fee on transfer or rebased balances, the
     *     lock would hold perfectly while the stored reserves drifted away from
     *     the real ones.
     *   - reentrancy into OTHER contracts. A protocol that reads getReserves()
     *     from inside a token hook of its own is reading this pool's state
     *     mid-transaction; because of the effects-first ordering the numbers it
     *     sees are post-trade and consistent, but that is this pool's ordering
     *     doing the work, not this flag.
     *   - anything at all in a transaction that never calls this contract.
     */
    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "PTP-POOL: reentered");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    /**
     * The entire configuration, decided once. The fee is capped at 100 bps
     * because an unbounded constructor argument would let a deployer build a
     * pool that quietly takes everything, and a reader checking "is the fee
     * sane" would have to go and look at a deployment transaction instead of
     * this file. The network's own parameter is 30 bps.
     */
    constructor(address ptp_, address wbtc_, uint256 feeBps_) {
        require(ptp_ != address(0) && wbtc_ != address(0), "PTP-POOL: token address is zero");
        require(ptp_ != wbtc_, "PTP-POOL: the two tokens must differ");
        require(feeBps_ <= 100, "PTP-POOL: fee above 1 percent");
        ptp = ptp_;
        wbtc = wbtc_;
        feeBps = feeBps_;
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /**
     * TWO static words, in this order and no other:
     *
     *   word 0  reserveWbtc   uint256   (satoshis)
     *   word 1  reservePtp    uint256   (wei)
     *
     * so a reader with curl and no ABI library can decode the answer by cutting
     * the hex into 32-byte slices. Anything added later goes on the END, so the
     * offsets a reader hardcoded today keep pointing at the same fields.
     */
    function getReserves() external view returns (uint256 wbtcReserve, uint256 ptpReserve) {
        return (reserveWbtc, reservePtp);
    }

    /**
     * The swap formula, exposed so a caller can compute the same number this
     * contract will compute, from the same code, before signing anything.
     *
     * Written as `pure` with the fee passed in rather than reading the
     * immutable, so it is byte-identical in shape to core/amm.mjs
     * `amountOut(amountIn, reserveIn, reserveOut, feeBps)` and can be tested
     * against it argument for argument. The multiplications are checked
     * arithmetic: on reserves large enough to overflow a uint256 product this
     * reverts rather than wrapping, which is the correct failure for a number
     * that is about to become a price.
     */
    function amountOut(uint256 amountIn_, uint256 reserveIn, uint256 reserveOut, uint256 feeBps_)
        public
        pure
        returns (uint256)
    {
        require(amountIn_ > 0, "PTP-POOL: amount in must be positive");
        require(reserveIn > 0 && reserveOut > 0, "PTP-POOL: pool is empty");
        require(feeBps_ <= 10000, "PTP-POOL: fee above 100 percent");
        uint256 inWithFee = amountIn_ * (10000 - feeBps_);
        return (reserveOut * inWithFee) / (reserveIn * 10000 + inWithFee);
    }

    // ── Liquidity ───────────────────────────────────────────────────────────

    /**
     * Deposit both sides and receive shares.
     *
     * FIRST DEPOSIT. Shares are sqrt(wbtcIn · ptpIn), the geometric mean, so the
     * opening share count does not depend on which side is called which.
     * MINIMUM_LIQUIDITY of them go to address(0) and stay there forever; the
     * rest go to `to`. The opening ratio IS the opening price, invented by the
     * first depositor because there is no market yet to disagree with them.
     *
     * EVERY LATER DEPOSIT TAKES THE PROPORTIONAL PART. You state ceilings; the
     * pool computes the largest deposit that fits under BOTH of them at the
     * current ratio, mints shares for that, and pulls only the used amounts.
     * The excess side never leaves your wallet, so there is nothing to refund
     * and no refund path to get wrong.
     *
     * This is the rule that stops a skewed deposit minting shares against
     * existing providers. If the binding side were ignored, a depositor could
     * hand over a lopsided pair, be credited for the full value of both sides at
     * a ratio the pool does not hold, and take part of everyone else's reserve
     * with them on the way out. Taking the proportional part makes a skewed
     * offer simply a smaller deposit.
     *
     * `minShares` is the guard against being sandwiched: a swap landing just
     * ahead of you moves the ratio, which changes WHICH side binds and can mint
     * fewer shares for the same coins. Zero means no guard, which is careless
     * anywhere but a pool nobody else can see yet.
     *
     * Rounding: `minted` rounds down and the pulled amounts round up, so both
     * favour the pool. Neither ceiling can be exceeded by the round-up, because
     * minted ≤ amt·t/res on both sides by construction of the min, so
     * ceil(minted·res/t) ≤ amt for integers.
     */
    function addLiquidity(uint256 wbtcIn, uint256 ptpIn, uint256 minShares, address to)
        external
        lock
        returns (uint256 minted, uint256 usedWbtc, uint256 usedPtp)
    {
        require(to != address(0), "PTP-POOL: recipient is the zero address");
        require(wbtcIn > 0 && ptpIn > 0, "PTP-POOL: both amounts must be positive");

        uint256 t = totalShares;
        if (t == 0) {
            uint256 s0 = _sqrt(wbtcIn * ptpIn);
            // Strictly greater: the first depositor must end up holding at
            // least one share, or the pool would open belonging to nobody.
            require(s0 > MINIMUM_LIQUIDITY, "PTP-POOL: first deposit too small");
            usedWbtc = wbtcIn;
            usedPtp = ptpIn;
            minted = s0 - MINIMUM_LIQUIDITY;
            require(minted >= minShares, "PTP-POOL: fewer shares than your minimum");
            // Effects first, in full, before either token moves.
            sharesOf[address(0)] = MINIMUM_LIQUIDITY;
            sharesOf[to] += minted;
            totalShares = s0;
        } else {
            uint256 byWbtc = (wbtcIn * t) / reserveWbtc;
            uint256 byPtp = (ptpIn * t) / reservePtp;
            minted = byWbtc < byPtp ? byWbtc : byPtp;
            require(minted > 0, "PTP-POOL: deposit too small to mint a share");
            require(minted >= minShares, "PTP-POOL: fewer shares than your minimum");
            usedWbtc = _ceilDiv(minted * reserveWbtc, t);
            usedPtp = _ceilDiv(minted * reservePtp, t);
            sharesOf[to] += minted;
            totalShares = t + minted;
        }

        reserveWbtc += usedWbtc;
        reservePtp += usedPtp;

        // Interactions last. Both legs are pulled from the caller, never from
        // `to`: you can deposit on someone else's behalf, you can never deposit
        // someone else's coins.
        _pull(wbtc, usedWbtc);
        _pull(ptp, usedPtp);

        emit LiquidityAdded(msg.sender, to, usedWbtc, usedPtp, minted);
    }

    /**
     * Burn shares, receive the proportional slice of both reserves, rounded
     * down in the pool's favour.
     *
     * `minWbtc` and `minPtp` are the withdrawal-side guard. Your slice is
     * proportional whatever happens, but a swap landing ahead of you changes
     * what that slice is MADE OF — more of the side someone just sold in, less
     * of the side they bought out — so a withdrawal aimed at a particular coin
     * can be sandwiched into the other one. Say what you will accept on each
     * side; zero on a side means no guard there.
     *
     * totalShares cannot reach zero because MINIMUM_LIQUIDITY sits at an address
     * that cannot call, so the divisions here cannot divide by zero however much
     * liquidity leaves.
     */
    function removeLiquidity(uint256 shares, uint256 minWbtc, uint256 minPtp, address to)
        external
        lock
        returns (uint256 wbtcOut, uint256 ptpOut)
    {
        require(to != address(0), "PTP-POOL: recipient is the zero address");
        require(shares > 0, "PTP-POOL: shares must be positive");
        uint256 held = sharesOf[msg.sender];
        require(held >= shares, "PTP-POOL: more shares than you hold");

        uint256 t = totalShares;
        wbtcOut = (shares * reserveWbtc) / t;
        ptpOut = (shares * reservePtp) / t;
        require(wbtcOut >= minWbtc && ptpOut >= minPtp, "PTP-POOL: below your minimum, the pool moved");

        // Effects first.
        unchecked {
            sharesOf[msg.sender] = held - shares;
        }
        totalShares = t - shares;
        reserveWbtc -= wbtcOut;
        reservePtp -= ptpOut;

        // Interactions last.
        _push(wbtc, to, wbtcOut);
        _push(ptp, to, ptpOut);

        emit LiquidityRemoved(msg.sender, to, wbtcOut, ptpOut, shares);
    }

    // ── Swap ────────────────────────────────────────────────────────────────

    /**
     * Trade one side for the other at the constant-product price.
     *
     * `sellPtp` names the direction: true sells PTP for wBTC, false sells wBTC
     * for PTP. `amountIn` is in the raw units of whichever side is being sold.
     * The output goes to `to`; the input is always pulled from msg.sender, so a
     * caller can route a fill to another address but never spend another
     * address's coins.
     *
     * `minOut` IS THE POINT OF THIS FUNCTION. Rule: a fill at a price the
     * screen never showed is refused, not executed. The contract has no oracle
     * and wants none — the only price it knows is its own reserves, and those
     * reserves can be moved by anybody who lands a transaction ahead of yours.
     * Naming the worst output you will accept turns that from a surprise into a
     * revert. Passing zero opts out of the protection knowingly; the contract
     * cannot tell a deliberate zero from a careless one and does not guess.
     *
     * WHAT minOut DOES NOT COVER, since this signature has no deadline
     * parameter and the predecessor's did: a signed transaction can sit in a
     * mempool, or in a builder's pocket, and land hours later. minOut says "not
     * at a worse price than this"; it says nothing about WHEN. A trade held back
     * and included much later still executes if the price happens to be inside
     * the bound, at a moment the caller may no longer have wanted to trade at
     * all. Callers who care should keep their own nonce discipline, or resubmit
     * with a tighter bound.
     *
     * The output is strictly less than the output reserve by construction — the
     * fraction is always below one — so a swap can thin a reserve but can never
     * empty it, and there is no trade size that leaves the pool at zero.
     */
    function swap(bool sellPtp, uint256 amountIn, uint256 minOut, address to)
        external
        lock
        returns (uint256 out)
    {
        require(to != address(0), "PTP-POOL: recipient is the zero address");
        require(amountIn > 0, "PTP-POOL: amount in must be positive");

        (uint256 reserveIn, uint256 reserveOut) =
            sellPtp ? (reservePtp, reserveWbtc) : (reserveWbtc, reservePtp);
        out = amountOut(amountIn, reserveIn, reserveOut, feeBps);
        require(out > 0, "PTP-POOL: trade too small to buy anything");
        require(out >= minOut, "PTP-POOL: below your minimum, the price moved");

        // Effects: the fee stays in, so k strictly grows and that growth is the
        // shareholders' pay. There is no fee balance anywhere in this contract
        // because the fee never leaves the reserve in the first place.
        address tokenIn;
        address tokenOut;
        if (sellPtp) {
            reservePtp += amountIn;
            reserveWbtc -= out;
            tokenIn = ptp;
            tokenOut = wbtc;
        } else {
            reserveWbtc += amountIn;
            reservePtp -= out;
            tokenIn = wbtc;
            tokenOut = ptp;
        }

        // Interactions last, both of them, after every storage write above.
        _pull(tokenIn, amountIn);
        _push(tokenOut, to, out);

        emit Swapped(msg.sender, to, sellPtp, amountIn, out);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    function _pull(address token, uint256 amount) internal {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "PTP-POOL: transfer in failed");
    }

    function _push(address token, address to, uint256 amount) internal {
        require(IERC20(token).transfer(to, amount), "PTP-POOL: transfer out failed");
    }

    /// Babylonian integer square root, rounding down — UniswapV2's own.
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// a/b rounded up; the zero case is spelled out so a == 0 cannot underflow.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
