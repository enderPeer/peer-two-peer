// One closed epoch, sealed into the block shape of ARCHITECTURE section 9.
//
// A block claims exactly one sentence: "at this close, the producer named here
// observed this ordered act range, computed this state from it under these
// constants and these formula editions, and signs that publication." It does not
// decide what is true — replay decides, hashes only carry. What the chain buys is
// that silent rewriting becomes detectable and publication becomes attributable,
// and that is all of it.
//
// ── EACH ACT IS COMMITTED TWICE, AND THAT IS THE WHOLE DESIGN ───────────────
//
// Deletion here is redaction: the payload bytes leave, the structure stays. A
// chain that hashed whole acts would read every lawful deletion as tampering, so
// every committed act produces two digests:
//
//   STRUCTURAL   sha256 over the act MINUS its payload fields (`cid`, `text`).
//                Invariant under every lawful deletion, because it never covered
//                the deleted fields in the first place. This is not a promise
//                about a future code path — it is arithmetic, and
//                test/chain.test.mjs strips both fields off a sealed act and
//                recomputes the same root.
//
//   PAYLOAD      sha256 over the structural digest together with the payload
//                fields. Sealed at close and simply KEPT afterwards: the retained
//                commitment residue. It proves a picture existed and exactly
//                which bytes it was, without the bytes. It is deliberately NOT
//                recomputable after redaction, which is why verification checks
//                the sealed list against its own root always and re-derives an
//                entry only where the payload survives.
//
// The payload commitment binds the structural digest rather than an index, so a
// residue names exactly one act and cannot be lifted onto another. Two acts that
// carry no payload at all still get distinct commitments, for the same reason.
//
// WHERE PAYLOAD IS ALLOWED TO APPEAR IN A BLOCK, stated because it looks like an
// inconsistency and is not: `cid` appears in `tombstones[]`, because
// ARCHITECTURE section 6 says a settled post leaves its cid on chain. It appears
// nowhere inside a root that has to survive deletion — not in `acts[]`, not in
// the state package. Comment text appears nowhere at all. So the two roots that
// must be invariant under redaction are invariant by construction, and the two
// fields that are meant to be residues are residues.
//
// THE LIMIT, NAMED RATHER THAN SMUGGLED. This build's `core/replay.mjs` requires
// a `post` act to carry a 64-hex `cid` and a `comment` act to carry non-empty
// `text`, so a log with those fields physically stripped would have those acts
// SKIPPED and would replay to a different world. The redaction this repository
// actually performs is the deletion of the media bytes, which moves no field of
// any act and therefore moves no root. The two-commitment split is what makes
// act-field redaction possible without breaking the chain; the chain half of it
// is implemented and tested here, and the replay half is not this file's to
// change.
//
// ── WHAT AN ACT RANGE IS ───────────────────────────────────────────────────
//
// A block for epoch N covers the log indices from just after the act that closed
// epoch N-1 through the act that closed epoch N, inclusive. `acts[]` commits
// every act in that range replay ACCEPTED, except the closing act itself: a
// `closeEpoch` act is the seal and not the content, and the block already carries
// its stamp as `time`, its rate as `oracle`, and its position as `height` and
// `epoch`. Committing it inside `acts[]` as well would commit one fact twice and
// would make a silent day look busy.
//
// Two consequences, both wanted. The ranges tile the log with no gap and no
// overlap, so every accepted act is committed exactly once. And an epoch in which
// nothing happened commits nothing, which is what `orderedRootOf` — never
// `buildTree`, and never the unordered `rootOf` —
// exists for: it seals EMPTY_ROOT instead of throwing, so a quiet day advances
// the chain rather than ending the network.
//
// Acts replay SKIPPED are not committed. They moved no balance and produced no
// state; the log itself carries them, and the archive's content address covers
// the log. An inserted line is still detectable, because it shifts the indices
// this block seals as `range`.

import { readFileSync } from 'node:fs';

