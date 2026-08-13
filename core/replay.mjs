// The one rulebook. Every number in this network is a pure function of the act
// log, and this file is that function.
//
// The server, the browser and the chain builder import THIS module — not a copy,
// not a port, not a compatible reimplementation. A server may not accept what
// replay would skip, and a browser may not offer a button for an act replay would
// refuse, because both of them ask the same function (`actError`) and print the
// same sentence from the same catalogue. That is ARCHITECTURE rule 2, and the
// only way to hold it is to have one file.
//
// ── THE THREE PROPERTIES THIS FILE IS BUILT AROUND ─────────────────────────
//
// 1. REPLAY NEVER CONSULTS A CLOCK, A NETWORK OR A RANDOM SOURCE. Nothing in
//    here reads Date.now, Math.random or fetch, and nothing may. Post expiry,
//    epoch close, view cooldowns and settlement grace all happen because an ACT
//    LANDED CARRYING A TIMESTAMP — never because time passed while somebody was
//    reading. Two machines replaying the same log at different times on different
//    continents get the same world, to the wei.
//
// 2. applyAct IS TOTAL. An act that does not validate is skipped WHOLE. No
//    balance moves, no number becomes NaN, and the world after a rejected act is
//    identical in content to the world before it. The mechanism is structural
//    rather than careful: every act kind is written as a `prepare` that computes
//    the entire effect and touches nothing, and a `commit` that only assigns
//    values already computed. There is no path where validation and mutation
//    interleave, so there is no half-applied act to undo.
//
// 3. MONEY IS BigInt, END TO END. Balances, reserves, supply, prices and fees are
//    all bigint. Counts, timestamps and dimensions are Numbers because they are
//    counts, timestamps and dimensions. Amounts arrive on the wire as decimal
//    STRINGS and become bigint at this boundary; a JSON number past 2^53 is a
//    different number, and this is the last place that is cheap to catch.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────────────
//
// SIGNATURE VERIFICATION BELONGS TO THE SERVER, NOT HERE. Every act is signed
// EIP-191 over the canonical act body minus `sig` (ARCHITECTURE §4), and the
// address is recovered from the signature rather than trusted from the `as`
// field. That check needs a curve implementation and a canonical encoder; replay
// needs neither, and dragging them in would make the one rulebook unloadable in
// the two readers that have no dependencies. Replay validates STRUCTURE and
// ECONOMICS over a log it is given, and treats `as` as the acting address. A host
// that appends an unsigned act has forged its own record — the chain makes that
// attributable, and BAD_SIGNATURE is the server's refusal, not this file's.
//
// Likewise: replay cannot see bitcoin (burn confirmations are `server/burnwatch`),
// cannot see bytes (a capacity proof's answer is checked by whoever holds a
// complete copy), and cannot see a viewport (a view act's dwell and viewport
// fraction are the client's own attestation). Each of those limits is stated at
// the act that carries it rather than papered over.

import { PARAMS, WAD, NANO_EUR_PER_EUR, SAT_PER_BTC, applyEpochRail, creatorRebate } from './params.mjs';
import { E, refuse } from './errors.mjs';
import { quote, addLiquidity, removeLiquidity, genesisPool } from './amm.mjs';
import {
  actionPriceNanoEur,
  nanoEurToPtpWei,
  priceOf,
  sealRate,
  splitFee,
  splitVectorsOf,
} from './pricing.mjs';
import { placeShard } from './placement.mjs';
import { VERSION as RULES_V1, credit as creditV1 } from './rules/v1.mjs';

// ── the edition ────────────────────────────────────────────────────────────

/**
 * The sha256 of this file's own source, self-reported.
 *
 * The epoch block seals it as `editions.replay`, which is what lets a verifier
 * say "this state was computed by THIS rulebook" rather than "by some rulebook".
 * A block whose numbers do not reproduce under the edition it names is a block
 * that named the wrong edition, and that is a different and much more useful
 * complaint than "the numbers disagree".
 *
 * It is computed by reading the file, because a constant somebody edits by hand
 * is a constant that lies the first time somebody forgets. The read is guarded
 * and asynchronous: on a host with a filesystem it is the real digest, and in a
 * browser — where a module cannot read itself synchronously and where nothing
 * seals a block anyway — it is the honest string "unavailable" rather than a
 * plausible-looking wrong hash.
 */
export const EDITION = await (async function selfEdition() {
  try {
    if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
      return 'unavailable';
    }
    const [{ readFileSync }, { createHash }] = await Promise.all([
      import('node:fs'),
      import('node:crypto'),
    ]);
    return createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  } catch {
    return 'unavailable';
  }
})();

// ── constants this file states, because two readers must agree on them ─────
//
// Each of these is a limit ARCHITECTURE names without pinning, or a unit
// core/params.mjs does not carry. They are stated here rather than left to the
// caller for the same reason core/amm.mjs restates the swap fee: a threshold that
// lives in the client is a threshold two readers can disagree about, and a
// disagreement about a threshold is a disagreement about who owes what.

/**
 * The most bytes an act may serialise to, roughly measured.
 *
 * Every act is appended to a log that every participant — browser included —
 * downloads and replays from the beginning, so the cost of one oversized line is
 * paid forever by everybody rather than once by the sender. The largest lawful
 * act is a comment, which is capped at a thousand characters; 64 KiB leaves two
 * orders of magnitude of headroom for a field nobody has thought of yet.
 */
export const MAX_ACT_BYTES = 65536;

/**
 * How deep an act may nest. core/canonical.mjs publishes the same bound for the
 * same reason and the two must agree: an act deeper than the encoder will commit
 * is an act the chain cannot seal, so accepting it here would build a world no
 * block can carry.
 *
 * The measurement is iterative, with an explicit stack. A recursive check would
 * itself overflow on the twenty-thousand-deep payload it exists to refuse, which
 * is how one cheap message halts every reader of the log at once.
 */
export const MAX_ACT_DEPTH = 64;

/** One megabyte, decimal. Storage rent, CAP and every MB-day in ECONOMICS.md are
 * quoted per megabyte, and nothing in the parameter file fixes which megabyte, so
 * this file fixes it: 10^6 bytes, matching the decimal thinking of the nanoeuro
 * and of every other unit in this economy. A 2 MB picture is 2,000,000 bytes and
 * costs 0.000012 EUR a day at replication 3, which is the figure ECONOMICS.md
 * quotes. */
export const BYTES_PER_MB = 1000000n;

/** The largest picture this network will carry. Replication multiplies it onto
 * strangers' devices — at REPLICATION 3 an 8 MB upload asks for 24 MB of somebody
 * else's storage grant — so the cap is on what everyone else must hold. */
export const MAX_PAYLOAD_BYTES = 8000000;

/** A comment lives in the act log itself and is never sharded and never deleted,
 * so its length is capped on what every participant must carry forever. The
 * client's composer states the same thousand characters. */
export const MAX_COMMENT_CHARS = 1000;

/**
 * The shard size placement and proofs are computed over.
 *
 * core/placement.mjs takes it as an argument and fixes nothing, so somebody has
 * to, and it has to be the same somebody for a browser node and a server node or
 * they place the same picture differently. 256 KiB: small enough that a 4 KiB
 * challenge window is a real sample of it, large enough that an 8 MB picture is
 * 31 shards rather than a thousand.
 */
export const SHARD_BYTES = 262144;

/**
 * The EUR/BTC rate a world opens with, 90,000 EUR/BTC in nanoeuros.
 *
 * core/params.mjs carries no EUR/BTC reference — correctly, because the rate is
 * an observation and not a constant — but a world has to price its first act
 * before any epoch has closed to seal one. This is the reference every worked
 * example in docs/ECONOMICS.md is computed at, so a fresh world reproduces those
 * numbers exactly. A deployment overrides it by passing `genesisEurPerBtcNano` in
 * its params edition, and the first `closeEpoch` carrying an oracle replaces it
 * outright.
 */
export const GENESIS_EUR_PER_BTC_NANO = 90000n * NANO_EUR_PER_EUR;

/** What members agreed to hold is pictures. The list is short and the server
 * checks it against the leading bytes; replay checks the declared field, which is
 * what both readers can check. */
const MIME_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/**
 * The distribution modules this rulebook ships with.
 *
 * `rulesSet` names a module by version and hash — the RULE KEY ONLY. It cannot
 * carry code: a rulebook that loaded a module out of an act would be a rulebook
 * every reader computed differently, which is the one thing this file exists to
 * prevent. A version this build does not carry is refused with
 * RULES_VERSION_UNKNOWN, and the host publishes the source of every version it
 * carries at GET /api/v1/rules/:version so a past epoch stays recomputable with
 * the module that actually computed it.
 */
const RULES_REGISTRY = Object.freeze({ [RULES_V1]: creditV1 });

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const HEX64_RE = /^[0-9a-f]{64}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9_]{2,23}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const MAX_TIMESTAMP = 4102444800000; // 2100-01-01, far past any real stamp
const MS_PER_SEC = 1000n;

// ── small pure helpers ─────────────────────────────────────────────────────

