// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * PtpAnchor — where a picture's structure outlives its bytes, and where the
 * epoch chain gets an outside witness.
 *
 * Two jobs, both of them the same job seen from different distances.
 *
 * PER POST. A picture is published, lives for the days it paid for, lapses, and
 * settles. At settlement the bytes are deleted from every node (ARCHITECTURE.md
 * section 6). What is left behind here is the residue: who published, how many
 * bytes it was, what shape it was, how long it lived, and a single tombstone
 * word committing to everything the epoch computed about it. The picture is
 * gone; the fact of it is not.
 *
 * PER EPOCH. One triple of merkle roots per closed epoch, posted by the epoch
 * producer. server/chain/ already seals a signed, hash-linked block per epoch,
 * and that chain makes a silent rewrite DETECTABLE by anyone holding an older
 * copy — but "anyone holding an older copy" is the catch. A producer who
 * rewrote history and reissued every block from the fork point would hand a
 * self-consistent chain to a reader who was not watching at the time, and
 * nothing inside the chain could tell that reader which version existed first.
 * A root written here is timestamped in a place its poster cannot reach back
 * into, which is the one fact replay cannot reconstruct on its own: WHEN a
 * commitment was made.
 *
 * ── WHAT THIS CONTRACT DOES NOT SAY ────────────────────────────────────────
 * A contract that overstates itself is worse than no contract. This one does
 * not say a post's earnings were computed honestly, that a root is correct,
 * that the producer is anybody in particular, or that a picture ever existed at
 * all — only that these words were committed to at that block by that address.
 * Truth stays where core/replay.mjs puts it: in replay of the public log, by
 * anyone who disagrees. This is a mirror with a clock in it.
 *
 * ── STRUCTURE SURVIVES, PAYLOAD IS MERELY RETAINED ─────────────────────────
 * Section 6 commits each act twice: a STRUCTURAL hash over the act minus its
 * payload fields, invariant under every lawful deletion, and a PAYLOAD hash
 * sealed at close and afterwards simply kept — the retained commitment residue.
 * The distinction is what makes deletion scoring-neutral, and it is enforced
 * here in storage rather than only described:
 *
 *   - `tombstone` is the STRUCTURAL commitment. It is written at settlement and
 *     stays in storage forever, because every later reader — an indexer, a
 *     verifier, a stranger checking one creator's earnings — needs it live. It
 *     survives because nothing lawful can change what it commits to: the author,
 *     the lifetime, the counts and the euros are all facts about the record, and
 *     the record is append-only.
 *
 *   - `cid`, `bytesLen`, `w` and `h` are the PAYLOAD commitment and its shape.
 *     They are CLEARED from storage at settlement and carried out in the
 *     `Settled` event instead. That is the difference between surviving and
 *     being retained: they remain provable forever from the log, and they stop
 *     being live state that anything is expected to read. A payload commitment
 *     whose payload has been deleted has no consumer left — keeping it in a
 *     storage slot would be paying rent on a fact nobody can act on.
 *
 * The `Settled` event carries the FULL metadata for exactly this reason: an
 * indexer building the permanent record needs no storage read, because by the
 * time it could make one, half the fields are deliberately zero.
 *
 * ── ONE WRITE, NO REVISIONS ────────────────────────────────────────────────
 * A postId can be published once. An epoch can be rooted once. A second attempt
 * REVERTS — it does not overwrite and it does not quietly no-op. The entire
 * value of the record is that it cannot be revised after the fact, and a
 * contract that let a poster swap yesterday's commitment for today's would be
 * an expensive way to store a mutable variable while implying otherwise. There
 * is no repair path here by design; the honest repair for a wrong word is to
 * say plainly that it was wrong. The mistake stays visible, which is the point.
 *
 * A permanent first write is only safe if it is bound to the one person
 * entitled to make it. Every first write in this file now is: `publish` derives
 * its id from the caller (see below), and `settle` and `epochRoot` are the
 * producer's. A permanent write that anybody can race for is not a record, it
 * is a land grab with a nice name.
 *
 * ── THE ROOTS ARE CHECKABLE HERE, NOT ONLY OFF-CHAIN ───────────────────────
 * `verifyProof` reproduces core/merkle.mjs exactly, so a member can prove one
 * act, one payload commitment or one tombstone was inside a sealed root without
 * holding the set. core/merkle.mjs is the NORMATIVE copy of that construction;
 * this file follows it and must be changed only when it changes.
 *
 * No imports, no upgrade path, no pause. The only privileged role is `producer`,
 * and its powers are enumerated at that variable.
 */