import { canonicalBytes, sha256Hex, reviveCanonical, parseCanonical } from '../../core/canonical.mjs';
import { orderedRootOf } from '../../core/merkle.mjs';
import { PARAMS } from '../../core/params.mjs';
import { EDITION as REPLAY_EDITION, emptyWorld, applyAct } from '../../core/replay.mjs';

/** The block format version. A reader that does not know this number should stop
 * rather than guess: every field below is load-bearing. */
export const BLOCK_VERSION = 1;

/** The network id a block belongs to. A block from another network is not a
 * shorter chain, it is a different one, and verification says so. */
export const DEFAULT_NET = 'ptp';

/** What the first block links to. Sixty-four zeros is not a hash of anything —
 * it is the absence of a predecessor, written so that the field is never
 * missing. */
export const GENESIS_PREV = '0'.repeat(64);

/**
 * The fields redaction is allowed to remove: the content address of a picture
 * and the text of a comment. ARCHITECTURE section 6 names exactly these two.
 * Everything else about an act is structure and survives.
 */
export const PAYLOAD_FIELDS = Object.freeze(['cid', 'text']);

const HEX64_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[a-z][a-z0-9]{0,15}$/;

// The canonical sigil is read backwards by core/canonical.mjs (reviveCanonical,
// parseCanonical). It lives there rather than here because the log writer, the
// browser and this chain builder are all readers of the same encoding, and a
// reader that does not decode the sigil can only read something that LOOKS like
// a canonical log. Keeping one copy is Rule 2 applied to the encoding itself.

// ── the two commitments ────────────────────────────────────────────────────

/**
 * The act with its payload fields removed — what the structural hash covers.
 *
 * A shallow copy, because an act belongs to the log and a function that edited
 * its input would make the second call disagree with the first.
 */
export function structuralView(act) {
  const out = {};
  for (const k of Object.keys(act)) {
    if (PAYLOAD_FIELDS.includes(k)) continue;
    out[k] = act[k];
  }
  return out;
}

/** The payload fields this act actually carries, in an object of their own. An
 * act with none yields `{}`, which is a true statement about it. */
export function payloadView(act) {
  const out = {};
  for (const k of PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(act, k)) out[k] = act[k];
  }
  return out;
}

/** The structural digest: sha256 over the canonical bytes of the act minus its
 * payload. Invariant under every lawful deletion. */
export function structuralOf(act) {
  return sha256Hex(canonicalBytes(structuralView(act)));
}

/**
 * The payload commitment: sha256 over the structural digest together with the
 * payload fields.
 *
 * Binding the structural digest is what makes the residue name one act. A
 * commitment lifted from a different act proves nothing, and two acts with no
 * payload still commit differently.
 */
export function payloadOf(act) {
  return sha256Hex(canonicalBytes({ s: structuralOf(act), p: payloadView(act) }));
}

// ── the editions a block seals ─────────────────────────────────────────────

const editionCache = new Map();

/** The digest of a file's bytes. A fact about bytes, not about a module graph,
 *  so the source is read rather than imported. Where a file cannot be read the
 *  answer is the honest string "unavailable" and never a plausible wrong hash. */
function editionOf(relative) {
  try {
    return sha256Hex(readFileSync(new URL(relative, import.meta.url)));
  } catch {
    return 'unavailable';
  }
}

/**
 * The sha256 of every file that can change what a block says.
 *
 * "No silent change" is the claim, and it is only worth what the list covers.
 * The list began as `core/replay.mjs` plus the active rules module — the two
 * files that ARE the distribution formula — and that was too narrow, which we
 * found the way these things are usually found: `core/merkle.mjs` changed (leaves
 * and interior nodes are now domain-separated, and act roots commit to the order
 * rather than the multiset), every sealed block stopped verifying, and the chain
 * could say only ACTS_ROOT_MISMATCH. It could not say WHY, because it had never
 * sealed the digest of the file that computes roots. The refusal was correct and
 * the diagnosis was unavailable, which is exactly the gap between "detectable"
 * and "attributable" this chain exists to close.
 *
 * So the list is now every module a block's contents depend on:
 *
 *   replay     what the state package means
 *   rules      how the epoch's mint was divided
 *   merkle     how acts[] and payloads[] fold into roots
 *   canonical  how every value in the block becomes bytes
 *   params     the economic constants the state was computed under
 *
 * A verifier holding a block that fails against its own code can now diff these
 * five and name the file, instead of reporting a mismatch and stopping. Adding a
 * sixth consensus-critical module without adding it here is the same bug again.
 *
 * The version is checked against a narrow alphabet before it reaches a path:
 * `rules.version` arrives from an act, and an act is public input.
 */