function isPlainObject(v) {
  if (Object.prototype.toString.call(v) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A map whose keys are addresses, handles or ids: no prototype, so no key can
 * ever be inherited and `in` means what it says. */
function bare() {
  return Object.create(null);
}

/** Divide rounding up. Used for charges, so the network is never short a wei. */
function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * Read a money amount from the wire.
 *
 * A bigint passes through; a canonical decimal string becomes one. Everything
 * else is refused, and a Number most of all — JSON.parse of a wei balance past
 * 2^53 silently loses digits, and a balance that is off by a rounding is a
 * balance two readers disagree about. Leading zeros are refused as well, because
 * "007" and "7" would be two encodings of one amount and the log is canonical.
 */
function readWei(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'string' && DECIMAL_RE.test(v)) return BigInt(v);
  return null;
}

/** A count, an index, a millisecond stamp: a safe non-negative integer Number. */
function readIndex(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Read an address and fold it to one spelling.
 *
 * EIP-55 checksummed and all-lowercase forms are the same address, and keying the
 * world by the caller's spelling would make them two accounts holding two
 * balances. The zero address is refused outright: nobody holds its key, so
 * anything paid there is destroyed with no way back and no refusal to explain it.
 */
function readAddress(v) {
  if (typeof v !== 'string' || !ADDRESS_RE.test(v)) return null;
  const lower = v.toLowerCase();
  return lower === ZERO_ADDRESS ? null : lower;
}

/**
 * Fold a handle to its confusable skeleton.
 *
 * core/errors.mjs promises that handles are compared "after folding case and
 * confusable characters", and this is that fold: the alphabet is already narrow
 * ASCII, so what remains is the digit/letter lookalikes and the underscore. A
 * name that reads the same to a human is the same name here, which makes
 * impersonation cost a genuinely different name rather than an invisible one.
 */
function handleSkeleton(handle) {
  return handle
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/_/g, '');
}

/** The key of one (viewer, post) pair in the view ledger. Both halves are
 * validated before they get here, and neither can contain the separator. */
function pairKey(addr, pid) {
  return `${addr}|${pid}`;
}

/**
 * Run arithmetic that is allowed to refuse, and turn its refusal into a code.
 *
 * core/amm.mjs, core/pricing.mjs and core/params.mjs all signal by throwing an
 * Error whose message is a catalogued code, because they must load with nothing
 * behind them. This is where that convention meets this one. It is used only
 * inside `prepare`, before anything has been assigned, so a throw from the
 * arithmetic is a refusal and never a half-applied act.
 */
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    const code = err && typeof err.message === 'string' ? err.message.split(':')[0] : '';
    return { code: Object.prototype.hasOwnProperty.call(E, code) ? code : 'BAD_REQUEST' };
  }
}

// ── the world ──────────────────────────────────────────────────────────────

/**
 * A fresh world: the genesis pool, an opening rate, and nothing else.
 *
 * Nobody is allocated anything. The only PTP that exists is the 10,000 the pool
 * opens against, and the only way to hold any is to buy it with bitcoin that was
 * destroyed first. `supply.emitted` counts that genesis liquidity because it is
 * PTP that exists; every later increase is an epoch's emission, and `burned` only
 * ever grows.
 *
 * The shape is ARCHITECTURE §5's, with eight additions that §5 summarises rather
 * than lists. They are named plainly because five other parts read them:
 *
 *   constants  the params edition this world is being replayed under, so
 *              `applyAct(world, act)` needs no third argument and a sealed epoch
 *              recomputes under the numbers that actually priced it.
 *   treasury   where the treasury leg of every split lands. Without it the split
 *              is not conservative and 2100 bps of every fee vanishes.
 *   views      the (viewer, post) ledger the cooldown and the per-epoch pair cap
 *              are read from.
 *   burns      the claimed-txid index. A burn counts once, whoever presents it.
 *   cids       the published-cid index: which unsettled post holds each cid. It
 *              sits beside `burns` because it is the same kind of thing — a
 *              uniqueness index that decides whether an act may land — and it is
 *              here rather than in the media store because settlement deletes by
 *              cid and all three readers must agree about who those bytes
 *              belonged to.
 *   handles    the handle index, keyed by confusable skeleton.
 *   log        the writer's own bookkeeping: last index, last stamp, counts, and
 *              the count of acts that were priced at the underflow floor.
 *   history    the burn of the last seven closed epochs, which is the median the
 *              emission spike rail measures against.
 */
export function emptyWorld(params = PARAMS) {
  const pool = genesisPool();
  const oracle = sealRate(pool, {
    eurPerBtcNano: params.genesisEurPerBtcNano || GENESIS_EUR_PER_BTC_NANO,
    epoch: 0,
  });
  return {
    constants: params,
    accounts: bare(),
    posts: bare(),
    comments: bare(),
    pool,
    supply: { emitted: params.genesisPtpWei, burned: 0n },
    treasury: { ptp: 0n },
    capacity: { potPtp: 0n, bondsPtp: 0n, providers: bare() },
    rules: {
      version: RULES_V1,
      hash: '',
      setBy: null,
      fromEpoch: 0,
      // The named rule key, folded to one spelling like every other address.
      // core/params.mjs does not carry one — the address is a deployment's
      // choice, sealed into the constants the block publishes — and with none
      // named `rulesSet` is refused from everybody, which is the safe default: an
      // unnamed key cannot be impersonated.
      key: params.ruleKey ? readAddress(params.ruleKey) : null,
      next: null,
    },
    epoch: { n: 0, startedAt: 0, closedAt: 0, oracle, burnedWei: 0n, acts: [] },
    history: [],
    views: bare(),
    burns: bare(),
    cids: bare(),
    handles: bare(),
    seq: { post: 0, comment: 0 },
    // `dust` is ARCHITECTURE §3's record: how many applied acts were priced at
    // the 1-wei underflow floor. It is a count rather than a flag because the
    // rule is about a rate, and one occurrence is a curiosity where a rising
    // count is a network whose prices have stopped being expressible.
    log: { lastIndex: -1, lastAt: 0, count: 0, skipped: 0, dust: 0 },
  };
}

function newAccount(at) {
  return { handle: null, sat: 0n, ptp: 0n, cap: 0n, shares: 0n, joined: at, acts: 0, viewSeq: -1 };
}

// ── charging ───────────────────────────────────────────────────────────────

/**
 * The euro cost of holding a picture: bytes × replication × days, at the tariff.
 *
 * Rounded UP. Every charge in this file rounds up and every payout rounds down,
 * so the dust always ends where no account can claim it — in the burn, in the
 * pool or in an escrow that settlement destroys. A rounding that could be farmed
 * by choosing a size would be a size somebody chose.
 */
function rentNanoEur(bytes, days, params) {
  return ceilDiv(
    BigInt(bytes) * BigInt(days) * params.replication * params.storageRentNanoEurPerMbDay,
    BYTES_PER_MB,
  );
}

/** The CAP a picture consumes: the same MB-days, at CAP's six decimals. CAP is
 * the receipt that says the capacity exists; the rent is the payment for it. */
function capUnitsFor(bytes, days, params) {
  return ceilDiv(
    BigInt(bytes) * BigInt(days) * params.replication * params.capCoinPerMbDay,
    BYTES_PER_MB,
  );
}

/**
 * What a PTP quantity buys in CAP, as one fused rational with one truncation.
 *
 *                wei × eurPerBtcNano × poolSat × capCoinPerMbDay
 *   capUnits  =  ───────────────────────────────────────────────
 *                  10⁸ × poolPtpWei × storageRentNanoEurPerMbDay
 *
 * CAP is sold at the rent tariff, which is the only rate in the parameter file
 * that prices an MB-day, and the whole conversion is wei → CAP with the nanoeuro
 * never materialised. That is not a tidying: the obvious form goes through
 * `ptpWeiToNanoEur`, which core/pricing.mjs documents as a DISPLAY AND AUDIT
 * conversion and which floors at 1 n€ so that a meter never reads zero over a
 * balance that really moved. Settling money through that floor turns it into a
 * mint. Measured on the shipped edition at the genesis price: one wei floors to
 * 1 n€ and buys 500 CAP units, so 2,000 acts of one wei mint a whole MB-day —
 * 1,000,000 units that honestly cost 22,222,222,222,222 wei, a discount of
 * 1.1e10. Fused, one wei buys 4.5e-8 of a unit, which truncates to nothing and
 * is refused as dust.
 *
 * Truncated DOWN, so the buyer never receives a unit the tariff was not paid
 * for, and the residue stays with the network rather than with the buyer. The
 * floor is the refusal, not a substituted minimum: a conversion that cannot
 * express one unit is DUST_BELOW_MINIMUM at the caller, because minting the
 * smallest positive amount for a quantity that bought none of it is the same
 * faucet in a smaller denomination.
 */
function capUnitsForWei(wei, rate, params) {
  if (rate === null || typeof rate !== 'object') throw new Error('ORACLE_STALE');
  const { eurPerBtcNano, poolSat, poolPtpWei } = rate;
  if (typeof eurPerBtcNano !== 'bigint' || eurPerBtcNano <= 0n) throw new Error('ORACLE_STALE');
  if (typeof poolSat !== 'bigint' || poolSat <= 0n) throw new Error('POOL_EMPTY');
  if (typeof poolPtpWei !== 'bigint' || poolPtpWei <= 0n) throw new Error('POOL_EMPTY');
  return (
    (wei * eurPerBtcNano * poolSat * params.capCoinPerMbDay) /
    (SAT_PER_BTC * poolPtpWei * params.storageRentNanoEurPerMbDay)
  );
}

/**
 * Record that an act was priced at the underflow floor.
 *
 * ARCHITECTURE §3: `nanoEurToPtpWei` never returns zero for a non-zero price —
 * where truncation would reach zero it returns 1 wei "and the caller records a
 * `dust` flag". This is that record. It is unreachable in this economy until
 * about 1e10 times the genesis price — where a one-nanoeuro rent line is the
 * first thing to reach it — and it is written anyway, because the rule exists
 * precisely for the state where it is not unreachable: at the floor every price
 * collapses to the same single wei whatever it was quoted at, so the price
 * surface stops being a surface and a cheap act and an expensive one cost the
 * same. The only warning that state gives is this counter rising. A post carries
 * its own flag as well, so the state names WHICH pictures were priced at nothing
 * rather than only how often it happened.
 */
function recordDust(world, dust, pid) {
  if (!dust) return;
  world.log.dust += 1;
  if (pid !== undefined && world.posts[pid]) world.posts[pid].dust = true;
}

/** Whether a post is inside its paid-for days, judged by the timestamp the act
 * carried. Not by a clock: two machines replaying at different times must land on
 * the same answer. */
function isLive(post, at) {
  return post.state === 'live' && at < post.expires;
}

// ── placement, weighted by what was pledged ────────────────────────────────