contract PtpAnchor {
    /// A post that has never been published.
    uint8 public constant STATE_NONE = 0;
    /// Published and not yet settled. Extendable by its author.
    uint8 public constant STATE_LIVE = 1;
    /// Settled: payload fields cleared, tombstone written, nothing left to do.
    uint8 public constant STATE_SETTLED = 2;

    /**
     * The first epoch this chain seals, because it is the first epoch the
     * network numbers.
     *
     * This is not a choice made here. ARCHITECTURE.md section 5 starts a
     * replayed World at `epoch: { n }` counting from zero, PtpRules' genesis
     * entry governs from epoch 0, and `currentEpoch()` below already answers 0
     * before anything is sealed — three places that would contradict each other
     * if the anchor's first seal named anything else. Writing the number down as
     * a constant is what lets `epochRoot` bind the very first seal to it instead
     * of accepting whichever number happens to arrive first. See `epochRoot` for
     * the defect that binding closes.
     */
    uint256 public constant GENESIS_EPOCH = 0;

    /**
     * Declared in this order because Solidity packs in declaration order and
     * this order fills whole words:
     *
     *   slot 0   author 160 + expires 64 + w 32          = 256 bits, exactly
     *   slot 1   publishedAt 64 + bytesLen 64 + h 32 + state 8
     *   slot 2   cid
     *   slot 3   tombstone
     *
     * A live post costs four slots. A settled one keeps two words of real
     * content (slot 0's author, slot 1's timings and state, the tombstone) and
     * gives slot 2 back to the chain. Storage discipline is not thrift for its
     * own sake here — the cleared fields are precisely the payload-ish ones, so
     * the layout and the deletion policy are the same decision written twice.
     */
    struct Post {
        /// Who published it. Never cleared: authorship is structural.
        address author;
        /// Unix seconds after which the post has lapsed and may be settled.
        uint64 expires;
        /// Pixel width. Payload shape — cleared at settlement.
        uint32 w;
        /// The chain's timestamp at publish, never the caller's. A
        /// caller-supplied time is a number the caller can lie about, which is
        /// the exact thing an anchor exists to remove. Doubles as nothing: the
        /// presence flag is `state`, because a post published in the same
        /// second as the genesis block would otherwise read as absent.
        uint64 publishedAt;
        /// Byte length of the picture. Payload shape — cleared at settlement.
        uint64 bytesLen;
        /// Pixel height. Payload shape — cleared at settlement.
        uint32 h;
        /// STATE_NONE / STATE_LIVE / STATE_SETTLED.
        uint8 state;
        /// sha256 of the picture's bytes: the payload commitment. Cleared at
        /// settlement and preserved in the Settled event. See the header.
        bytes32 cid;
        /// The structural commitment, written once at settlement: the epoch's
        /// hash over the post's whole settled record — views, unique viewers,
        /// likes, comments, gross nanoeuros, PTP paid. Never cleared.
        bytes32 tombstone;
    }

    /// One triple of roots per closed epoch, exactly as ARCHITECTURE.md
    /// section 9 seals them.
    struct EpochRoot {
        bytes32 actsRoot;
        bytes32 payloadsRoot;
        bytes32 stateRoot;
        /// Chain time at posting. Doubles as the presence flag: at == 0 means
        /// this epoch has no root, and a caller that skips the check will
        /// happily believe in three zero roots nobody ever posted.
        uint64 at;
    }

    /**
     * The one privileged address. Enumerated rather than smuggled past a reader
     * in a modifier.
     *
     * The producer CAN
     *   - post one root triple per epoch, once, and never revise it;
     *   - write one tombstone per lapsed post, once, and never revise it;
     *   - hand the office to another address (see rotateProducer).
     *
     * The producer CANNOT
     *   - mint, move, freeze or burn any balance. This contract has no token
     *     reference, holds no coins, and has no payable function;
     *   - publish or extend a post. Those are the author's, always;
     *   - settle a post before it has lapsed, or root an epoch twice;
     *   - delete or alter anything already written, including its own writes.
     *
     * WHY IT IS NOT OPEN TO EVERYONE. PeerAnchor in the predecessor let anybody
     * anchor, because it keyed rows by (poster, epoch) so an impostor's garbage
     * sat under the impostor's own address next to nothing. That trick does not
     * work here: a postId is global, and a tombstone is one word for one post —
     * so an open `settle` would be first-come, and the first stranger to see a
     * post lapse could write a permanent, unrevisable lie about it. Narrowing
     * the writer to the elected office is the smaller harm, and the office's
     * authority is confined to writing 32 bytes of residue about a record that
     * is public anyway.
     *
     * That argument is the reason `publish` derives its own id rather than
     * accepting one: an id keyed by nothing is exactly the same first-come race,
     * one function earlier. See `publish`.
     *
     * The honest failure mode: if the producer key is lost, nothing further is
     * anchored. Posts still settle, earnings are still paid, the log still
     * replays — because the act log is the truth and this contract is a mirror.
     * What stops is the mirror, and that is a degradation rather than a loss.
     */
    address public producer;

    /// The highest epoch number that has a root, and whether any does. Together
    /// with GENESIS_EPOCH they let PtpRules compute the current epoch without a
    /// clock — see `currentEpoch` and `_nextEpoch` below. Because the first seal
    /// is pinned to GENESIS_EPOCH and every later one is exactly one higher,
    /// `highestEpoch` is the count of sealed epochs minus one and nothing else:
    /// it is a tally, not a number a caller gets to choose.
    uint256 public highestEpoch;
    bool public anySealed;

    mapping(bytes32 => Post) private posts;
    mapping(uint256 => EpochRoot) private roots;

    /// Carries `nonce` last so the event is self-verifying: a reader with the
    /// log alone holds author, cid and nonce, can recompute `postIdFor` and
    /// check it against the indexed topic, and therefore never has to take this
    /// contract's word for the binding between an id and its author.
    event Published(
        bytes32 indexed postId,
        address indexed author,
        bytes32 cid,
        uint64 bytesLen,
        uint32 w,
        uint32 h,
        uint64 expires,
        uint64 at,
        uint256 nonce
    );
    event Extended(bytes32 indexed postId, address indexed author, uint64 oldExpires, uint64 newExpires);
    /// Carries the full metadata on purpose: after this event the payload
    /// fields are zero in storage, so an indexer that missed the log cannot
    /// reconstruct them from a call. This event IS the permanent record.
    event Settled(
        bytes32 indexed postId,
        address indexed author,
        bytes32 cid,
        uint64 bytesLen,
        uint32 w,
        uint32 h,
        uint64 publishedAt,
        uint64 expires,
        bytes32 tombstone,
        uint64 at
    );
    event EpochRooted(
        uint256 indexed epoch, bytes32 actsRoot, bytes32 payloadsRoot, bytes32 stateRoot, uint64 at
    );
    event ProducerRotated(address indexed from, address indexed to);

    constructor(address producer_) {
        require(producer_ != address(0), "PTP-ANCHOR: producer is the zero address");
        // The one place the copied EMPTY_ROOT digest is checked against its own
        // preimage. Paid once, at deployment, so the copy can never be quietly
        // wrong; see the constant.
        require(EMPTY_ROOT == emptyRoot(), "PTP-ANCHOR: EMPTY_ROOT does not match its preimage");
        producer = producer_;
    }

    modifier onlyProducer() {
        require(msg.sender == producer, "PTP-ANCHOR: only the producer");
        _;
    }

    // ── Posts ───────────────────────────────────────────────────────────────

    /**
     * The postId of a picture, derived rather than chosen. Pure, so a client
     * computes the id it is about to create before sending anything, and an
     * indexer recomputes it from the `Published` event's own fields.
     *
     * `abi.encode` rather than `abi.encodePacked`: all three arguments are
     * fixed-width here so both are injective, but `encode` stays injective if
     * anybody ever adds a dynamic field, and an id scheme is not a place to
     * leave that trap lying for the next reader.
     *
     * keccak256 here, sha256 in the merkle section below, and the difference is
     * on purpose. A merkle digest has to be recomputable by three readers that
     * share no dependencies, so it is sha256. A postId never has to be
     * recomputed by anybody who did not want to create one: it arrives in the
     * indexed topic of `Published` and is read, not derived. So it uses the
     * hash this machine is cheapest at. The cost of that choice is written down
     * in contracts/README.md rather than left for a reader to discover.
     */
    function postIdFor(address author, bytes32 cid, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(author, cid, nonce));
    }

    /**
     * Anchor a picture at publish time. msg.sender becomes the author, forever,
     * under an id that contains msg.sender.
     *
     * ── THE DEFECT THIS SHAPE EXISTS TO PREVENT ────────────────────────────
     * This function used to take `postId` as a caller-supplied argument and then
     * write `p.author = msg.sender`, with no relationship of any kind between
     * the two. Since the first write to an id is permanent and unrevisable, a
     * watcher who saw an author's transaction in the mempool could copy the
     * postId, pay more gas, land first, and own that record forever — the real
     * author's transaction then reverted on "already anchored" and there was no
     * repair path, by design. The contract's own argument for locking down
     * settle() applies verbatim: "a postId is global, and a tombstone is one
     * word for one post — so an open `settle` would be first-come, and the first
     * stranger to see a post lapse could write a permanent, unrevisable lie
     * about it." An unbound postId made `publish` first-come in precisely that
     * sense, one function earlier in the lifecycle.
     *
     * So the id is not an argument any more. It is
     * keccak256(abi.encode(msg.sender, cid, nonce)): the author is inside the
     * preimage, and a front-runner replaying the same calldata derives the id
     * under THEIR address, which is a different id and collides with nothing.
     * Stealing an id now costs a preimage attack on keccak256 rather than a gas
     * bid. Do not reintroduce a postId parameter; if the act log needs to name
     * this row, it stores what `postIdFor` returns.
     *
     * `nonce` is the author's own counter, and it is what lets one author anchor
     * the same `cid` more than once — republishing an identical picture is a
     * legitimate act, and an id of (author, cid) alone would make the second one
     * impossible. Reusing a nonce with the same cid reverts, which is the same
     * one-write rule as before, now scoped to the author it belongs to.
     *
     * The id is still not validated against the act log, because this contract
     * has no idea what a post is and refuses to pretend. What changed is not
     * that the id became meaningful; it is that it became unforgeable.
     *
     * Zero words and zero dimensions are refused. Not because a zero cid would
     * be dangerous but because it is not a hash anybody can produce: a zero word
     * means the caller's encoder dropped an argument, and since the record is
     * permanent, reverting on an obviously-empty argument is worth far more than
     * accepting it.
     *
     * `expires` must be in the future. Anchoring a post that has already lapsed
     * would create a row that is settleable in the same block it was published,
     * which is not a lifecycle, it is a typo.
     */
    function publish(bytes32 cid, uint64 bytesLen, uint32 w, uint32 h, uint64 expires, uint256 nonce)
        external
        returns (bytes32 postId)
    {
        require(cid != bytes32(0), "PTP-ANCHOR: cid is zero");
        require(bytesLen > 0, "PTP-ANCHOR: bytesLen is zero");
        require(w > 0 && h > 0, "PTP-ANCHOR: dimensions are zero");
        require(expires > block.timestamp, "PTP-ANCHOR: expires is not in the future");

        postId = postIdFor(msg.sender, cid, nonce);

        Post storage p = posts[postId];
        require(p.state == STATE_NONE, "PTP-ANCHOR: you already anchored that cid under that nonce");

        uint64 at = uint64(block.timestamp);
        p.author = msg.sender;
        p.expires = expires;
        p.w = w;
        p.publishedAt = at;
        p.bytesLen = bytesLen;
        p.h = h;
        p.state = STATE_LIVE;
        p.cid = cid;

        emit Published(postId, msg.sender, cid, bytesLen, w, h, expires, at, nonce);
    }

    /**
     * Buy the post more time. Author only, live posts only, and `newExpires`
     * must be strictly greater than the one it replaces.
     *
     * Strictly greater, rather than merely different, because an extension that
     * could shorten a lifetime would let an author retroactively lapse a post
     * that is still earning — and lapsing is what makes it settleable, which is
     * what deletes the picture. One direction only, so `expires` is monotone
     * for the whole life of the row and a reader can compare two observations of
     * it without wondering which came first.
     *
     * Whether the rent was actually paid is not this contract's business and it
     * does not pretend otherwise: payment happens in PTP against the act log,
     * and an extension anchored without payment is an author committing to a
     * date that replay will not honour.
     */
    function extend(bytes32 postId, uint64 newExpires) external {
        Post storage p = posts[postId];
        require(p.state == STATE_LIVE, "PTP-ANCHOR: post is not live");
        require(msg.sender == p.author, "PTP-ANCHOR: only the author may extend");
        uint64 old = p.expires;
        require(newExpires > old, "PTP-ANCHOR: an extension must move expiry forward");
        p.expires = newExpires;
        emit Extended(postId, p.author, old, newExpires);
    }

    /**
     * Write the metadata residue AFTER the picture has been deleted off-chain.
     *
     * Order matters and is stated as a requirement rather than a hope: this call
     * belongs at the END of settlement, once earnings are paid and the bytes are
     * gone from every node. Anchoring first and deleting later would leave a
     * window in which the chain says a picture is settled while nodes are still
     * serving it, and the tombstone is supposed to be a description of a
     * completed deletion, not an intention to perform one.
     *
     * Only after the post has lapsed. `block.timestamp >= expires` is the whole
     * of the timing rule here; the settlement grace period from
     * ARCHITECTURE.md section 6 lives in replay, where it belongs, because it is
     * measured against acts and not against this chain's clock.
     *
     * What happens to storage, and why, is the header's whole argument: the
     * payload commitment and the payload's shape are cleared, the structural
     * commitment is written and kept. The event above carries everything, so
     * clearing loses nobody anything they could not still prove.
     */
    function settle(bytes32 postId, bytes32 tombstone) external onlyProducer {
        require(tombstone != bytes32(0), "PTP-ANCHOR: tombstone is zero");
        Post storage p = posts[postId];
        require(p.state == STATE_LIVE, "PTP-ANCHOR: post is not live");
        require(block.timestamp >= p.expires, "PTP-ANCHOR: post has not lapsed yet");

        // Read the payload fields out before they are cleared; the event is the
        // only place they will exist after this transaction.
        bytes32 cid = p.cid;
        uint64 bytesLen = p.bytesLen;
        uint32 w = p.w;
        uint32 h = p.h;
        uint64 publishedAt = p.publishedAt;
        uint64 expires = p.expires;

        // Structure kept.
        p.state = STATE_SETTLED;
        p.tombstone = tombstone;

        // Payload cleared. Redaction takes the payload and leaves the structure.
        p.cid = bytes32(0);
        p.bytesLen = 0;
        p.w = 0;
        p.h = 0;

        emit Settled(
            postId, p.author, cid, bytesLen, w, h, publishedAt, expires, tombstone, uint64(block.timestamp)
        );
    }

    /**
     * NINE static words, in this order and no other:
     *
     *   word 0  author        address, right-aligned in the low 20 bytes
     *   word 1  cid           bytes32   (zero once settled)
     *   word 2  bytesLen      uint64    (zero once settled)
     *   word 3  w             uint32    (zero once settled)
     *   word 4  h             uint32    (zero once settled)
     *   word 5  publishedAt   uint64
     *   word 6  expires       uint64
     *   word 7  state         uint8
     *   word 8  tombstone     bytes32   (zero until settled)
     *
     * so a reader with curl and no ABI library can decode by cutting the hex
     * into 32-byte slices. Anything added later goes on the END, so hardcoded
     * offsets keep pointing at the same fields.
     *
     * `state` is the emptiness test, not `author` and not `cid`: a settled post
     * has a zero cid on purpose, and a never-published one has a zero author.
     */
    function postOf(bytes32 postId)
        external
        view
        returns (
            address author,
            bytes32 cid,
            uint64 bytesLen,
            uint32 w,
            uint32 h,
            uint64 publishedAt,
            uint64 expires,
            uint8 state,
            bytes32 tombstone
        )
    {
        Post storage p = posts[postId];
        return (p.author, p.cid, p.bytesLen, p.w, p.h, p.publishedAt, p.expires, p.state, p.tombstone);
    }

    // ── Epochs ──────────────────────────────────────────────────────────────

    /**
     * Commit one closed epoch's three merkle roots. Producer only, once per
     * epoch, immutable once set.
     *
     * The three are the three ARCHITECTURE.md section 9 seals into the block:
     * `actsRoot` over the structural hash of every act in the range,
     * `payloadsRoot` over the payload commitment of every act, and `stateRoot`
     * over the epoch's full economic state. Posting all three together is what
     * makes the pair "these acts, this state" checkable — a stranger can replay
     * the published log, rebuild all three, and either match bits or attribute
     * the difference. There is no third outcome.
     *
     * All three must be non-zero, and an epoch that produced nothing still has
     * three real roots to post. core/merkle.mjs answers an empty list through
     * `rootOf`, which returns `EMPTY_ROOT` — sha256(0x02 ‖ "ptp/merkle/empty"),
     * mirrored as the constant of that name in the merkle section below. That is
     * a THIRD domain: unreachable as a leaf (0x00) and unreachable as an
     * interior node (0x01), so an epoch that committed nothing is distinguishable
     * from one whose acts were withheld, and it is a sha256 digest, so it is not
     * zero and passes the checks above unchanged. `buildTree` itself still
     * refuses an empty list, which is what keeps the sentinel out of proof
     * checking — nothing verifies as a member of an empty epoch. So a quiet day
     * seals like any other day and the `+ 1` rule below never stalls on one. A
     * zero word here still means only one thing: the caller's encoder dropped an
     * argument.
     *
     * This contract cannot check that an empty epoch used EMPTY_ROOT, because it
     * cannot see the act range. It can only refuse the zero word and let a
     * replaying stranger compare the rest.
     *
     * The epoch number is not validated against a clock, because this contract
     * has none. It is validated against the record's own shape, and the shape is
     * total: the first seal must name GENESIS_EPOCH, and every seal after it
     * must name EXACTLY one more than the last. `_nextEpoch()` is that rule as a
     * single expression, and `currentEpoch()` publishes the same expression — so
     * the number this function will accept next and the number PtpRules reads as
     * current are the same number by construction, not by agreement between two
     * places that could drift.
     *
     * ── THE DEFECT THIS BOUND EXISTS TO PREVENT ────────────────────────────
     * `epoch` used to be entirely unbounded, and `highestEpoch` simply took any
     * larger number handed to it. One transaction rooting type(uint256).max
     * therefore set the horizon to the ceiling of the type, and `currentEpoch()`
     * — which computes `highestEpoch + 1` under 0.8.x checked arithmetic —
     * reverted from that moment on, for every caller, forever.
     *
     * The round that closed that added `epoch < type(uint256).max` and
     * `!anySealed || epoch == highestEpoch + 1`, and left the harm standing one
     * step to the side: the FIRST seal was still free to name anything below the
     * ceiling. A genesis seal at type(uint256).max − 1 set the horizon there, so
     * `currentEpoch()` returned exactly type(uint256).max — no overflow, no
     * revert, and `PtpRules.setRules` requires a `fromEpoch` STRICTLY GREATER
     * than what this returns. No uint256 satisfies that. One transaction from a
     * key whose enumerated powers are "write 32 bytes of residue" permanently
     * disabled the network's ability to schedule any future distribution module.
     * Removing the revert had removed the symptom and kept the harm.
     *
     * Both halves are closed here, and neither may be softened:
     *
     *   - `epoch == _nextEpoch()` pins the genesis seal to GENESIS_EPOCH and
     *     every later seal to one past the last, so `highestEpoch` is the tally
     *     of sealed epochs. Reaching any number a caller could weaponise now
     *     costs that many transactions, one per block, which is the difference
     *     between a typo and a geological era. PtpRules is additionally built so
     *     that no value this clock could return can lock `setRules` out at all;
     *     see the ceiling clause there. Two independent closures, because this
     *     one is the one an operator can inspect and that one is the one that
     *     holds even if this contract is not the clock PtpRules was wired to.
     *
     *   - `epoch < type(uint256).max` is what keeps `highestEpoch <
     *     type(uint256).max` an invariant of storage rather than a claim about
     *     how many transactions the world has time for, and that invariant is
     *     why `_nextEpoch()`'s addition is total. It cannot fire in practice —
     *     getting there needs 2^256 seals — and it stays because a view every
     *     caller must handle is exactly what PtpRules' callers cannot handle.
     *
     * WHY A GAP IS REFUSED RATHER THAN TOLERATED. A gap is not a harmless hole
     * in a list. The horizon is what PtpRules means by "sealed", so skipping
     * from epoch 10 to epoch 900 silently declares 889 epochs sealed that were
     * never rooted, and every one of them becomes an epoch whose roots can never
     * now be posted — the `+ 1` rule refuses them afterwards just as firmly. A
     * gap is therefore an irreversible retroactive claim about epochs the
     * producer never actually computed. Pinning the genesis seal closes the last
     * and largest place a gap could still be opened: an unbound first seal at
     * epoch 900 is a gap of 900 epochs, declared in one transaction, before
     * anybody has anything to compare it against.
     *
     * The honest cost, twice over. The producer cannot back-fill: if epoch 11's
     * roots are never posted, epoch 12's never can be either, and the anchor
     * stops there until the missing block is sealed. And an anchor deployed
     * after the network has already run must catch up one seal per closed epoch,
     * oldest first, rather than starting at today's number — which is the same
     * statement seen from the other end, because "starting at today's number" is
     * precisely the claim that every epoch before today was sealed here when
     * none of them was. Both fail loudly and recoverably rather than quietly and
     * permanently.
     */
    function epochRoot(uint256 epoch, bytes32 actsRoot, bytes32 payloadsRoot, bytes32 stateRoot)
        external
        onlyProducer
    {
        require(actsRoot != bytes32(0), "PTP-ANCHOR: actsRoot is zero");
        require(payloadsRoot != bytes32(0), "PTP-ANCHOR: payloadsRoot is zero");
        require(stateRoot != bytes32(0), "PTP-ANCHOR: stateRoot is zero");

        // The whole ordering rule, against the same expression currentEpoch()
        // publishes. It covers the first seal and every later one with no
        // "unless" in it, which is what the previous shape's `!anySealed ||`
        // left open.
        require(epoch == _nextEpoch(), "PTP-ANCHOR: an epoch seals only as the next one after the last");

        // Maintains highestEpoch < type(uint256).max, which is what makes the
        // addition in _nextEpoch() total. Unreachable: getting here needs 2^256
        // seals. See the header for why an unreachable guard is kept.
        require(epoch < type(uint256).max, "PTP-ANCHOR: epoch is the uint256 ceiling");

        // Also unreachable now — the equality above already refuses any epoch at
        // or below the horizon — and kept because "one write, no revisions" is a
        // property of this mapping and should be enforced at the mapping, not
        // inferred from an ordering rule somewhere above it.
        EpochRoot storage r = roots[epoch];
        require(r.at == 0, "PTP-ANCHOR: epoch already rooted");

        uint64 at = uint64(block.timestamp);
        roots[epoch] = EpochRoot({
            actsRoot: actsRoot,
            payloadsRoot: payloadsRoot,
            stateRoot: stateRoot,
            at: at
        });

        // Unconditional, because the require above already establishes that this
        // epoch is the next one: there is no longer a case where a seal lands at
        // or below the horizon and has to be ignored. The horizon starts at
        // GENESIS_EPOCH and advances by exactly one per transaction, never
        // further and never from anywhere else.
        highestEpoch = epoch;
        anySealed = true;

        emit EpochRooted(epoch, actsRoot, payloadsRoot, stateRoot, at);
    }

    /**
     * FOUR static words: actsRoot, payloadsRoot, stateRoot, at. An epoch that
     * was never rooted reads back as four zeros — a plain mapping read, not an
     * invention — and `at == 0` is the emptiness test.
     */
    function rootOf(uint256 epoch)
        external
        view
        returns (bytes32 actsRoot, bytes32 payloadsRoot, bytes32 stateRoot, uint64 at)
    {
        EpochRoot storage r = roots[epoch];
        return (r.actsRoot, r.payloadsRoot, r.stateRoot, r.at);
    }

    /**
     * The epoch this chain believes is currently open: one past the highest
     * sealed one, or GENESIS_EPOCH before anything has been sealed.
     *
     * It is the same expression `epochRoot` checks its argument against, so this
     * number is simultaneously "the epoch being accumulated" and "the epoch the
     * next seal must name". Since the first seal is pinned to GENESIS_EPOCH and
     * each later one adds exactly one, it is also just the COUNT of sealed
     * epochs — a tally that advances one per transaction and cannot be jumped.
     *
     * This is the closest thing to a clock anywhere in these four contracts, and
     * it is deliberately made of sealed facts rather than of `block.timestamp`.
     * PtpRules uses it to enforce "never retroactive": a rule change must name an
     * epoch strictly greater than this, so it can never reach an epoch whose
     * roots are already committed, nor the one being computed right now.
     *
     * Its limit, stated plainly because PtpRules' guarantee is only as strong as
     * this line: IT LAGS, and it lags by an amount nothing on chain can measure.
     * If the producer has not yet rooted a closed epoch, this reads low — the
     * network can be at epoch 50 while this returns 11 — and a rule change can
     * therefore be scheduled for an epoch that already closed off-chain. What
     * this supports is exactly "no SEALED epoch is ever re-cut", which is what a
     * stranger can check. It does not support "no CLOSED epoch is ever re-cut",
     * and PtpRules must not be read as if it did. That stronger statement is
     * enforced in core/replay.mjs — see RULES_EPOCH_PAST in core/errors.mjs —
     * where the world state knows the true epoch number and this contract does
     * not.
     *
     * This addition cannot overflow, and that is a property of `epochRoot`
     * rather than of this line: nothing can ever be sealed at
     * type(uint256).max, so `highestEpoch` is at most type(uint256).max − 1
     * whenever `anySealed` is true. The bound is enforced at the write because a
     * view that reverts is a view every caller must handle, and PtpRules'
     * callers could not. See epochRoot for the defect this replaced.
     */
    function currentEpoch() external view returns (uint256) {
        return _nextEpoch();
    }

    /// The epoch that is open, which is the epoch the next seal must name. One
    /// private expression with two public consumers — `currentEpoch()` and the
    /// ordering require in `epochRoot` — so the clock PtpRules reads and the
    /// number this chain will accept cannot drift apart.
    function _nextEpoch() private view returns (uint256) {
        return anySealed ? highestEpoch + 1 : GENESIS_EPOCH;
    }

    // ── Merkle ──────────────────────────────────────────────────────────────

    /**
     * The root of an epoch that committed nothing: core/merkle.mjs's
     * `EMPTY_ROOT`, which is what its `rootOf([])` returns.
     *
     *     EMPTY_ROOT = sha256(0x02 ‖ "ptp/merkle/empty")
     *
     * A THIRD domain byte, beside the leaf's 0x00 and the node's 0x01. It is
     * therefore not reachable as a leaf, not reachable as an interior node, and
     * not reachable from any act however chosen — it says "this epoch committed
     * nothing" and nothing else, so an empty epoch is distinguishable from one
     * whose acts were withheld. Being a sha256 output it is non-zero, so it
     * passes `epochRoot`'s three non-zero requires with nothing special done for
     * it.
     *
     * It is also unprovable-in, which is the point of giving absence its own
     * domain rather than reusing one: `verifyProof(leaf, [], EMPTY_ROOT)` would
     * need sha256(0x00 ‖ leaf) to equal sha256(0x02 ‖ …), a cross-domain preimage
     * collision. Nothing is a member of an empty epoch, and no proof can claim
     * otherwise.
     *
     * The literal is a copy of a value computed elsewhere, and a copy nothing
     * checks is a comment. `emptyRoot()` recomputes it from the preimage, and
     * the constructor compares the two, so a drift between this file and
     * core/merkle.mjs shows up as a deployment that reverts rather than as a
     * digest two readers disagree about.
     */
    bytes32 public constant EMPTY_ROOT = 0x22d451b1f6755a740aaebd4ec1bf6ee16bf6a40af2b7aeca865ac0893ff63dbf;

    /// EMPTY_ROOT derived rather than quoted, so the constant above is checkable
    /// without leaving Solidity. `sha256` is a precompile and `pure`, which is
    /// why the value cannot be a compile-time `constant` expression and has to
    /// be written out once and checked once.
    function emptyRoot() public pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x02), "ptp/merkle/empty"));
    }

    /**
     * core/merkle.mjs, in Solidity, bit for bit. THAT FILE IS NORMATIVE; this is
     * the mirror, and if the two ever disagree the JavaScript is right and this
     * is a bug.
     *
     *   content  sha256(canonical bytes of the value)   — computed off-chain
     *   leaf     sha256(0x00 ‖ content)
     *   node     sha256(0x01 ‖ min(a,b) ‖ max(a,b))     over raw 32-byte digests
     *   odd      a node with no partner rises unchanged — needs no code here,
     *            because an unpaired node contributes no sibling to a proof
     *   empty    sha256(0x02 ‖ "ptp/merkle/empty")      — EMPTY_ROOT above, the
     *            root of a list with no leaves; needs no code here either,
     *            because nothing is ever a member of it
     *
     * sha256 and NOT keccak, even though keccak is what this machine hashes
     * cheaply, because the same digest has to be computable by three readers
     * that share no dependencies: the chain builder on node:crypto, the browser
     * on SubtleCrypto, and a verifier with nothing installed. The contract pays
     * a little more gas and the rest of the network pays nothing.
     *
     * THE DOMAIN BYTES ARE LOAD-BEARING AND MUST NOT BE DROPPED. Without them a
     * leaf and an interior node are drawn from the same set, and an adversarial
     * pass measured two consequences on the undomained tree: an interior node
     * presented as a leaf verified TRUE, proving membership of something never
     * committed; and root([a,b,c]) equalled root([H(ab),c]), so the root did not
     * fix the leaf count and two different act lists sealed to one commitment.
     * The usual defence — "a leaf is a hash of printable canonical JSON, so it
     * cannot BE a pair of raw digests" — does not apply here at all, because
     * ARCHITECTURE.md section 9 defines `acts[]` as a list of DIGESTS and the
     * chain builder hands raw digests straight into the leaf domain.
     */
    function verifyProof(bytes32 leaf, bytes32[] calldata proof, bytes32 root) public pure returns (bool) {
        // `leaf` is a CONTENT digest — an entry of the block's acts[] — and is
        // lifted into the leaf domain here, exactly as buildTree lifts it. A
        // caller can therefore never smuggle an interior node in by handing it
        // over pre-hashed.
        bytes32 node = _tagLeaf(leaf);
        for (uint256 i = 0; i < proof.length; ++i) {
            node = _hashPair(node, proof[i]);
        }
        return node == root;
    }

    /**
     * Prove a leaf was inside one of a sealed epoch's three roots.
     *
     * `which` selects: 0 actsRoot, 1 payloadsRoot, 2 stateRoot — the same order
     * the struct, the event and `rootOf` use, so there is one ordering in this
     * file and not two.
     *
     * An epoch with no root answers false rather than reverting, and the check
     * is `at != 0` rather than "is the root non-zero": an unrooted epoch reads
     * back as three zero words, and a caller comparing against those would be
     * asking whether a proof matches a commitment nobody ever made.
     */
    function provenInEpoch(uint256 epoch, uint8 which, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        require(which < 3, "PTP-ANCHOR: no such root");
        EpochRoot storage r = roots[epoch];
        if (r.at == 0) return false;
        bytes32 root = which == 0 ? r.actsRoot : (which == 1 ? r.payloadsRoot : r.stateRoot);
        return verifyProof(leaf, proof, root);
    }

    /// sha256(0x00 ‖ content). The tree's own domain, applied in exactly one
    /// place so it can never drift from the place a tree is built.
    function _tagLeaf(bytes32 content) private pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), content));
    }

    /// sha256(0x01 ‖ min ‖ max). Pair-sorting is the OpenZeppelin convention:
    /// children ordered by value rather than by position means a proof needs
    /// only the sibling digests and never a side-bit. bytes32 compares
    /// big-endian unsigned, which is the same order Buffer.compare gives the
    /// raw digests in core/merkle.mjs.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a <= b
            ? sha256(abi.encodePacked(bytes1(0x01), a, b))
            : sha256(abi.encodePacked(bytes1(0x01), b, a));
    }

    // ── The office ──────────────────────────────────────────────────────────

    /**
     * Hand the producer office to another address. Callable by the producer and
     * by nobody else, so this is a key passing itself along rather than an admin
     * reassigning a role.
     *
     * It exists because the writer in ARCHITECTURE.md section 10 is an elected,
     * ROTATING office, and a contract with a permanently immutable producer
     * would force the network to deploy a new anchor at every handover — which
     * would fragment the very record the anchor exists to make continuous.
     *
     * What rotation does NOT do: it does not grant the new holder anything the
     * old one lacked, does not reopen a written root or tombstone, and does not
     * put a single coin within reach. The office writes 32-byte words about
     * epochs and lapsed posts. That is its whole surface, before and after.
     *
     * There is no two-step accept. A one-step transfer to a mistyped address
     * ends the anchoring, which is a real risk and is listed as such in
     * contracts/README.md; a two-step handshake was rejected because it doubles
     * the state and the failure it prevents is identical to the failure of
     * losing the key, which no handshake prevents either.
     */
    function rotateProducer(address newProducer) external onlyProducer {
        require(newProducer != address(0), "PTP-ANCHOR: producer is the zero address");
        address old = producer;
        producer = newProducer;
        emit ProducerRotated(old, newProducer);
    }
}