export function editionsOf(rulesVersion) {
  const version = typeof rulesVersion === 'string' ? rulesVersion : '';
  if (editionCache.has(version)) return editionCache.get(version);
  let rules = 'unavailable';
  if (VERSION_RE.test(version)) rules = editionOf(`../../core/rules/${version}.mjs`);
  const editions = Object.freeze({
    replay: REPLAY_EDITION,
    rules,
    rulesVersion: version,
    merkle: editionOf('../../core/merkle.mjs'),
    canonical: editionOf('../../core/canonical.mjs'),
    params: editionOf('../../core/params.mjs'),
  });
  editionCache.set(version, editions);
  return editions;
}

// ── the epoch's economic state ─────────────────────────────────────────────

function accountRows(world) {
  return Object.keys(world.accounts)
    .sort()
    .map((a) => {
      const acc = world.accounts[a];
      return {
        a,
        handle: acc.handle,
        sat: acc.sat,
        ptp: acc.ptp,
        cap: acc.cap,
        shares: acc.shares,
        joined: acc.joined,
        acts: acc.acts,
        viewSeq: acc.viewSeq,
      };
    });
}

function postRows(world) {
  // Creation order, which is the insertion order of the ids replay minted. It is
  // deterministic across replays because replay is, and it is more useful to a
  // reader than lexicographic order, where p10 sorts before p2.
  return Object.keys(world.posts).map((id) => {
    const p = world.posts[id];
    return {
      id,
      author: p.author,
      // `cid` is deliberately absent. It is payload; it lives in the payload
      // commitment for the act that published it and in the tombstone when the
      // post settles. Keeping it out of the state package is what makes the state
      // root invariant under redaction, exactly like the structural root.
      bytes: p.bytes,
      mime: p.mime,
      w: p.w,
      h: p.h,
      viewPriceNano: p.viewPriceNano,
      created: p.created,
      expires: p.expires,
      state: p.state,
      redacted: p.redacted,
      views: p.views,
      uniqueViewers: p.uniqueViewers,
      likes: p.likes,
      comments: p.comments,
      grossNano: p.grossNano,
      creditWei: p.creditWei,
      paidWei: p.paidWei,
      capUnits: p.capUnits,
      claimedUnits: p.claimedUnits,
      rentNano: p.rentNano,
      escrow: { holdingWei: p.escrow.holdingWei, servingWei: p.escrow.servingWei },
      proofs: Object.keys(p.proofs)
        .sort()
        .map((key) => {
          const pr = p.proofs[key];
          return { key, by: pr.by, shard: pr.shard, units: pr.units, at: pr.at, claimed: pr.claimed };
        }),
    };
  });
}

function commentRows(world) {
  // The text is payload and is not in the package. What the state carries is that
  // a comment exists, whose it is, and which post it hangs on — which is every
  // part of a comment that moved money.
  return Object.keys(world.comments).map((id) => {
    const c = world.comments[id];
    return { id, pid: c.pid, author: c.author, at: c.at };
  });
}

function providerRows(world) {
  return Object.keys(world.capacity.providers)
    .sort()
    .map((a) => {
      const row = world.capacity.providers[a];
      return {
        a,
        mb: row.mb,
        mbDays: row.mbDays,
        proven: row.proven,
        paidPtp: row.paidPtp,
        bondPtp: row.bondPtp,
        endpoint: row.endpoint,
      };
    });
}