/**
 * One rendezvous slot per gigabyte pledged, at least one and at most 64.
 *
 * Rendezvous hashing ranks NODE IDS, so an unweighted set gives one invented id
 * pledging a megabyte exactly the placement chance of a device pledging a
 * hundred gigabytes — while `capPledgeBondNanoEurPerGb` charges the second one a
 * hundred thousand times as much. Measured on the shipped edition: twenty
 * invented ids at 1 MB each paid 0.02% of one honest 100 GB pledge and won
 * twenty independent placements against its one. Weighting the ranking by
 * pledged megabytes is what puts the two prices back on the same scale.
 *
 * The weight is spent as VIRTUAL IDS rather than as a multiplier on the score,
 * because a multiplied score is not linear in the weight: doubling it triples
 * the odds and a 64× weight takes almost everything, which would hand the
 * largest pledge the whole network. n virtual ids compete independently, so a
 * node wins a share of placements proportional to n — which is the linearity
 * ECONOMICS.md prices the bond on.
 *
 * The cap at 64 slots is the bound on replay's own work: every reader ranks
 * every candidate for every proof, and an uncapped slot count would let a
 * one-terabyte pledge cost every reader a thousand digests per act. At the cap a
 * 64 GB pledge and a 1 TB pledge place alike; what still separates them is
 * CAPACITY_OVER_PLEDGE, which pays each of them only for the megabyte-days they
 * actually pledged.
 */
export const MB_PER_PLACEMENT_SLOT = 1000;
export const MAX_PLACEMENT_SLOTS = 64;

function placementSlots(mb) {
  const n = Math.ceil(mb / MB_PER_PLACEMENT_SLOT);
  if (n < 1) return 1;
  return n > MAX_PLACEMENT_SLOTS ? MAX_PLACEMENT_SLOTS : n;
}

/**
 * The nodes that should hold one shard, ranked by rendezvous over the pledged
 * set and weighted by how much each of them pledged.
 *
 * Exported because it is the one rulebook again: server/capacity.mjs issues
 * challenges from it and app/storage.mjs decides what a browser owes from it,
 * and a node challenged about a shard replay would not credit is a node doing
 * unpaid work. A virtual id is the address, a '#', and a two-digit slot index —
 * '#' cannot occur in an address, so no identity's virtual ids can collide with
 * another's, and the slot index is fixed-width so the preimage stays injective.
 */
export function placementFor(world, cid, shardIndex, replication) {
  const providers = world.capacity.providers;
  const want = replication === undefined ? Number(world.constants.replication) : replication;
  const candidates = [];
  for (const id of Object.keys(providers)) {
    const row = providers[id];
    if (!row || row.mb <= 0) continue;
    const slots = placementSlots(row.mb);
    for (let s = 0; s < slots; s += 1) candidates.push(`${id}#${String(s).padStart(2, '0')}`);
  }
  if (want <= 0 || candidates.length === 0) return [];
  const ranked = placeShard(candidates, cid, shardIndex, candidates.length);
  const out = [];
  for (const virtual of ranked) {
    const id = virtual.slice(0, virtual.lastIndexOf('#'));
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= want) break;
  }
  return out;
}

// ── act shape ──────────────────────────────────────────────────────────────

/**
 * Measure an act without recursing, and refuse it if it is too big or too deep.
 *
 * The size is a close approximation of the serialised length rather than the
 * exact byte count, because the exact count needs the canonical encoder and the
 * encoder is the thing this check protects. Nothing economic hangs on the
 * difference: the limit exists to stop one line costing every future reader, and
 * a few bytes either side of 64 KiB does not change that.
 */
function shapeProblem(act) {
  if (!isPlainObject(act)) return 'BAD_REQUEST';
  let bytes = 0;
  const stack = [{ v: act, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop();
    if (d > MAX_ACT_DEPTH) return 'BAD_REQUEST';
    const t = typeof v;
    if (v === null || t === 'boolean' || t === 'number' || t === 'bigint') {
      bytes += 24;
    } else if (t === 'string') {
      bytes += v.length + 2;
    } else if (Array.isArray(v)) {
      bytes += 2 + v.length;
      for (const x of v) stack.push({ v: x, d: d + 1 });
    } else if (isPlainObject(v)) {
      bytes += 2;
      for (const k of Object.keys(v)) {
        // Read the DESCRIPTOR, not the property. An act carrying an accessor is
        // refused without the accessor ever being invoked: a getter that throws
        // would turn a refusal into a crash, and a getter that answers differently
        // each time would make two readers of the one rulebook disagree about what
        // the act said. An act is data.
        const own = Object.getOwnPropertyDescriptor(v, k);
        if (!own || typeof own.get === 'function' || typeof own.set === 'function') {
          return 'BAD_REQUEST';
        }
        bytes += k.length + 4;
        stack.push({ v: own.value, d: d + 1 });
      }
    } else {
      // Functions, symbols, Dates, Maps, boxed primitives: none of them survive
      // canonical encoding, so none of them may enter the log.
      return 'BAD_REQUEST';
    }
    if (bytes > MAX_ACT_BYTES) return 'ACT_TOO_LARGE';
  }
  return null;
}

/** The envelope every act carries, whatever its kind. `sig` is carried and not
 * checked here; `i` is absent until the writer assigns it, which is why an act
 * validated before acceptance is still validatable. */
const ENVELOPE = new Set(['i', 't', 'as', 'k', 'sig']);

// ── the act table ──────────────────────────────────────────────────────────
//
// One entry per kind in ARCHITECTURE §4, and the table is CLOSED: an unknown kind
// is refused rather than carried, because an act nobody can interpret would hash
// into an epoch block and force every future verifier to keep a rule that was
// never written.
//
// Each entry is `{ fields, prepare }`.
//   `fields` is the complete set of fields the kind may carry. Anything else is
//   BAD_REQUEST — a closed field set is what makes the signed body unambiguous.
//   `prepare(world, act)` returns `{ code, detail }` to refuse, or
//   `{ commit }` where `commit(world)` only assigns values already computed.

const KINDS = bare();

function define(kind, fields, prepare) {
  KINDS[kind] = { fields: new Set(fields), prepare };
}

// ── identity ───────────────────────────────────────────────────────────────

define('register', ['handle'], (world, act) => {
  const { handle } = act;
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) return { code: 'HANDLE_INVALID' };
  if (world.accounts[act.as]) return { code: 'ALREADY_REGISTERED' };
  const skeleton = handleSkeleton(handle);
  if (world.handles[skeleton]) {
    return { code: 'HANDLE_TAKEN', detail: { handle, heldBy: world.handles[skeleton] } };
  }
  // The account bond in core/params.mjs (0.50 EUR) is NOT charged here, and the
  // omission is deliberate rather than forgotten. ARCHITECTURE §4 gives register
  // no fee, a fresh address holds no PTP to be charged, and the only way to hold
  // any is to register first and buy it — so a bond collected at this act cannot
  // be paid by anybody. Where it should be collected is a decision for the
  // economics part; every sybil bound in docs/ECONOMICS.md is computed WITHOUT
  // it, and a bond can only ever make an attacker poorer, so nothing in the
  // published margins depends on it.
  return {
    commit(w) {
      w.accounts[act.as] = newAccount(act.t);
      w.accounts[act.as].handle = handle;
      w.handles[skeleton] = act.as;
    },
  };
});

// ── burn — the only way in ─────────────────────────────────────────────────

define('burnClaim', ['txid', 'vout', 'sat'], (world, act) => {
  const { txid } = act;
  const vout = readIndex(act.vout);
  const sat = readWei(act.sat);
  if (typeof txid !== 'string' || !HEX64_RE.test(txid)) return { code: 'BAD_REQUEST' };
  if (vout === null) return { code: 'BAD_REQUEST' };
  if (sat === null || sat === 0n) return { code: 'BAD_AMOUNT' };
  const key = `${txid}:${vout}`;
  if (world.burns[key]) return { code: 'BURN_ALREADY_CLAIMED', detail: { txid, vout, heldBy: world.burns[key] } };
  // What replay can hold: a burn counts ONCE, whoever presents it. Without that
  // index one destruction replays into unlimited reserve, and rule 4 collapses
  // the moment satoshis can be counted twice.
  //
  // What replay cannot hold, stated rather than implied: that the transaction is
  // confirmed, that it pays the keyless output, or that two independent explorers
  // agree about it. Those are facts about bitcoin and they are checked by
  // server/burnwatch.mjs before the act is appended — BURN_UNCONFIRMED,
  // BURN_NOT_KEYLESS and BURN_EXPLORERS_DISAGREE are its refusals. A host that
  // appends a burn nobody made has forged its own record, and the chain is what
  // makes that attributable.
  return {
    commit(w) {
      w.burns[key] = act.as;
      w.accounts[act.as].sat += sat;
    },
  };
});

// ── the one pool ───────────────────────────────────────────────────────────

define('swap', ['sell', 'amt', 'minOut'], (world, act) => {
  const { sell } = act;
  const amt = readWei(act.amt);
  const minOut = readWei(act.minOut);
  if (sell !== 'btc' && sell !== 'ptp') return { code: 'BAD_REQUEST' };
  if (amt === null || amt === 0n) return { code: 'BAD_AMOUNT' };
  if (minOut === null) return { code: 'BAD_AMOUNT' };

  const account = world.accounts[act.as];
  if (sell === 'btc' && account.sat < amt) {
    return { code: 'INSUFFICIENT_RESERVE', detail: { have: account.sat, need: amt } };
  }
  if (sell === 'ptp' && account.ptp < amt) {
    return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: amt } };
  }

  const quoted = attempt(() => quote(world.pool, sell, amt, world.constants.swapFeeBps));
  if (quoted.code) return { code: quoted.code };
  const { out, newPool } = quoted.value;
  // Every swap carries minOut and a fill at a price the screen never showed is
  // refused rather than executed. The pool reprices on every trade, so somebody
  // traded between the quote and this act arriving; the trade the caller asked
  // for no longer exists at that price.
  if (out < minOut) return { code: 'SLIPPAGE_EXCEEDED', detail: { out, minOut } };

  return {
    commit(w) {
      const a = w.accounts[act.as];
      if (sell === 'btc') {
        a.sat -= amt;
        a.ptp += out;
      } else {
        a.ptp -= amt;
        a.sat += out;
      }
      w.pool = newPool;
    },
  };
});

