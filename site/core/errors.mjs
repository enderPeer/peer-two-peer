// Every refusal Peer two Peer can hand you, with the mechanism that produced it.
//
// This network bills per impression, prices in euros, destroys bitcoin to let
// anyone in, and deletes pictures on a timer. Almost every refusal here is
// therefore surprising the first time you meet it: a view that is free because
// you looked too soon, a post that cannot be extended because it already
// settled, a burn that is real on the blockchain and still not credited because
// two explorers told the host different stories. A refusal that only says WHAT
// happened leaves the caller guessing at a rule they have never read.
//
// So every entry carries four things:
//
//   code   a stable identifier a bot branches on. Once published it is never
//          renamed — treat it the way you would treat a URL.
//   http   the status a host answers with, so the transport agrees with the body
//   msg    one sentence saying what happened
//   why    the mechanism that produced it — which rule fired, and what it guards
//   next   what the caller should do instead, or an honest "nothing"
//
// `msg` is the only field that may be reworded. `why` never restates `msg`; if
// it does, the entry is a bug. The numbers that make a refusal concrete — the
// balance you had, the seconds left on the cooldown — travel in `detail`, so the
// catalogue itself stays a constant and can be published whole at
// GET /api/v1/errors and cached forever.
//
// The whole catalogue is frozen at module load. Two readers of the one rulebook
// (server and browser) must produce byte-identical refusals for the same act;
// a mutable catalogue is a way for one of them to drift.

/**
 * @typedef {{ code: string, http: number, msg: string, why: string, next: string }} Refusal
 */