/**
 * The epoch's full economic state, canonical.
 *
 * Every quantity that is money is a BigInt and encodes as a quoted decimal, so
 * nothing here depends on a double. Two verifiers either match bits or can
 * attribute the difference; there is no third outcome.
 *
 * `world` is the world immediately AFTER the closing act, so the emission this
 * close minted is already in `supply.emitted` and `oracle` is the rate the NEXT
 * epoch will price with. The rate the closing epoch itself priced with is the
 * block's own `oracle` field — the two are different numbers and both are named.
 */
export function packageOf(world, result) {
  return {
    epoch: {
      n: result.epoch,
      closedAt: result.time,
      burnedWei: result.burnedWei,
      emittedWei: result.emittedWei,
      acts: result.entries.length,
      skipped: result.skipped,
    },
    supply: { emitted: world.supply.emitted, burned: world.supply.burned },
    pool: {
      sat: world.pool.sat,
      ptp: world.pool.ptp,
      shares: world.pool.shares,
      locked: world.pool.locked,
    },
    treasury: { ptp: world.treasury.ptp },
    capacity: {
      potPtp: world.capacity.potPtp,
      bondsPtp: world.capacity.bondsPtp,
      providers: providerRows(world),
    },
    rules: {
      version: world.rules.version,
      hash: world.rules.hash,
      setBy: world.rules.setBy,
      fromEpoch: world.rules.fromEpoch,
      key: world.rules.key,
      next: world.rules.next,
    },
    // The rate the state now carries, which is what the next epoch prices with.
    oracle: {
      eurPerBtcNano: world.epoch.oracle.eurPerBtcNano,
      poolSat: world.epoch.oracle.poolSat,
      poolPtpWei: world.epoch.oracle.poolPtpWei,
      epoch: world.epoch.oracle.epoch,
    },
    history: [...world.history],
    seq: { post: world.seq.post, comment: world.seq.comment },
    log: {
      lastIndex: world.log.lastIndex,
      lastAt: world.log.lastAt,
      count: world.log.count,
      skipped: world.log.skipped,
    },
    accounts: accountRows(world),
    posts: postRows(world),
    comments: commentRows(world),
  };
}

/** The pictures that settled in this epoch, in the order they were published.
 * The tombstone is replay's own — author, cid, byte length, dimensions,
 * lifetime, totals, gross euros and PTP paid — carried through unchanged. */
export function tombstonesOf(world, epochN) {
  const out = [];
  for (const id of Object.keys(world.posts)) {
    const p = world.posts[id];
    if (p.tombstone && p.tombstone.epoch === epochN) out.push({ pid: id, ...p.tombstone });
  }
  return out;
}

// ── walking the log ────────────────────────────────────────────────────────

/**
 * Replay the log and hand every closed epoch to `onEpoch`, in order.
 *
 * The walk is the only place that decides what an epoch contains, so the builder
 * and the verifier cannot drift: both call this, both get the same candidates,
 * and a disagreement between them is a disagreement about the log rather than
 * about the arithmetic.
 *
 * An epoch is closed when an act increments `world.epoch.n`. That is read from
 * the world rather than from the act's kind, so a `closeEpoch` act replay refused
 * — one that arrived before its epoch was over — closes nothing here either.
 *
 * The state package is computed inside the callback's own turn, before the world
 * moves on. A candidate therefore holds finished values and never a live
 * reference that will have changed by the time it is used.
 *
 * Returns the final world and the open tail: the acts after the last close, which
 * no block seals because their epoch has not ended.
 */