define('liqAdd', ['sat', 'ptp'], (world, act) => {
  const sat = readWei(act.sat);
  const ptp = readWei(act.ptp);
  if (sat === null || sat === 0n || ptp === null || ptp === 0n) return { code: 'BAD_AMOUNT' };
  const account = world.accounts[act.as];
  if (account.sat < sat) return { code: 'INSUFFICIENT_RESERVE', detail: { have: account.sat, need: sat } };
  if (account.ptp < ptp) return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: ptp } };

  const added = attempt(() => addLiquidity(world.pool, sat, ptp));
  if (added.code) return { code: added.code };
  const { shares, used, newPool } = added.value;
  // Only the PROPORTIONAL part of the offer is taken. The skewed remainder is
  // simply not spent — there is nothing to refund and so no refund path to get
  // wrong — which is what stops a lopsided deposit from repricing the pool and
  // minting shares against the providers already in it.
  return {
    commit(w) {
      const a = w.accounts[act.as];
      a.sat -= used.sat;
      a.ptp -= used.ptp;
      a.shares += shares;
      w.pool = newPool;
    },
  };
});

define('liqRemove', ['shares'], (world, act) => {
  const shares = readWei(act.shares);
  if (shares === null || shares === 0n) return { code: 'BAD_AMOUNT' };
  const account = world.accounts[act.as];
  if (account.shares < shares) {
    return { code: 'INSUFFICIENT_SHARES', detail: { have: account.shares, need: shares } };
  }
  const removed = attempt(() => removeLiquidity(world.pool, shares));
  if (removed.code) return { code: removed.code };
  const { sat, ptp, newPool } = removed.value;
  return {
    commit(w) {
      const a = w.accounts[act.as];
      a.shares -= shares;
      a.sat += sat;
      a.ptp += ptp;
      w.pool = newPool;
    },
  };
});

// ── publishing ─────────────────────────────────────────────────────────────

define('post', ['cid', 'bytes', 'mime', 'w', 'h', 'viewPriceNano', 'days'], (world, act) => {
  const params = world.constants;
  const bytes = readIndex(act.bytes);
  const w = readIndex(act.w);
  const h = readIndex(act.h);
  const days = readIndex(act.days);
  const price = readWei(act.viewPriceNano);

  if (typeof act.cid !== 'string' || !HEX64_RE.test(act.cid)) return { code: 'BAD_REQUEST' };
  // A cid is checked for being UNUSED, not merely well formed, and this is the
  // whole of a closed attack rather than a tidiness rule. A cid addresses bytes,
  // and settlement redacts by cid: the host unlinks the object and every client
  // is told to forget it. So two unsettled posts under one cid share one
  // deletion — publish a one-day copy of a stranger's cid, let it lapse, settle
  // it, and her thirty-day lease is a 404 that her viewers are still being
  // billed for, all for one publish fee of 0.002 EUR.
  //
  // The index lives in the world, beside `burns`, and not as a reference count
  // in the media store. A reference count would be held by the host and by the
  // browser separately, and the two would disagree about whether a post is
  // publishable — which is exactly the fork ARCHITECTURE rule 2 exists to
  // prevent. Here all three readers refuse the same act for the same reason.
  const holder = world.cids[act.cid];
  if (holder) return { code: 'CID_IN_USE', detail: { cid: act.cid, heldBy: holder } };
  if (typeof act.mime !== 'string' || !MIME_ALLOWED.has(act.mime)) return { code: 'MIME_REFUSED' };
  if (bytes === null || bytes === 0) return { code: 'BAD_REQUEST' };
  if (bytes > MAX_PAYLOAD_BYTES) return { code: 'PAYLOAD_TOO_LARGE', detail: { bytes, max: MAX_PAYLOAD_BYTES } };
  if (w === null || h === null || w === 0 || h === 0 || w > 65535 || h > 65535) return { code: 'BAD_REQUEST' };
  if (days === null || days === 0 || days > 365) return { code: 'BAD_REQUEST' };
  if (price === null) return { code: 'BAD_AMOUNT' };
  // The band is the poster's to price inside and it is bounded, because an
  // unbounded band is a weapon. Outside it the act is malformed, not underpaid.
  if (price < params.viewPriceMinNanoEur || price > params.viewPriceMaxNanoEur) {
    return {
      code: 'BAD_REQUEST',
      detail: { viewPriceNano: price, min: params.viewPriceMinNanoEur, max: params.viewPriceMaxNanoEur },
    };
  }

  const rate = world.epoch.oracle;
  const priced = attempt(() => {
    const fee = priceOf(params.publishBaseFeeNanoEur, rate);
    const rentNano = rentNanoEur(bytes, days, params);
    const rent = priceOf(rentNano, rate);
    return { fee, rent, rentNano };
  });
  if (priced.code) return { code: priced.code };
  const { fee, rent, rentNano } = priced.value;

  const account = world.accounts[act.as];
  const total = fee.wei + rent.wei;
  if (account.ptp < total) return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: total } };

  const capUnits = capUnitsFor(bytes, days, params);
  if (account.cap < capUnits) {
    return { code: 'INSUFFICIENT_CAP', detail: { have: account.cap, need: capUnits } };
  }

  // The publish fee has no creator leg — a poster may not pay themselves, which
  // would be a faucet needing no viewer at all — so it splits three ways over the
  // renormalised vector. The RENT is not split: it goes whole into this post's
  // own capacity escrow, which is what makes the capacity leg unfarmable.
  const split = attempt(() => splitFee(fee.wei, splitVectorsOf(params).publish));
  if (split.code) return { code: split.code };
  const legs = split.value;

  const pid = `p${world.seq.post + 1}`;
  const created = act.t;
  const expires = created + days * Number(params.postDefaultLifetimeSec) * 1000;

  return {
    commit(wld) {
      const a = wld.accounts[act.as];
      a.ptp -= total;
      a.cap -= capUnits;
      wld.seq.post += 1;
      wld.supply.burned += legs.burn;
      wld.epoch.burnedWei += legs.burn;
      wld.treasury.ptp += legs.treasury;
      wld.capacity.potPtp += legs.capacity + rent.wei;
      wld.posts[pid] = {
        author: act.as,
        cid: act.cid,
        bytes,
        mime: act.mime,
        w,
        h,
        viewPriceNano: price,
        created,
        expires,
        state: 'live',
        redacted: false,
        // Set when any act priced against this post converted at the underflow
        // floor. False here rather than absent, so the field is a fact about
        // every post and not a fact about the ones that reached the floor.
        dust: false,
        views: 0,
        uniqueViewers: 0,
        likes: 0,
        comments: 0,
        grossNano: 0n,
        creditWei: 0n,
        paidWei: 0n,
        capUnits,
        claimedUnits: 0n,
        rentNano,
        escrow: { holdingWei: rent.wei, servingWei: legs.capacity },
        proofs: bare(),
        tombstone: null,
      };
      wld.cids[act.cid] = pid;
      recordDust(wld, fee.dust || rent.dust, pid);
    },
  };
});

define('extend', ['pid', 'days'], (world, act) => {
  const params = world.constants;
  const days = readIndex(act.days);
  const post = typeof act.pid === 'string' ? world.posts[act.pid] : undefined;
  if (!post) return { code: 'POST_NOT_FOUND' };
  if (post.state === 'settled') return { code: 'EXTEND_ON_SETTLED' };
  if (post.author !== act.as) return { code: 'NOT_THE_AUTHOR' };
  if (days === null || days === 0 || days > 365) return { code: 'BAD_REQUEST' };

  const rentNano = rentNanoEur(post.bytes, days, params);
  const priced = attempt(() => priceOf(rentNano, world.epoch.oracle));
  if (priced.code) return { code: priced.code };
  const rent = priced.value;

  const account = world.accounts[act.as];
  if (account.ptp < rent.wei) return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: rent.wei } };
  const capUnits = capUnitsFor(post.bytes, days, params);
  if (account.cap < capUnits) return { code: 'INSUFFICIENT_CAP', detail: { have: account.cap, need: capUnits } };

  // Days are added to the lease that was bought, not to the moment of the act.
  // Rent buys storage days; a post extended an hour after it lapsed has been held
  // for that hour, and paying from `now` would quietly hand back the gap.
  const expires = post.expires + days * Number(params.postDefaultLifetimeSec) * 1000;

  return {
    commit(wld) {
      const a = wld.accounts[act.as];
      a.ptp -= rent.wei;
      a.cap -= capUnits;
      const p = wld.posts[act.pid];
      p.expires = expires;
      p.capUnits += capUnits;
      p.rentNano += rentNano;
      p.escrow.holdingWei += rent.wei;
      wld.capacity.potPtp += rent.wei;
      recordDust(wld, rent.dust, act.pid);
    },
  };
});

// ── engagement ─────────────────────────────────────────────────────────────

/**
 * Everything a view, a like and a comment have in common: the post has to be
 * live, the payer may not be the author, and the fee is the poster's own price
 * converted at the epoch's sealed rate and split four ways.
 *
 * The creator leg accrues to the post as a PTP QUANTITY, fixed here, at act time.
 * It is NOT a euro liability converted when the post settles, and that is the
 * single most-reported finding in five independent stress passes: a euro credit
 * settled later is a free option on the pool — depress the price, settle, restore
 * — with a break-even around 1.58 EUR of credit and many posts settling inside
 * one depression. The wei the viewer actually paid are the wei the creator is
 * owed.
 *
 * So the PAYMENT reads no rate at all. Settlement still converts one number, the
 * euro payout floor, and that conversion decides only whether a dust credit is
 * paid or destroyed — it can move dust between the creator and the burn and it
 * cannot change the size of a payout by a single wei.
 */