/** @type {Record<string, Refusal>} */
const CATALOGUE = {
  // ── Shape and transport ─────────────────────────────────────────────────
  BAD_REQUEST: {
    http: 400,
    msg: 'The act is malformed.',
    why: 'Shape is checked before any arithmetic runs: a missing field, a non-finite number or a value outside its declared range is rejected at the door so that no reserve, price or balance is ever computed from a NaN. Replay is total — an act that does not validate is skipped whole — and that guarantee is only cheap if bad shapes never reach the math.',
    next: 'Compare the act against GET /api/v1, which lists every kind and its fields.',
  },
  UNKNOWN_ACT_KIND: {
    http: 400,
    msg: 'No act of that kind exists in this rulebook.',
    why: 'The kind is dispatched through a closed table in core/replay.mjs. An unknown kind is not ignored and carried in the log, because an act nobody can interpret would hash into the epoch block and force every future verifier to keep a rule that was never written. The table is closed so that the act list and the log are the same list.',
    next: 'Read the kinds from GET /api/v1. A newer host may know a kind this one does not; check the rulebook edition before assuming a typo.',
  },
  ACT_TOO_LARGE: {
    http: 413,
    msg: 'The serialised act exceeds what this host will store.',
    why: 'Every act is appended to a log that every participant, browser included, downloads and replays from the beginning. Size is capped at the act level because the cost of one oversized line is paid forever by everyone, not once by the sender.',
    next: 'Send less in the act itself. Pictures travel as shards addressed by cid, not as fields.',
  },
  PAYLOAD_TOO_LARGE: {
    http: 413,
    msg: 'The uploaded payload exceeds the per-picture limit.',
    why: 'A picture is sharded and replicated onto members\' devices, so its byte length is multiplied by the replication factor before anyone is asked to hold it. The cap is what keeps one upload from consuming a stranger\'s storage grant.',
    next: 'Re-encode smaller. The publish quote shows the MB·days the current size would cost.',
  },
  PARAMS_INVALID: {
    http: 500,
    msg: 'This host is running a constants edition that fails its own invariants.',
    why: 'core/params.mjs asserts every claim its numbers make — that the four splits sum to 10000, that the publish vector is the fee vector renormalised without the creator leg, that a self-dealing loop loses by a margin rather than by a rounding, that emission cannot outrun the burn it is a rebate on — and it throws at import rather than let a bad edit price a network. The code is published here because core/params.mjs names it as one of the three it throws, and a code a module throws but the catalogue does not carry is a refusal a caller cannot branch on.',
    next: 'Nothing from the caller: the arithmetic under this host is inconsistent and every number it would quote is derived from it. Use another host, and report the code — the assertion message names the invariant that failed.',
  },
  BAD_EPOCH: {
    http: 400,
    msg: 'That is not a usable epoch number.',
    why: 'An epoch index counts closes from genesis, so it is a non-negative integer and nothing else. The emission schedule raises 9/10 to the power of the epoch\'s year, and a negative or fractional index has no defined ceiling there — the arithmetic would answer with a number instead of refusing. core/params.mjs throws this code; it is carried here rather than folded into BAD_REQUEST, whose mechanism is a shape check and not an index.',
    next: 'Read the current epoch from GET /api/v1/status or from the chain head, and send that number.',
  },
  RATE_LIMIT: {
    http: 429,
    msg: 'Too many requests from this address.',
    why: 'A transport-level guard in front of the economic one. Fees make spam expensive but they are computed by replay, which is work; this limit stops an attacker from making the host do that work for free.',
    next: 'Slow down and retry. The response header says when.',
  },
  DUPLICATE_ACT: {
    http: 409,
    msg: 'That exact act has already been accepted.',
    why: 'Acts are deduplicated by signature. The same signed body replayed twice would bill twice for one impression and mint two log entries with one intent, so the second copy is refused rather than re-executed.',
    next: 'Nothing — the first copy landed. Read the index back from the log.',
  },
  NOT_THE_WRITER: {
    http: 503,
    msg: 'This host is not the elected writer and does not accept acts.',
    why: 'Writes pass through one writer at a time, an elected rotating office. Two hosts appending would fork the log the moment both were reachable, and there is no merge — acts are ordered, and two orders are two networks.',
    next: 'Nothing: the app follows the address book to the current writer while reads keep working here.',
  },
  NOT_FOUND: {
    http: 404,
    msg: 'No such endpoint or object on this host.',
    why: 'Hosts run different builds of the same rulebook, so a missing endpoint is more often a version difference than a mistake. It is reported as absent rather than answered with an empty object, because an empty object is indistinguishable from a real one that is empty.',
    next: 'GET /api/v1 lists exactly what this host answers.',
  },

  // ── Identity ────────────────────────────────────────────────────────────
  BAD_SIGNATURE: {
    http: 401,
    msg: 'The signature does not recover to the acting address.',
    why: 'Every act is signed EIP-191 over the canonical body minus `sig`, and the address is recovered from the signature rather than trusted from the field. There are no passwords and no server-held secrets here, so this check is the entire authentication system: if it were skipped, the `as` field would be a claim anyone could type.',
    next: 'Re-sign the canonical body with the wallet key that owns `as`. Any change to any field, including key order, changes what must be signed.',
  },
  BAD_ADDRESS: {
    http: 400,
    msg: 'That is not a well-formed address.',
    why: 'Addresses are checked to the byte — 0x and exactly 40 hex characters — and the zero address is refused outright, because nobody holds its key and anything settled there is destroyed with no way back. Earnings are paid to addresses, not to handles, so a malformed one is a payment into nothing.',
    next: 'Paste the address out of the wallet rather than typing it.',
  },
  UNKNOWN_ACCOUNT: {
    http: 404,
    msg: 'That address has never registered.',
    why: 'Balances, handles and post ownership are all keyed by registered address. An act from an address the world has never seen has no row to debit, so accepting it would either create an account as a side effect of spending or leave replay reading an undefined balance.',
    next: 'Send `register` with a handle first.',
  },
  HANDLE_TAKEN: {
    http: 409,
    msg: 'That handle already belongs to another address.',
    why: 'A handle binds to exactly one address, once, and the binding is the first act that account ever makes. Two addresses wearing one name is impersonation, and here it would also make the feed ambiguous about who earned what.',
    next: 'Pick another handle. Nothing frees a taken one; the binding is permanent.',
  },
  HANDLE_INVALID: {
    http: 400,
    msg: 'That handle is not in the permitted shape.',
    why: 'Handles are compared after folding case and confusable characters, so the permitted alphabet is deliberately narrow. A name that only differs from another by an invisible codepoint reads as the same name to every human, which makes it an impersonation tool rather than a name.',
    next: 'Use the documented alphabet and length. A name that reads differently is accepted.',
  },
  ALREADY_REGISTERED: {
    http: 409,
    msg: 'This address already holds a handle.',
    why: 'Registration is once per address because the handle is a display name over an identity that is already unique — the key. Allowing a second would let one account present two names in one feed while weighing once.',
    next: 'Nothing. Use a different key if you want a different name.',
  },
  SELF_ENGAGEMENT: {
    http: 400,
    msg: 'You cannot view, like or comment on your own post for credit.',
    why: 'Self-engagement is excluded from distribution in every version of the rules, so an accepted self-view would move money out of your balance and credit nothing back — a pure loss recorded permanently. It is refused at the door instead of being silently worth zero, so the meter and the reward agree.',
    next: 'Nothing to fix. Your own post is readable without an act.',
  },

  // ── Burn — the only way in ──────────────────────────────────────────────
  BURN_UNCONFIRMED: {
    http: 400,
    msg: 'That burn transaction is not confirmed yet.',
    why: 'An unconfirmed bitcoin transaction can still be replaced. Crediting reserve from one would let a sender fee-bump the same coins elsewhere afterwards and keep the weight, which is weight bought with money that was never destroyed.',
    next: 'Wait for the required confirmations and send the claim again. The txid stays valid.',
  },
  BURN_EXPLORERS_DISAGREE: {
    http: 502,
    msg: 'Two independent explorers reported different facts about that transaction.',
    why: 'Reserve is granted only when two independent public explorers agree on the output, the amount and the confirmation state. Disagreement means the host cannot tell which answer is true, and a number written into a permanent public record on a coin-flip is worse than no number at all.',
    next: 'Check the txid yourself on any explorer and retry later; propagation gaps usually close within a block.',
  },
  BURN_NOT_KEYLESS: {
    http: 400,
    msg: 'That transaction does not pay the keyless burn output.',
    why: 'The burn address has no key by construction, which is what makes destruction irreversible and unfakeable — nobody, including the operator and the network, can spend what went there. A payment to any spendable address is a transfer, not a burn, and grants nothing.',
    next: 'Send to the burn output published at GET /api/v1/params and claim that txid.',
  },
  BURN_ALREADY_CLAIMED: {
    http: 409,
    msg: 'That burn txid is already recorded.',
    why: 'A burn counts once, whoever presents it. Without the uniqueness index one destruction could be replayed into unlimited reserve, which is the same as reserve costing nothing — and rule 4 (weight linear in satoshis destroyed) collapses the moment satoshis can be counted twice.',
    next: 'Nothing. The log names the address that holds that txid; claim your own burns promptly.',
  },
  INSUFFICIENT_RESERVE: {
    http: 400,
    msg: 'You hold fewer satoshis of reserve than this act would move.',
    why: 'Reserve is the satoshi side of the account, credited only by verified burns and by selling PTP in the one pool. It is not a promise the host can extend: every satoshi in the world was destroyed on bitcoin first, so there is nothing to lend against.',
    next: 'Claim a burn, or sell PTP into the pool for satoshis.',
  },

  // ── Money ───────────────────────────────────────────────────────────────
  BAD_AMOUNT: {
    http: 400,
    msg: 'That amount is not a positive integer.',
    why: 'All money here is BigInt — wei, satoshis, nanoeuros, CAP micro-units — and every amount must be strictly positive. Zero and negative amounts are refused rather than clamped, because a negative "payment" is a withdrawal wearing the wrong sign, and a zero one is a free act.',
    next: 'Send the amount as an integer string in the asset\'s smallest unit.',
  },
  INSUFFICIENT_PTP: {
    http: 400,
    msg: 'Your PTP balance is smaller than this act requires.',
    why: 'Balances are derived by replaying the log, not held in a database the interface can read ahead of, so the figure on your screen may already be one act stale — a view billed a moment ago has left before you pressed anything. Nothing is ever settled partially: the act is skipped whole and your balance is untouched.',
    next: 'Reload the world and retry, or buy PTP with satoshis in the one pool.',
  },
  INSUFFICIENT_CAP: {
    http: 400,
    msg: 'You hold fewer CAP than the MB·days this post consumes.',
    why: 'CAP is a storage receipt, not money: it is minted only against capacity that members proved they served, and publishing burns it at the picture\'s megabytes times the replication factor times the days bought. The check is what keeps published bytes from exceeding bytes that are actually held somewhere.',
    next: 'Send `capBuy` to convert PTP into CAP, then publish. The publish quote names the exact MB·days.',
  },
  DUST_BELOW_MINIMUM: {
    http: 400,
    msg: 'The amount rounds below the minimum this settlement can carry.',
    why: 'Euro prices are converted to PTP wei through the oracle and the pool spot, and truncation at the bottom of that rope can reach zero. A price that silently became free would be a free view, and a free view is a sybil faucet — so conversions floor at 1 wei and anything a payout cannot express at all is refused rather than rounded away.',
    next: 'Raise the price or batch the payout. The dust flag on the quote tells you in advance.',
  },

  // ── The one pool ────────────────────────────────────────────────────────
  POOL_EMPTY: {
    http: 400,
    msg: 'The pool has no liquidity on at least one side.',
    why: 'Constant-product arithmetic is undefined against a zero reserve — the output formula divides by the input reserve. The pool cannot reach zero through trading, only before genesis liquidity has landed or after every unlocked share has been withdrawn, and MINIMUM_LIQUIDITY shares are locked forever precisely so the second case cannot happen in normal use.',
    next: 'Add liquidity, or wait for the genesis deposit to land.',
  },
  SLIPPAGE_EXCEEDED: {
    http: 400,
    msg: 'The fill would have been worse than your minOut.',
    why: 'A constant-product pool reprices on every swap, and somebody traded between the quote you were shown and your act arriving. Every swap therefore carries minOut, and a fill at a price the screen never showed is refused rather than executed — the trade you asked for no longer exists at that price.',
    next: 'Take a fresh quote and send again. Raising tolerance accepts a worse price; it does not avoid one.',
  },
  LIQUIDITY_TOO_SMALL: {
    http: 400,
    msg: 'That deposit would mint no shares.',
    why: 'Liquidity is minted on the proportional part of an offer, so a deposit skewed away from the current ratio contributes only its matching side — and one small enough to mint zero shares would be a donation to existing providers with no receipt. The first deposit also has MINIMUM_LIQUIDITY shares burned out of it, so it must clear that floor.',
    next: 'Deposit both sides near the current ratio, and more than the minimum.',
  },
  INSUFFICIENT_SHARES: {
    http: 400,
    msg: 'You hold fewer pool shares than you are trying to remove.',
    why: 'Shares are an account balance like any other and are removed against the reserves they represent. The locked MINIMUM_LIQUIDITY shares belong to nobody and are not counted in anyone\'s holding, which is what makes draining the pool to zero impossible rather than merely discouraged.',
    next: 'Read your share balance from the world and remove that or less.',
  },

  // ── Billable views ──────────────────────────────────────────────────────
  VIEW_TOO_SOON: {
    http: 429,
    msg: 'The cooldown for this viewer and this post has not elapsed.',
    why: 'A billable view requires viewCooldownSec since the last one of the same (viewer, post) pair. Without it a scroll that bounced a picture through the viewport twice would charge twice for one act of looking, which is how per-impression billing turns into a trap.',
    next: 'Nothing to fix. The next view of this post becomes billable when the cooldown expires; looking in the meantime is free.',
  },
  VIEW_DWELL_TOO_SHORT: {
    http: 400,
    msg: 'The picture was not on screen long enough to be a view.',
    why: 'A view bills only after viewDwellMs of continuous presence at 60 % of the viewport. Scrolling past is not looking, and charging for it would make the feed cost money to skip.',
    next: 'Nothing to fix — this impression was not billable and no PTP moved.',
  },
  VIEW_PAIR_CAP: {
    http: 429,
    msg: 'This viewer and post have reached their billable views for the epoch.',
    why: 'maxViewsPerPairPerEpoch caps how often one pair can transact inside one epoch. The creator\'s reward already decays as 1/(1 + α·(n−1)) per repeat while the viewer keeps paying in full; the cap is the hard stop that keeps an admirer — or a loop pretending to be one — from spending without limit.',
    next: 'Nothing until the epoch closes. The counter resets at close.',
  },
  VIEW_SEQ_REPLAY: {
    http: 409,
    msg: 'That view sequence number has already been used.',
    why: 'Each view carries a per-viewer `seq` that must advance. Since the act is signed, a replayed body is otherwise a perfectly valid second charge, and the sequence is what makes a captured view act worthless to whoever captured it.',
    next: 'Read your last accepted seq from the world and send the next one.',
  },

  // ── The post lifecycle ──────────────────────────────────────────────────
  POST_NOT_FOUND: {
    http: 404,
    msg: 'No post exists under that id.',
    why: 'Post ids are assigned by the writer in sequence at acceptance, so an id that was derived by counting rather than read back will be wrong. Acts pointing at ids that were never minted used to be accepted and charged for, which put permanent entries in the log meaning nothing.',
    next: 'Read the id from the feed or the log rather than computing it.',
  },
  POST_NOT_LIVE: {
    http: 409,
    msg: 'That post is not live.',
    why: 'Views, likes and comments accrue only while a post is inside its paid-for days. Once the rent lapses the picture is on its way off every device that held it, and crediting engagement to bytes that are being deleted would create earnings nobody can attribute to anything a viewer saw.',
    next: 'Send `extend` before the day lapses if it is yours. Lapsed posts settle and are done.',
  },
  POST_ALREADY_SETTLED: {
    http: 409,
    msg: 'That post has already settled.',
    why: 'Settlement is once and final: it pays creditNano to the creator in PTP, redacts the payload from every node, and writes the tombstone into the epoch block. A second settlement would pay the same earnings twice out of a supply that is only expanded by emission.',
    next: 'Nothing. The tombstone in the chain carries the final numbers.',
  },
  SETTLE_BEFORE_GRACE: {
    http: 425,
    msg: 'This post has not been lapsed long enough to settle.',
    why: 'Settlement opens settlementGraceSec after the paid-for day ends, and anybody may then send it — it is an act, not a timer, because replay may never consult a clock. The grace window is what lets an owner extend a post that expired while they were asleep, before a stranger closes it.',
    next: 'Extend it if it is yours, or wait out the grace and settle then.',
  },
  EXTEND_ON_SETTLED: {
    http: 409,
    msg: 'A settled post cannot be extended.',
    why: 'Extension buys storage days for bytes that still exist. After settlement the picture is deleted from every node and only the structural record and the payload commitment remain, so there is nothing left for the rent to keep alive.',
    next: 'Publish again. The new post is a new cid with its own lifetime.',
  },
  NOT_THE_AUTHOR: {
    http: 403,
    msg: 'Only the author can do that to this post.',
    why: 'Ownership is the address that signed the `post` act, and extension and pricing follow it. Settlement deliberately does not — anyone may close a lapsed post, because a network where deletion depends on the author showing up is a network that never deletes.',
    next: 'If it is yours, sign with the address that published it.',
  },
  CID_IN_USE: {
    http: 409,
    msg: 'Another post that has not settled yet is published under that cid.',
    why: 'A cid addresses bytes, and settlement redacts BY cid — the host unlinks the object and every client is told to forget it. Two unsettled posts under one cid therefore share one deletion: settling the cheaper one destroys the other one\'s picture while its lease still has days to run and its viewers are still being billed for a 404. The index that prevents it is in core/replay.mjs beside the burn index rather than as a reference count in the media store, because all three readers must agree on whether a post is publishable and only two of them have a media store.',
    next: 'Publish your own bytes — a cid is the sha256 of them, so a different picture is a different cid. A cid is free again once the post holding it settles.',
  },
  CID_MISMATCH: {
    http: 400,
    msg: 'The uploaded bytes do not hash to the declared cid.',
    why: 'A cid is the sha256 of the bytes and nothing else, which is what lets any node verify a shard it was handed by a stranger. If the pair were allowed to disagree, the payload commitment sealed in the epoch block would prove the existence of bytes nobody ever served.',
    next: 'Hash the exact bytes you are uploading and publish under that cid.',
  },
  MIME_REFUSED: {
    http: 415,
    msg: 'This host does not carry that media type.',
    why: 'The type list is short and checked against the actual leading bytes, not the declared field. Members grant real storage on their own devices to hold these shards, and what they agreed to hold is pictures.',
    next: 'Re-encode as one of the types listed in GET /api/v1/params.',
  },
  COMMENT_TOO_LONG: {
    http: 400,
    msg: 'The comment exceeds the length this network carries.',
    why: 'Comment text lives in the act log itself, which every participant downloads and replays forever — unlike the picture, it is never sharded and never deleted by settlement. Length is capped on what everyone else must carry, not on what you have to say.',
    next: 'Shorten it, or split it across two comments — each is billed separately.',
  },

  // ── Capacity ────────────────────────────────────────────────────────────
  CAPACITY_PROOF_WRONG: {
    http: 400,
    msg: 'The answer does not match the challenged byte range.',
    why: 'A challenge names a shard and a byte window derived from the epoch seed, and only a node actually holding those bytes can hash them. A wrong answer means the shard is absent, truncated or altered, so no MB·days accrue for it — the proof is the only thing standing between a storage receipt and a claim.',
    next: 'Re-fetch the shard from another placement holder and answer the next challenge.',
  },
  CAPACITY_PLEDGE_UNPROVEN: {
    http: 400,
    msg: 'This pledge has no accepted proof behind it.',
    why: 'A `capPledge` is an announcement; MB·days accrue from `capProof` acts and nothing else. Paying announcements would pay whoever types the largest number, so the pot is drawn against proven bytes only.',
    next: 'Serve the shards placement assigned you and answer challenges, then claim.',
  },
  CAPACITY_POT_EMPTY: {
    http: 400,
    msg: 'No escrow behind your proofs has anything left to draw.',
    why: 'Capacity is paid PER POST, out of the two escrows that post\'s own money funded — holding, from its rent, and serving, from the capacity share of its own engagement — and never out of a global pot. A pot divided pro rata by bytes stored pays a griefer 361% for pictures nobody looks at, which is why `capacityPayout` is perPostEscrow. A claim that would draw nothing is refused rather than paid as zero, because paying zero would mark the proofs claimed and consume them for nothing.',
    next: 'Nothing is lost: the proofs stay unclaimed and draw from the same posts as soon as rent or engagement refills their escrows. A post whose lease has run out will never refill; its remainder is destroyed at settlement.',
  },
  CAPACITY_OVER_PLEDGE: {
    http: 400,
    msg: 'This proof would credit more megabyte-days than the pledge can serve.',
    why: 'One CAP is one megabyte-day and an epoch is a day, so a pledge of M megabytes can honestly earn at most M CAP inside one epoch, and proofs are credited against exactly that ceiling. Without it, placement and payment rank on node id while the bond prices megabytes, so twenty invented ids pledging a megabyte each draw what twenty real disks draw for a two-thousandth of the bond. The bond prices the identity; this ceiling prices the capacity the identity claimed to have.',
    next: 'Pledge the capacity you actually serve — `capPledge` raises the ceiling and the bond with it — or claim what is proven and prove again after the next close.',
  },
  CAPACITY_NOT_PLACED: {
    http: 400,
    msg: 'That shard is not placed on this node.',
    why: 'Placement is rendezvous hashing over the live node set, so every node computes the same top-N holders for a shard with no coordinator. A proof for a shard you were not assigned earns nothing, because it does not improve the replication of anything.',
    next: 'Ask core/placement.mjs which shards are yours for the current node set, and serve those.',
  },

  // ── Prices, rules and epochs ────────────────────────────────────────────
  ORACLE_STALE: {
    http: 503,
    msg: 'No fresh EUR/BTC rate is sealed for this epoch.',
    why: 'Prices are euros and settlement is PTP, roped together through a signed median of at least three public sources and the pool spot. Between epochs the last sealed rate is used deliberately, so prices do not move under a user mid-session — but pricing against a rate no epoch ever sealed would make the charge unverifiable afterwards.',
    next: 'Retry after the next epoch close. GET /api/v1/oracle shows the rate and its age.',
  },
  RULES_KEY_ONLY: {
    http: 403,
    msg: 'Only the rule key may change the distribution module.',
    why: 'One named address may send `rulesSet`, and that address can change how the emission pot is divided and nothing else — it cannot mint, cannot move a balance, cannot touch the pool, cannot alter a sealed block. Narrowing the key to exactly one act is what makes it survivable that the key exists.',
    next: 'Nothing from another address. The active key is published at GET /api/v1/rules.',
  },
  RULES_EPOCH_PAST: {
    http: 400,
    msg: 'A rules change must name an epoch in the future.',
    why: 'fromEpoch must be strictly greater than the current epoch, because a closed epoch is never re-cut. If a new module could apply backwards, every past earnings figure would become a function of today\'s politics rather than of the log, and no historical block would verify twice.',
    next: 'Resend with fromEpoch above the current epoch number.',
  },
  RULES_VERSION_UNKNOWN: {
    http: 400,
    msg: 'No published module matches that version and hash.',
    why: 'A rules change names a version and the sha256 of its source, and both are checked against what the host actually serves at GET /api/v1/rules/:version. Every past epoch stays recomputable with the module that actually computed it, which is only true if a named module is guaranteed to be fetchable.',
    next: 'Publish the module source first, then set the version to the hash that endpoint reports.',
  },
  EPOCH_NOT_CLOSED: {
    http: 404,
    msg: 'That epoch has not closed.',
    why: 'Emission is minted and split at close, from engagement inside the epoch. Before close there is no share to prove and no root to publish, so a question about an open epoch is a question about the future.',
    next: 'GET /api/chain/head for the last closed epoch, then ask about that one or earlier.',
  },
  EPOCH_ALREADY_CLOSED: {
    http: 409,
    msg: 'That epoch is already sealed.',
    why: 'Each close mints once and links one block to the previous by hash. A second close would either mint twice for one epoch or fork the chain at that height, and the chain exists precisely so that silent rewriting is detectable.',
    next: 'Nothing. The next close seals the epoch that is now open.',
  },
  TIMESTAMP_IMPLAUSIBLE: {
    http: 400,
    msg: 'The act timestamp is too far from the writer\'s clock.',
    why: 'Timestamps drive cooldowns, expiry and epoch boundaries, and replay reads them out of acts rather than from a clock. The writer therefore bounds a stamp when accepting it: a far-future stamp would expire posts early and skip cooldowns for everybody replaying afterwards, and nobody could tell later that it had.',
    next: 'Fix the sending clock and re-sign. The stamp is inside the signature.',
  },
};