export function walkLog(acts, onEpoch, params = PARAMS) {
  const world = emptyWorld(params);
  let start = 0;
  let entries = [];
  let skipped = 0;
  let height = 0;

  for (let i = 0; i < acts.length; i++) {
    const act = acts[i];
    const beforeEpoch = world.epoch.n;
    const beforeEmitted = world.supply.emitted;
    const pricedWith = world.epoch.oracle;

    const result = applyAct(world, act);
    if (!result.ok) {
      skipped += 1;
      // The same counter `replay()` keeps, kept the same way, so the world this
      // walk produces is identical in content to `replay(acts)`. The chain must
      // seal the state the one rulebook computes and not a near neighbour of it.
      world.log.skipped += 1;
      continue;
    }
    if (world.epoch.n === beforeEpoch) {
      entries.push({ act, i });
      continue;
    }

    const closed = {
      epoch: beforeEpoch,
      height,
      time: act.t,
      range: { start, end: i },
      entries,
      skipped,
      closer: { i, act },
      // The rate this epoch priced with: the pair sealed at the PREVIOUS close,
      // read before this act replaced it.
      oracle: {
        eurPerBtcNano: pricedWith.eurPerBtcNano,
        poolSat: pricedWith.poolSat,
        poolPtpWei: pricedWith.poolPtpWei,
        epoch: pricedWith.epoch,
      },
      burnedWei: world.history.length > 0 ? world.history[world.history.length - 1] : 0n,
      emittedWei: world.supply.emitted - beforeEmitted,
      constants: world.constants,
      rulesVersion: world.rules.version,
    };
    closed.package = packageOf(world, closed);
    closed.tombstones = tombstonesOf(world, closed.epoch);
    onEpoch(closed);

    height += 1;
    entries = [];
    skipped = 0;
    start = i + 1;
  }

  return {
    world,
    open: { start, end: acts.length - 1, count: entries.length, skipped, epoch: world.epoch.n },
  };
}

// ── sealing ────────────────────────────────────────────────────────────────

/**
 * Seal one closed epoch into an unsigned block.
 *
 * `orderedRootOf` and never `buildTree`: an epoch with no committable acts seals
 * EMPTY_ROOT, which is a value reachable from no leaf and no interior node, so a
 * verifier can tell an empty epoch from a withheld one. `buildTree` refuses an
 * empty list, and that refusal — correct in itself — would block the chain
 * permanently the first quiet day.
 */
export function sealEpoch(candidate, { prev, net = DEFAULT_NET } = {}) {
  const acts = candidate.entries.map((e) => structuralOf(e.act));
  const payloads = candidate.entries.map((e) => payloadOf(e.act));
  const editions = editionsOf(candidate.rulesVersion);

  return {
    v: BLOCK_VERSION,
    net,
    height: candidate.height,
    epoch: candidate.epoch,
    time: candidate.time,
    prev: prev || GENESIS_PREV,
    range: { start: candidate.range.start, end: candidate.range.end },
    acts,
    actsRoot: orderedRootOf(acts),
    payloads,
    payloadsRoot: orderedRootOf(payloads),
    tombstones: candidate.tombstones,
    package: candidate.package,
    stateRoot: sha256Hex(canonicalBytes(candidate.package)),
    oracle: candidate.oracle,
    constants: candidate.constants,
    editions: { ...editions },
    producer: '',
    sig: '',
  };
}

/** The bytes a producer signs: the whole block except the signature.
 *
 * `producer` is inside them on purpose. A signature that did not cover the name
 * it is published under could be lifted onto another producer's block, which is
 * the one thing attribution has to prevent. */
export function signingBytes(block) {
  const body = { ...block };
  delete body.sig;
  return canonicalBytes(body);
}

/**
 * The hash a later block links to: sha256 over the canonical bytes of the whole
 * block, signature included.
 *
 * Including the signature is what makes the chain commit to who published each
 * block, not merely to what it said. Ed25519 is deterministic (RFC 8032), so
 * re-sealing an unchanged epoch with the same key produces the same signature and
 * therefore the same hash — which is what lets `--rebuild` be byte-identical.
 */
export function blockHash(block) {
  return sha256Hex(canonicalBytes(block));
}

/** Attach a producer and its signature. Returns a new block; the input is left
 * alone, so a caller can seal a candidate twice and compare. */
export function signBlock(block, signer) {
  const named = { ...block, producer: signer.publicHex, sig: '' };
  return { ...named, sig: signer.sign(signingBytes(named)) };
}