function engagementPlan(world, act, kind) {
  const params = world.constants;
  const post = typeof act.pid === 'string' ? world.posts[act.pid] : undefined;
  if (!post) return { code: 'POST_NOT_FOUND' };
  if (post.state === 'settled') return { code: 'POST_ALREADY_SETTLED' };
  if (!isLive(post, act.t)) return { code: 'POST_NOT_LIVE', detail: { expires: post.expires, at: act.t } };
  // Refused at the door rather than silently credited nothing: an accepted
  // self-engagement would move money out of the payer and credit it back to
  // nobody, and the meter and the reward have to agree.
  if (post.author === act.as) return { code: 'SELF_ENGAGEMENT' };

  const priced = attempt(() => {
    const nanoEur = actionPriceNanoEur(post.viewPriceNano, kind, params);
    return { nanoEur, ...priceOf(nanoEur, world.epoch.oracle) };
  });
  if (priced.code) return { code: priced.code };
  const fee = priced.value;

  const account = world.accounts[act.as];
  if (account.ptp < fee.wei) {
    return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: fee.wei } };
  }

  const split = attempt(() => splitFee(fee.wei, splitVectorsOf(params).fee));
  if (split.code) return { code: split.code };

  return { post, fee, legs: split.value };
}

/** Move an engagement fee. Assignment only — every number was computed in
 * `prepare`, so nothing here can throw and nothing can be half-done. */
function commitEngagement(wld, act, plan) {
  const { fee, legs } = plan;
  const post = wld.posts[act.pid];
  wld.accounts[act.as].ptp -= fee.wei;
  post.grossNano += fee.nanoEur;
  post.creditWei += legs.creator;
  post.escrow.servingWei += legs.capacity;
  wld.capacity.potPtp += legs.capacity;
  wld.treasury.ptp += legs.treasury;
  wld.supply.burned += legs.burn;
  wld.epoch.burnedWei += legs.burn;
  recordDust(wld, fee.dust, act.pid);
}

define('view', ['pid', 'dwellMs', 'seq', 'vp'], (world, act) => {
  const params = world.constants;
  const dwellMs = readIndex(act.dwellMs);
  const seq = readIndex(act.seq);
  if (dwellMs === null || seq === null) return { code: 'BAD_REQUEST' };

  // A billable impression is 60% of the viewport for 1500 continuous
  // milliseconds. Replay can check the dwell the act carries and cannot check the
  // viewport at all — ARCHITECTURE §4's field list gives the view act no viewport
  // field, so `vp` is accepted when a client reports it and the rule is enforced
  // then. Both numbers are the VIEWER's own attestation either way, and the
  // viewer is the party the rule protects: it exists so that scrolling past a
  // picture does not cost money, and an inflated attestation only bills the
  // person who signed it.
  if (BigInt(dwellMs) < params.viewDwellMs) {
    return { code: 'VIEW_DWELL_TOO_SHORT', detail: { dwellMs, need: params.viewDwellMs } };
  }
  if (act.vp !== undefined) {
    const vp = readIndex(act.vp);
    if (vp === null || vp > 100) return { code: 'BAD_REQUEST' };
    if (BigInt(vp) < params.viewMinViewportPct) {
      return { code: 'VIEW_DWELL_TOO_SHORT', detail: { viewportPct: vp, need: params.viewMinViewportPct } };
    }
  }

  const account = world.accounts[act.as];
  // The per-viewer sequence must advance. The act is signed, so a replayed body
  // is otherwise a perfectly valid second charge; the sequence is what makes a
  // captured view act worthless to whoever captured it.
  if (seq <= account.viewSeq) {
    return { code: 'VIEW_SEQ_REPLAY', detail: { seq, last: account.viewSeq } };
  }

  const plan = engagementPlan(world, act, 'view');
  if (plan.code) return plan;

  const key = pairKey(act.as, act.pid);
  const pair = world.views[key];
  if (pair) {
    const elapsedMs = BigInt(act.t - pair.at);
    if (elapsedMs < params.viewCooldownSec * MS_PER_SEC) {
      return {
        code: 'VIEW_TOO_SOON',
        detail: { sinceMs: Number(elapsedMs), needMs: Number(params.viewCooldownSec * MS_PER_SEC) },
      };
    }
    // The cap counts inside the epoch only, so a stale entry from an earlier
    // epoch starts again at zero without the close having to walk the ledger.
    const n = pair.epoch === world.epoch.n ? pair.n : 0;
    if (BigInt(n) >= params.maxViewsPerPairPerEpoch) {
      return { code: 'VIEW_PAIR_CAP', detail: { n, cap: params.maxViewsPerPairPerEpoch } };
    }
  }

  return {
    commit(wld) {
      commitEngagement(wld, act, plan);
      const p = wld.posts[act.pid];
      p.views += 1;
      const prev = wld.views[key];
      // A unique viewer is a person who has BILLABLY VIEWED this post, and the
      // pair entry can already exist because they liked it first — so the flag is
      // on the view, not on the entry.
      if (!prev || !prev.viewed) p.uniqueViewers += 1;
      const n = prev && prev.epoch === wld.epoch.n ? prev.n : 0;
      wld.views[key] = {
        at: act.t,
        n: n + 1,
        epoch: wld.epoch.n,
        viewed: true,
        liked: Boolean(prev && prev.liked),
      };
      wld.accounts[act.as].viewSeq = seq;
    },
  };
});

define('like', ['pid'], (world, act) => {
  const plan = engagementPlan(world, act, 'like');
  if (plan.code) return plan;
  const key = pairKey(act.as, act.pid);
  // One like per (person, post), ever. A like is a signal and a second one says
  // nothing new; charging for it would be per-impression billing wearing a
  // signal's clothes.
  if (world.views[key] && world.views[key].liked) {
    return { code: 'DUPLICATE_ACT', detail: { pid: act.pid, liked: true } };
  }
  return {
    commit(wld) {
      commitEngagement(wld, act, plan);
      wld.posts[act.pid].likes += 1;
      const prev = wld.views[key];
      // A like that arrives before any view opens the pair entry with a zero
      // stamp and a zero count, so it neither starts a cooldown nor spends one of
      // the pair's billable views. The two limits are about views.
      wld.views[key] = prev
        ? { ...prev, liked: true }
        : { at: 0, n: 0, epoch: wld.epoch.n, viewed: false, liked: true };
    },
  };
});

define('comment', ['pid', 'text'], (world, act) => {
  const { text } = act;
  if (typeof text !== 'string' || text.length === 0) return { code: 'BAD_REQUEST' };
  if (text.length > MAX_COMMENT_CHARS) {
    return { code: 'COMMENT_TOO_LONG', detail: { length: text.length, max: MAX_COMMENT_CHARS } };
  }
  const plan = engagementPlan(world, act, 'comment');
  if (plan.code) return plan;
  const cid = `c${world.seq.comment + 1}`;
  return {
    commit(wld) {
      commitEngagement(wld, act, plan);
      wld.posts[act.pid].comments += 1;
      wld.seq.comment += 1;
      wld.comments[cid] = { pid: act.pid, author: act.as, text, at: act.t };
    },
  };
});

// ── settlement ─────────────────────────────────────────────────────────────

define('settle', ['pid'], (world, act) => {
  const params = world.constants;
  const post = typeof act.pid === 'string' ? world.posts[act.pid] : undefined;
  if (!post) return { code: 'POST_NOT_FOUND' };
  if (post.state === 'settled') return { code: 'POST_ALREADY_SETTLED' };

  const opensAt = post.expires + Number(params.settlementGraceSec) * 1000;
  if (act.t < opensAt) return { code: 'SETTLE_BEFORE_GRACE', detail: { opensAt, at: act.t } };
  // Anybody may settle, and NOT_THE_AUTHOR deliberately does not apply: a network
  // where deletion depends on the author showing up is a network that never
  // deletes. The grace window is what gives the author their chance first.

  const floor = attempt(() => nanoEurToPtpWei(params.minSettlementNanoEur, world.epoch.oracle));
  if (floor.code) return { code: floor.code };

  // The floor gates the PAYOUT and never the act. If it gated the act, a post
  // earning less than one view could never settle, its picture would never be
  // redacted and its CAP never released — and pinning a terabyte on other
  // members' devices forever would cost an attacker 1,006 EUR once. Below the
  // floor the credit sweeps to burn and the post settles anyway.
  const paid = post.creditWei >= floor.value ? post.creditWei : 0n;
  const swept = post.creditWei - paid;
  // Whatever is left in the escrows is destroyed rather than shared out. The
  // holding escrow was funded for REPLICATION copies; where fewer proved, paying
  // the survivors a bonus would make under-replication profitable.
  const surplus = post.escrow.holdingWei + post.escrow.servingWei;

  return {
    commit(wld) {
      const p = wld.posts[act.pid];
      if (paid > 0n) wld.accounts[p.author].ptp += paid;
      const destroyed = swept + surplus;
      wld.supply.burned += destroyed;
      wld.epoch.burnedWei += destroyed;
      wld.capacity.potPtp -= surplus;
      p.paidWei = paid;
      p.creditWei = 0n;
      p.escrow.holdingWei = 0n;
      p.escrow.servingWei = 0n;
      p.state = 'settled';
      // Redaction takes the PAYLOAD and leaves the STRUCTURE. Replay holds no
      // bytes, so here it is the instruction and the record of it: server/media
      // deletes the shards, the client's service worker is told to FORGET the
      // cid, and what remains is this tombstone — author, cid, byte length,
      // dimensions, lifetime, totals, and what was paid. It proves a picture
      // existed and exactly which bytes it was, without the bytes.
      p.redacted = true;
      // The cid is released at the instant the bytes are. Settlement is what
      // tells every node to forget them, so from here the cid addresses nothing
      // this world holds and the next poster of those bytes is publishing them
      // rather than sharing somebody's live lease. The guard is on the holder
      // and not on the key, so a settle can only ever release its own claim.
      if (wld.cids[p.cid] === act.pid) delete wld.cids[p.cid];
      p.tombstone = {
        at: act.t,
        epoch: wld.epoch.n,
        by: act.as,
        author: p.author,
        cid: p.cid,
        bytes: p.bytes,
        mime: p.mime,
        w: p.w,
        h: p.h,
        created: p.created,
        expires: p.expires,
        views: p.views,
        uniqueViewers: p.uniqueViewers,
        likes: p.likes,
        comments: p.comments,
        grossNano: p.grossNano,
        paidWei: paid,
        burnedWei: destroyed,
      };
    },
  };
});