// Frozen entry by entry, then the map itself. Nothing may add a code at runtime:
// a refusal that exists on one host and not another is a refusal that cannot be
// branched on, and both readers of the rulebook must answer identically.
for (const [code, spec] of Object.entries(CATALOGUE)) {
  spec.code = code;
  Object.freeze(spec);
}

/**
 * The catalogue: code -> { code, http, msg, why, next }, frozen.
 *
 * Exported as a map rather than a list because the common use is a lookup on a
 * code that arrived from somewhere else, and because `E.VIEW_TOO_SOON` in
 * source is a spelling the reader can check by eye.
 */
export const E = Object.freeze(CATALOGUE);

// The one entry that is not about the network: what a host says when it refuses
// with a code that is not catalogued. It is answered honestly rather than
// silently dropping the fields callers depend on, because a caller that gets
// `{ ok:false }` and nothing else has to parse a sentence to learn anything.
const UNCATALOGUED = Object.freeze({
  code: 'UNCATALOGUED',
  http: 500,
  msg: 'The act was refused with a code this host has no entry for.',
  why: 'Refusal codes are a published, frozen catalogue; a code outside it means the refusing code path is ahead of core/errors.mjs on this build. The refusal is real — the act did not apply — but the explanation is missing.',
  next: 'Report the code. Meanwhile treat it as a hard refusal and do not retry blindly.',
});