// ── the chain document ─────────────────────────────────────────────────────

/**
 * The chain as a file: a JSON array with one canonical block per line.
 *
 * Ordinary JSON, so any parser reads it, and one block per line so a diff between
 * two hosts points at the block that differs rather than at a wall of text. The
 * bytes are a pure function of the blocks — no indentation choices, no key order
 * choices, no timestamp — which is what makes a rebuild comparable byte for byte.
 */
export function serialiseChain(blocks) {
  if (blocks.length === 0) return '[]\n';
  const lines = blocks.map((b) => canonicalBytes(b).toString('utf8'));
  return '[\n' + lines.join(',\n') + '\n]\n';
}

/** Read a chain document back, decoding the canonical sigil so a bigint is a
 * bigint again and re-encoding reproduces the same bytes. */
export function parseChain(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return [];
  const raw = JSON.parse(trimmed);
  if (!Array.isArray(raw)) throw new Error('chain: the document is not an array of blocks');
  return raw.map(reviveCanonical);
}

/** Read one act log line. Same decoding, same reason: the log is canonical JSON,
 * and canonical JSON writes a bigint with a sigil. A plain decimal string stays a
 * string, which `core/replay.mjs` accepts as money on the wire. */
export function parseActLine(line) {
  return parseCanonical(line);
}

/**
 * Split an act log into acts, naming the line that fails.
 *
 * A malformed line is refused rather than skipped. Skipping would let a producer
 * hide an act inside a syntax error and still verify, and the act log is the only
 * truth this network has.
 */
export function parseActLog(text) {
  const acts = [];
  const lines = String(text).split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (line === '') continue;
    try {
      acts.push(parseActLine(line));
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      throw new Error(`acts.jsonl line ${n + 1}: ${why}`);
    }
  }
  return acts;
}

// ── comparing two blocks ───────────────────────────────────────────────────

/** The fields a producer computes from the log. `producer` and `sig` are not
 * among them: they are a claim about who published, checked by signature rather
 * than by recomputation, and a block sealed by a previous writer keeps its own. */
const DERIVED_FIELDS = Object.freeze([
  'v',
  'net',
  'height',
  'epoch',
  'time',
  'prev',
  'range',
  'acts',
  'actsRoot',
  'payloads',
  'payloadsRoot',
  'tombstones',
  'package',
  'stateRoot',
  'oracle',
  'constants',
  'editions',
]);

/**
 * The first derived field on which two blocks disagree, or null.
 *
 * Compared through canonical bytes, so the answer is the same on any machine and
 * a difference in key order is not a difference. `acts` and `payloads` are
 * compared element by element as well, because "which act" is the useful half of
 * "the roots do not match".
 */
export function blockDifference(sealed, derived) {
  for (const field of DERIVED_FIELDS) {
    const a = canonicalBytes(sealed[field] === undefined ? null : sealed[field]).toString('utf8');
    const b = canonicalBytes(derived[field] === undefined ? null : derived[field]).toString('utf8');
    if (a === b) continue;
    if ((field === 'acts' || field === 'payloads') && Array.isArray(sealed[field]) && Array.isArray(derived[field])) {
      const n = Math.max(sealed[field].length, derived[field].length);
      for (let k = 0; k < n; k++) {
        if (sealed[field][k] !== derived[field][k]) {
          return { field, index: k, sealed: sealed[field][k] ?? null, derived: derived[field][k] ?? null };
        }
      }
    }
    return { field, index: null, sealed: a, derived: b };
  }
  return null;
}

/** The digest of a value under the same encoding the block uses. Exported
 * because a verifier that wants to check one leaf should not have to reach into
 * core/canonical.mjs to do it. */
export function digestOf(value) {
  return sha256Hex(canonicalBytes(value));
}

/** Whether a string is a lowercase sha256 digest — the shape every hash field in
 * a block has to have before it is worth comparing. */
export function isDigest(v) {
  return typeof v === 'string' && HEX64_RE.test(v);
}