// ── capacity ───────────────────────────────────────────────────────────────

define('capBuy', ['ptp'], (world, act) => {
  const params = world.constants;
  const ptp = readWei(act.ptp);
  if (ptp === null || ptp === 0n) return { code: 'BAD_AMOUNT' };
  const account = world.accounts[act.as];
  if (account.ptp < ptp) return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: ptp } };

  // CAP is bought at the rent tariff — the only rate in the parameter file that
  // prices an MB-day — through ONE fused rational from wei to CAP units, and
  // truncated down. The nanoeuro is never materialised: `ptpWeiToNanoEur` is a
  // display and audit conversion that floors at 1 n€, and settling a mint
  // through that floor turned one wei into 500 CAP units. See capUnitsForWei.
  const converted = attempt(() => capUnitsForWei(ptp, world.epoch.oracle, params));
  if (converted.code) return { code: converted.code };
  const capUnits = converted.value;
  if (capUnits === 0n) return { code: 'DUST_BELOW_MINIMUM', detail: { ptp } };

  return {
    commit(wld) {
      wld.accounts[act.as].ptp -= ptp;
      wld.accounts[act.as].cap += capUnits;
      // THE PURCHASE IS DESTROYED, NOT POOLED, and this is the resolution of a
      // contradiction rather than a preference. The capacity pot is not a pot:
      // `capacityPayout` is perPostEscrow, every payout in `capClaim` is bounded
      // by the escrows of the post that was proved, and both of those escrows
      // are funded by that post's own rent and its own engagement — the two
      // sources docs/ECONOMICS.md names and the only two. So PTP paid in here
      // funded no escrow, could be drawn by nobody, and simply sat in the world
      // forever while not counting as burned: a supply figure that overstated
      // what anybody could spend, growing with every purchase.
      //
      // The other repair — routing the purchase into the post's holding escrow
      // at publish time — was rejected on the arithmetic. The holding escrow is
      // the rent, and `capacityHoldingCapNanoEurPerMbDay` equals
      // `storageRentNanoEurPerMbDay` so that a provider cannot draw more rent
      // than was paid; adding the CAP price to it would double that line and
      // break the cap it is defined by.
      //
      // Destroying it keeps every property: the accounting identity closes
      // (genesis + minted − burned = circulating + pot, with pot the sum of the
      // escrows exactly), deflation is strengthened rather than weakened, and
      // CAP stays what ARCHITECTURE §1 calls it — protocol-minted against PTP
      // that is gone.
      //
      // It is NOT added to `epoch.burnedWei`, which is the emission rail's
      // input. Emission is a rebate on the burn that engagement with a
      // creator's own pictures caused, and a CAP purchase has no creator and is
      // nobody's fee; letting it lift the rail would let any account raise the
      // epoch's emission ceiling by destroying its own money. Leaving it out can
      // only lower emission, which is the direction every bound in
      // docs/ECONOMICS.md is stated in, and it puts this destruction where the
      // publish fee's burn already is: real, and credited to nobody.
      wld.supply.burned += ptp;
    },
  };
});

define('capPledge', ['mb', 'endpoint'], (world, act) => {
  const params = world.constants;
  const mb = readIndex(act.mb);
  const { endpoint } = act;
  if (mb === null || mb === 0 || mb > 1000000) return { code: 'BAD_REQUEST' };
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 256) {
    return { code: 'BAD_REQUEST' };
  }

  const existing = world.capacity.providers[act.as];
  // THE BOND HAS A PER-IDENTITY FLOOR, and it is what makes the published figure
  // true. `capPledgeBondNanoEurPerGb` prices GIGABYTES, while placement and
  // payment rank IDENTITIES — so an attacker pledging the smallest lawful
  // capacity paid per gigabyte for a lever priced per node id. Measured on the
  // shipped edition: twenty invented ids at 1 MB each cost 0.004 EUR against
  // 20.00 EUR for one honest 100 GB pledge, which is 0.02% of it, and
  // docs/ECONOMICS.md's own worked figure for the same attack is 10 EUR. The
  // floor is `newAccountBondNanoEur` — 0.50 EUR, the parameter whose stated
  // purpose is pricing puppets — so twenty ids now cost exactly the 10 EUR that
  // document quotes, whatever they pledge.
  //
  // The requirement is cumulative and the charge is the shortfall against what
  // this identity has already posted, so re-announcing the same capacity costs
  // nothing, growing it costs the difference, and shrinking it refunds nothing —
  // a bond that comes back prices nothing, which is why
  // `capPledgeBondSlashable` is true.
  const paidNano = existing && existing.bondNano ? existing.bondNano : 0n;
  const sizedNano = ceilDiv(BigInt(mb) * params.capPledgeBondNanoEurPerGb, 1000n);
  const requiredNano = sizedNano > params.newAccountBondNanoEur ? sizedNano : params.newAccountBondNanoEur;
  const dueNano = requiredNano > paidNano ? requiredNano - paidNano : 0n;
  const priced = attempt(() =>
    dueNano === 0n ? { nanoEur: 0n, wei: 0n, dust: false } : priceOf(dueNano, world.epoch.oracle),
  );
  if (priced.code) return { code: priced.code };
  const bond = priced.value;

  const account = world.accounts[act.as];
  if (account.ptp < bond.wei) return { code: 'INSUFFICIENT_PTP', detail: { have: account.ptp, need: bond.wei } };

  const bondedNano = requiredNano > paidNano ? requiredNano : paidNano;

  return {
    commit(wld) {
      wld.accounts[act.as].ptp -= bond.wei;
      wld.capacity.bondsPtp += bond.wei;
      const row = wld.capacity.providers[act.as] || {
        mb: 0,
        mbDays: 0n,
        proven: 0n,
        paidPtp: 0n,
        bondPtp: 0n,
        bondNano: 0n,
        provenEpoch: 0,
        provenInEpoch: 0n,
        endpoint: '',
      };
      row.mb = mb;
      row.endpoint = endpoint;
      row.bondPtp += bond.wei;
      // The euro high-water mark, kept because the bond is charged against what
      // was required and not against what the pool happened to cost that day. A
      // wei figure would let a pledge re-announced at a higher token price look
      // underpaid and be charged twice for capacity it already bonded.
      row.bondNano = bondedNano;
      wld.capacity.providers[act.as] = row;
      recordDust(wld, bond.dust);
    },
  };
});

define('capProof', ['challenge', 'answer'], (world, act) => {
  const params = world.constants;
  const { challenge, answer } = act;
  if (!isPlainObject(challenge)) return { code: 'BAD_REQUEST' };
  const shard = readIndex(challenge.shard);
  if (shard === null || typeof challenge.pid !== 'string') return { code: 'BAD_REQUEST' };
  if (typeof answer !== 'string' || !HEX64_RE.test(answer)) return { code: 'BAD_REQUEST' };

  const provider = world.capacity.providers[act.as];
  if (!provider || provider.mb === 0) return { code: 'CAPACITY_PLEDGE_UNPROVEN' };

  const post = world.posts[challenge.pid];
  if (!post) return { code: 'POST_NOT_FOUND' };
  if (!isLive(post, act.t)) return { code: 'POST_NOT_LIVE' };
  const shards = Math.ceil(post.bytes / SHARD_BYTES);
  if (shard >= shards) return { code: 'BAD_REQUEST', detail: { shard, shards } };

  // Placement is rendezvous hashing over the live pledged set, WEIGHTED BY WHAT
  // EACH NODE PLEDGED, so every reader computes the same holders for a shard
  // with no coordinator and a node's share of the network's placements is its
  // share of the network's pledged megabytes. A proof for a shard you were not
  // assigned earns nothing, because it improves the replication of nothing.
  const placed = attempt(() => placementFor(world, post.cid, shard, Number(params.replication)));
  if (placed.code) return { code: placed.code };
  if (!placed.value.includes(act.as)) {
    return { code: 'CAPACITY_NOT_PLACED', detail: { pid: challenge.pid, shard } };
  }

  // One accepted proof per (node, post, shard) per epoch. An epoch is a day and
  // the accrual is MB-days, so a second proof inside the same day would be paid
  // for a day that was already paid for.
  const proofKey = `${act.as}|${shard}|${world.epoch.n}`;
  if (post.proofs[proofKey]) return { code: 'DUPLICATE_ACT', detail: { pid: challenge.pid, shard } };

  // WHAT REPLAY CANNOT CHECK, and it is the important half: the answer itself.
  // The challenge is sha256 of a 4 KiB window of the shard, and replay holds no
  // bytes — it has the cid and nothing the cid addresses. Whoever holds a
  // complete copy verifies the answer and refuses with CAPACITY_PROOF_WRONG
  // before the act is appended, and the latency bound that distinguishes three
  // disks from one disk pretending to be three is a measurement no pure function
  // can make. What replay holds is the part that must be identical for every
  // reader: that this node was assigned this shard, and that it is credited once.
  const bytesInShard = Math.min(SHARD_BYTES, post.bytes - shard * SHARD_BYTES);
  const units = ceilDiv(BigInt(bytesInShard) * params.capCoinPerMbDay, BYTES_PER_MB);

  // WHAT IS PROVEN IS CAPPED BY WHAT WAS PLEDGED. One CAP is one megabyte-day
  // and an epoch is a day, so a pledge of M megabytes can honestly earn at most
  // M CAP between two closes — mb × capCoinPerMbDay, in the same units the
  // proof accrues. Without the ceiling the pledge was a number that priced a
  // bond and bounded nothing: a node announcing one megabyte could answer for
  // every shard placement it won and draw against every one of them, so the
  // cheapest possible identity earned like the most expensive one.
  //
  // The window is the EPOCH and not the lifetime, because the unit says so: a
  // megabyte-day is a day's work by a megabyte, and a lifetime ceiling would
  // refuse an honest device its second day. It is read the way the (viewer,
  // post) ledger reads its own cap — an entry stamped with an older epoch counts
  // as zero — so a close resets every provider without walking the table.
  const allowance = BigInt(provider.mb) * params.capCoinPerMbDay;
  const provenInEpoch =
    provider.provenEpoch === world.epoch.n && provider.provenInEpoch ? provider.provenInEpoch : 0n;
  if (provenInEpoch + units > allowance) {
    return {
      code: 'CAPACITY_OVER_PLEDGE',
      detail: { units, provenInEpoch, allowance, pledgedMb: provider.mb },
    };
  }

  return {
    commit(wld) {
      const p = wld.posts[challenge.pid];
      p.proofs[proofKey] = { by: act.as, shard, units, at: act.t, claimed: false };
      const row = wld.capacity.providers[act.as];
      row.proven += units;
      row.mbDays += units;
      row.provenEpoch = wld.epoch.n;
      row.provenInEpoch = provenInEpoch + units;
    },
  };
});