/**
 * Build a refusal body.
 *
 * The four catalogue fields are constants; `detail` is where the numbers go —
 * the balance you had, the seconds left, the two amounts the explorers gave.
 * Keeping them apart is what lets GET /api/v1/errors be a static document and
 * lets a client show the standing explanation without a round trip.
 *
 * `detail` is always present, defaulting to null, so the response shape never
 * varies. A consumer that has to test for the existence of a key ends up
 * branching on absence, which is a worse signal than an explicit null.
 */
export function refuse(code, detail) {
  const spec = E[code] || UNCATALOGUED;
  return {
    ok: false,
    code: spec === UNCATALOGUED ? String(code) : spec.code,
    msg: spec.msg,
    why: spec.why,
    next: spec.next,
    detail: detail === undefined ? null : detail,
  };
}

/**
 * The HTTP status a host answers with for a code.
 *
 * Separate from `refuse` because the body and the status line are written by
 * different layers: replay produces the refusal without knowing it is inside an
 * HTTP request at all, and the transport looks the status up afterwards.
 * Unknown codes get 500 rather than 400 — an uncatalogued refusal is this
 * host's fault, not the caller's.
 */
export function httpFor(code) {
  return (E[code] || UNCATALOGUED).http;
}

/**
 * The whole catalogue as a sorted array, for GET /api/v1/errors.
 *
 * Sorted by code so two hosts serving the same edition serve byte-identical
 * documents and a diff between them means a real difference in builds. Returns
 * fresh plain objects: the endpoint's caller may serialise, wrap or paginate
 * them, and none of that may reach the frozen originals.
 */
export function list() {
  return Object.keys(E)
    .sort()
    .map((code) => ({ ...E[code] }));
}