define('capClaim', [], (world, act) => {
  const provider = world.capacity.providers[act.as];
  if (!provider) return { code: 'CAPACITY_PLEDGE_UNPROVEN' };

  // Paid PER POST, out of that post's own escrow, and never out of a global pot.
  // A pot divided pro rata by bytes stored pays for something cheap to
  // manufacture: at 1,000 DAU a griefer holding 90% of the network's bytes with
  // pictures nobody looks at spends 0.1449 EUR a day and extracts 0.6677, a 361%
  // return, while diluting every honest provider. Per post the same attack yields
  // 0.0189 against the same cost and loses.
  //
  // A draw is the escrow STILL UNDRAWN, in proportion to the units STILL
  // UNCLAIMED — not to the units the post was funded for. The difference is the
  // whole of the fairness of this payout, and the obvious form gets it wrong:
  //
  //   share = escrowLeft × myUnits / capUnits
  //
  // pays three nodes that did identical work 1/3, 2/9 and 4/27 of the escrow,
  // because each claim measures against an escrow the previous claim already
  // reduced. Dividing what is left by what is left to claim pays them 1/3 each,
  // in any order, which is what identical work has to be worth.
  //
  //   share = escrowLeft × myUnits / unclaimedUnits
  //
  // It is also self-limiting in both directions. Money that arrives after an
  // earlier claim is shared by whoever is left, in proportion. And a post can be
  // proved for more shard-epochs than it funded — proofs accrue per epoch while
  // funding is per day of lease, so a post created mid-epoch straddles one close
  // more than it paid for — after which `unclaimedUnits` is zero and the extra
  // proofs draw nothing at all. The CAP for them is still minted, and correctly:
  // the node did hold those bytes. What ran out is the post's funding, not the
  // service.
  //
  // Truncated down, so the remainder stays in the escrow and is destroyed at
  // settlement. That is what makes under-replication cost money instead of paying
  // the survivors a bonus for it.
  const draws = [];
  const running = new Map();
  let total = 0n;
  let minted = 0n;
  for (const pid of Object.keys(world.posts)) {
    const post = world.posts[pid];
    if (post.state !== 'live') continue;
    for (const key of Object.keys(post.proofs)) {
      const proof = post.proofs[key];
      if (proof.by !== act.as || proof.claimed) continue;
      if (!running.has(pid)) {
        running.set(pid, {
          holding: post.escrow.holdingWei,
          serving: post.escrow.servingWei,
          claimed: post.claimedUnits,
        });
      }
      const left = running.get(pid);
      const unclaimed = post.capUnits > left.claimed ? post.capUnits - left.claimed : 0n;
      const units = proof.units > unclaimed ? unclaimed : proof.units;
      const share = unclaimed > 0n ? ((left.holding + left.serving) * units) / unclaimed : 0n;
      // Rent first, then the engagement share. The holding leg is capped at the
      // tariff that funded it by construction — it IS the rent that was charged.
      const holding = share > left.holding ? left.holding : share;
      const serving = share - holding;
      left.holding -= holding;
      left.serving -= serving;
      left.claimed += units;
      draws.push({ pid, key, holding, serving, units });
      total += share;
      minted += proof.units;
    }
  }
  if (draws.length === 0) return { code: 'CAPACITY_PLEDGE_UNPROVEN' };
  // Nothing to draw is refused rather than paid as zero, and the proofs are left
  // unclaimed. A post whose escrow is still empty will have one later, and the
  // catalogue promises exactly that: proven MB-days are recorded and still count
  // against the next non-empty escrow. Accepting the act would consume them for
  // nothing.
  if (total === 0n) return { code: 'CAPACITY_POT_EMPTY', detail: { proofs: draws.length } };

  return {
    commit(wld) {
      for (const d of draws) {
        const p = wld.posts[d.pid];
        p.escrow.holdingWei -= d.holding;
        p.escrow.servingWei -= d.serving;
        p.claimedUnits += d.units;
        p.proofs[d.key].claimed = true;
      }
      wld.capacity.potPtp -= total;
      const a = wld.accounts[act.as];
      a.ptp += total;
      // capClaim mints CAP for proven MB-days as well as drawing the escrow —
      // ARCHITECTURE §4's table gives it both effects. The receipt and the
      // payment are different things: the PTP is what the work earned, the CAP is
      // the record that the capacity existed.
      a.cap += minted;
      const row = wld.capacity.providers[act.as];
      row.paidPtp += total;
    },
  };
});

// ── the rule key ───────────────────────────────────────────────────────────

define('rulesSet', ['version', 'hash', 'fromEpoch'], (world, act) => {
  const { version, hash } = act;
  const fromEpoch = readIndex(act.fromEpoch);
  // One named address may send this act, and it can change how the emission is
  // divided and nothing else: it cannot mint, cannot move a balance, cannot touch
  // the pool and cannot alter a sealed block. Narrowing the key to exactly one
  // act is what makes it survivable that the key exists. With no key named, the
  // act is refused from every address — an unnamed key cannot be impersonated.
  if (!world.rules.key || world.rules.key !== act.as) {
    return { code: 'RULES_KEY_ONLY', detail: { key: world.rules.key } };
  }
  if (typeof version !== 'string' || !Object.prototype.hasOwnProperty.call(RULES_REGISTRY, version)) {
    return { code: 'RULES_VERSION_UNKNOWN', detail: { version } };
  }
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
    return { code: 'RULES_VERSION_UNKNOWN', detail: { hash } };
  }
  if (fromEpoch === null) return { code: 'BAD_REQUEST' };

  // REPLAY IS THE REAL GATE HERE, and this is the one place where that is not a
  // stylistic preference. PtpRules compares fromEpoch against the SEALED HORIZON,
  // which lags the true epoch by an amount nothing on chain can measure, so the
  // contract will accept a schedule entry landing inside that lag and `rulesFor`
  // would then name a module for an epoch that ran under a different one. It is
  // not fixable in Solidity: the contract knows one number and it is the wrong
  // one. What the contract really guarantees is narrower — an answer is frozen
  // once the sealed horizon passes the epoch it answers for. The world state
  // knows the TRUE epoch, so the strict check lives here.
  if (fromEpoch <= world.epoch.n) {
    return { code: 'RULES_EPOCH_PAST', detail: { fromEpoch, epoch: world.epoch.n } };
  }

  return {
    commit(wld) {
      // Last write wins while the change is still in the future; a closed epoch
      // is never re-cut, which is exactly what the strict inequality above buys.
      wld.rules.next = { version, hash, setBy: act.as, fromEpoch };
    },
  };
});

// ── closing an epoch ───────────────────────────────────────────────────────

/** The median burn of the epochs that have already closed, which is the baseline
 * the emission spike rail measures against. No history means no baseline: the
 * rail is inactive rather than binding at zero, because a rule that emitted
 * nothing after seven quiet epochs would punish a network waking up. */
function medianBurn(history) {
  if (!history || history.length === 0) return 0n;
  const sorted = [...history].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

define('closeEpoch', ['oracle'], (world, act) => {
  const params = world.constants;
  // The genesis epoch's clock starts when its first act lands, not at the unix
  // epoch. A world where nothing has happened has no epoch to seal, and without
  // this the very first act of a network could be a close.
  if (world.epoch.startedAt === 0) return { code: 'EPOCH_NOT_CLOSED', detail: { acts: 0 } };
  const opensAt = world.epoch.startedAt + Number(params.epochSeconds) * 1000;
  // An epoch closes because an act landed after its length elapsed — not because
  // a clock said so, and not whenever somebody asks. Any registered account may
  // send it, the same way anybody may settle a lapsed post: in practice it is the
  // elected writer, and making it permissionless means a network whose writer is
  // asleep still closes its epochs. The time bound is what makes that safe.
  // Without it, closing on demand would reset every per-pair view counter at will
  // and walk the emission schedule forward for nothing.
  if (act.t < opensAt) return { code: 'EPOCH_NOT_CLOSED', detail: { opensAt, at: act.t } };
  if (act.oracle !== undefined && !isPlainObject(act.oracle)) return { code: 'BAD_REQUEST' };

  const module = RULES_REGISTRY[world.rules.version];
  if (!module) return { code: 'RULES_VERSION_UNKNOWN', detail: { version: world.rules.version } };

  // Emission is a per-creator rebate on burn actually caused, never a pot divided
  // by weight. Under a pot a self-dealer's recovery is creatorBps + kappa ×
  // burnBps × r, where r is their weight-per-euro advantage, and break-even is
  // r = 2.381 — a number the parameter set hands out three separate ways. Per
  // creator, r does not appear in the algebra at all: nobody competes for
  // anybody else's rebate, so an account can only ever be handed back a fraction
  // of what it itself destroyed.
  const computed = attempt(() => {
    const credited = module(world, world.epoch.acts);
    const rebates = new Map();
    for (const [addr, wei] of credited) rebates.set(addr, creatorRebate(wei));
    const median = medianBurn(world.history);
    return applyEpochRail(rebates, world.epoch.n, world.epoch.burnedWei, median);
  });
  if (computed.code) return { code: computed.code };
  const minted = computed.value;

  let total = 0n;
  for (const wei of minted.values()) total += wei;
  // The lifetime ceiling, defended rather than trusted. The schedule sums below
  // it in closed form and the coupling can only lower it, so this clamp is
  // unreachable by construction — which is exactly why it is cheap to keep.
  const room = params.maxSupplyPtp * WAD - world.supply.emitted;
  const allowed = total > room ? (room > 0n ? room : 0n) : total;

  const rate = attempt(() =>
    sealRate(world.pool, {
      eurPerBtcNano: (act.oracle && act.oracle.eurPerBtcNano) || world.epoch.oracle.eurPerBtcNano,
      sources: act.oracle && act.oracle.sources,
      prevEurPerBtcNano: world.epoch.oracle.eurPerBtcNano,
      epoch: world.epoch.n + 1,
    }),
  );
  if (rate.code) return { code: rate.code };

  return {
    commit(wld) {
      // Paid in full when the rebates fit under the rail, and scaled by the SAME
      // fraction for everybody when they do not — applyEpochRail does that, and
      // uniform scaling is what keeps the rail from quietly becoming a pot.
      let paid = 0n;
      for (const [addr, wei] of minted) {
        const share = allowed === total ? wei : (wei * allowed) / (total === 0n ? 1n : total);
        if (share === 0n) continue;
        if (!wld.accounts[addr]) continue;
        wld.accounts[addr].ptp += share;
        paid += share;
      }
      wld.supply.emitted += paid;

      const closed = wld.epoch.n;
      wld.history = [...(wld.history || []), wld.epoch.burnedWei].slice(
        -Number(params.emissionBurnSpikeMedianEpochs),
      );
      wld.epoch = {
        n: closed + 1,
        startedAt: act.t,
        closedAt: act.t,
        oracle: rate.value,
        burnedWei: 0n,
        acts: [],
      };
      // A scheduled rules change takes effect for FUTURE epochs only, and only
      // when the epoch it named arrives. Unemitted PTP is forfeited at the same
      // moment: it is not minted, not banked and not owed to a later epoch,
      // because a pot that outlives the epoch that funded it is the flat rule
      // wearing a different name.
      const next = wld.rules.next;
      if (next && next.fromEpoch <= wld.epoch.n) {
        wld.rules = { ...next, key: wld.rules.key, next: null };
      }
    },
  };
});

// ── the validator both readers use ─────────────────────────────────────────

/**
 * What is wrong with this act against this world, or null.
 *
 * The server calls it over its live world before appending. The browser calls the
 * SAME function before offering a button. The refusal sentence is identical in
 * both places because it comes from the same line of code and the same catalogue,
 * so a caller never has to parse an English sentence to learn what happened.
 *
 * It is pure: it reads the world and computes, and it assigns nothing. Running it
 * twice on one world gives the same answer, and running it never changes what
 * `applyAct` would do.
 */
export function actError(world, act) {
  try {
    const problem = envelopeProblem(world, act);
    if (problem) return problem;
    const plan = KINDS[act.k].prepare(world, actWithFoldedAddress(act));
    if (plan.code) return detail(plan.code, plan.detail);
    return null;
  } catch {
    // The same backstop `applyAct` carries, for the same inputs and with the same
    // answer — the two must agree on every act, including the ones that are not
    // really acts at all.
    return detail('BAD_REQUEST', { threw: true });
  }
}

/** Build the refusal body `actError` answers with: the catalogue's four fields
 * plus the numbers that make it concrete. */
function detail(code, extra) {
  const r = refuse(code, extra);
  return { code: r.code, msg: r.msg, why: r.why, next: r.next, detail: r.detail };
}

/**
 * The address is folded to one spelling before any rule reads it, so a
 * checksummed act and a lowercase one are the same account everywhere. The act
 * itself is never mutated — the log owns it, and a validator that edited its
 * input would make the second call disagree with the first.
 */
function actWithFoldedAddress(act) {
  const folded = readAddress(act.as);
  return folded === act.as ? act : { ...act, as: folded };
}

function envelopeProblem(world, act) {
  const shape = shapeProblem(act);
  if (shape) return detail(shape, { max: MAX_ACT_BYTES, maxDepth: MAX_ACT_DEPTH });

  if (typeof act.k !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, act.k)) {
    return detail('UNKNOWN_ACT_KIND', { kind: typeof act.k === 'string' ? act.k : null });
  }
  const spec = KINDS[act.k];
  for (const key of Object.keys(act)) {
    if (ENVELOPE.has(key) || spec.fields.has(key)) continue;
    return detail('BAD_REQUEST', { unexpectedField: key });
  }

  const as = readAddress(act.as);
  if (as === null) return detail('BAD_ADDRESS', { as: typeof act.as === 'string' ? act.as : null });

  const t = readIndex(act.t);
  if (t === null || t > MAX_TIMESTAMP) return detail('TIMESTAMP_IMPLAUSIBLE', { t: act.t });
  // Stamps may not go backwards. Replay cannot compare a stamp with a clock —
  // that bound is the writer's, at acceptance — but it can insist the log's own
  // order and its stamps agree, because cooldowns, expiry and epoch boundaries
  // are all read out of them.
  if (t < world.log.lastAt) return detail('TIMESTAMP_IMPLAUSIBLE', { t, lastAt: world.log.lastAt });

  // `i` is assigned by the writer on acceptance, so an act being validated before
  // it is accepted does not carry one yet. When it is present it must advance:
  // the same index twice is the same line twice, and one intent must not become
  // two entries.
  if (act.i !== undefined) {
    const i = readIndex(act.i);
    if (i === null) return detail('BAD_REQUEST', { i: act.i });
    if (i <= world.log.lastIndex) return detail('DUPLICATE_ACT', { i, lastIndex: world.log.lastIndex });
  }

  if (act.sig !== undefined && typeof act.sig !== 'string') return detail('BAD_REQUEST', { sig: null });

  // Every kind but `register` acts from an account that already exists: balances,
  // handles and post ownership are all keyed by registered address, so an act
  // from an address the world has never seen has no row to debit.
  if (act.k !== 'register' && !world.accounts[as]) return detail('UNKNOWN_ACCOUNT', { as });

  return null;
}

// ── applying ───────────────────────────────────────────────────────────────

/**
 * Apply one act, or refuse it whole.
 *
 * TOTAL. Either the act validates and every one of its effects lands, or nothing
 * happens at all: the world after a refusal is identical in content to the world
 * before it, no number becomes NaN, and no account is left half-written. That is
 * structural, not careful — `prepare` computes the whole effect while touching
 * nothing, and `commit` only assigns values that already exist, so there is no
 * point in between where the world is partly one thing and partly another.
 *
 * Returns `{ ok: true }` or the refusal body from core/errors.mjs, which carries
 * the stable code, what happened, the mechanism that produced it and the next
 * step — all four, always, so a bot never parses a sentence.
 */
export function applyAct(world, act) {
  let folded;
  let plan;
  // The backstop, and the reason it is drawn exactly here. Everything inside this
  // block READS: it validates and computes and assigns nothing, so a throw from it
  // cannot have left the world half-written. Exotic hosts — a Proxy whose traps
  // throw, a getter on a nested object — are the inputs that reach it; every
  // refusal a RULE produces already comes back as a catalogued code through
  // `attempt`, so a caught throw here is always a malformed act and never a
  // decision. `commit` is outside the block on purpose: a throw from there is a
  // bug in this file and must not be swallowed into a refusal that says the act
  // was bad.
  try {
    const problem = envelopeProblem(world, act);
    if (problem) return refuse(problem.code, problem.detail);
    folded = actWithFoldedAddress(act);
    plan = KINDS[act.k].prepare(world, folded);
  } catch {
    return refuse('BAD_REQUEST', { threw: true });
  }
  if (plan.code) return refuse(plan.code, plan.detail);

  plan.commit(world);

  world.log.lastIndex = act.i === undefined ? world.log.lastIndex + 1 : act.i;
  world.log.lastAt = folded.t;
  world.log.count += 1;
  // The genesis epoch begins with the act that begins the network. Every later
  // epoch begins at the close that opened it, which `closeEpoch` writes directly.
  if (world.epoch.startedAt === 0) world.epoch.startedAt = folded.t;
  if (world.accounts[folded.as]) world.accounts[folded.as].acts += 1;
  // The epoch keeps the acts that landed inside it. The distribution module is a
  // pure function of them (ARCHITECTURE §8), and the chain builder seals the same
  // range, so the two agree by construction rather than by coincidence.
  world.epoch.acts.push(folded);

  return { ok: true };
}

/**
 * Replay a log from nothing.
 *
 * The world is a pure function of the acts and the params edition — no clock, no
 * network, no randomness — so this is reproducible on any machine at any time,
 * which is the whole claim ARCHITECTURE rule 1 makes.
 *
 * An act that does not validate is SKIPPED, not fatal. A well-formed log contains
 * none, because the writer runs `actError` before appending; a hostile or
 * corrupted one must not be able to stop every reader in the network at the same
 * line, which is what throwing here would do. The count of what was skipped is
 * kept in `log.skipped` so the fact is visible rather than silent.
 */
export function replay(acts, params = PARAMS) {
  const world = emptyWorld(params);
  if (!Array.isArray(acts)) return world;
  for (const act of acts) {
    const result = applyAct(world, act);
    if (!result.ok) world.log.skipped += 1;
  }
  return world;
}
