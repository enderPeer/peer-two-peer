// The writer is an office, not a machine.
//
// One writer at a time is still the law: two hosts appending fork the log the
// moment both are reachable, and there is no merge — acts are ordered, and two
// orders are two networks. What is not fixed is WHO holds the pen. Hosts rank
// each other by the longest sealed chain, then the longest log, then liveness,
// and every ranking field is verifiable from data the candidate already serves,
// so it is an election two honest observers cannot disagree about.
//
// ── THE FOUR RULES, EACH A BUG CLOSED RATHER THAN A PRINCIPLE STATED ────────
//
// 1. SILENCE IS NOT A MANDATE. A host that has heard from no peer since it
//    started does not write. Quarantine lifts on a successful probe round and
//    never on a failed one. The failure this closes is specific: a watchdog
//    restarting a stale host INSIDE a partition would otherwise hand the isolated
//    side a second pen — the exact split the feature exists to prevent. A host
//    that was already seated and then loses contact keeps writing, because that
//    is a partition and a partition elects one writer per side; the danger is at
//    boot, and boot is where the quarantine is. A genuine last-host-standing is
//    promoted deliberately by its operator and says so while it waits.
//
// 2. AN INCUMBENT YIELDS ONLY TO A STRICTLY LONGER RECORD. A seated writer keeps
//    the pen against an equal. A host still in boot quarantine yields to any live
//    writer whose record is at least as long. Conflating those two thresholds is
//    what made two identical hosts demote into each other's mirrors — a network
//    nobody could write to — and the two-identical-hosts case is a test rather
//    than a footnote.
//
// 3. NEVER FOLLOW SOMEONE WHO FOLLOWS YOU. A peer that reports it mirrors us is
//    not a writer and is dropped from the ranking; a host that finds itself set
//    to mirror itself drops the role and re-decides. Without this, a
//    restored-from-backup primary and its mirror seated each other forever.
//
// 4. CLAIMS ARE CHECKED, NOT BELIEVED. A peer's advertised numbers only start a
//    handover. Before yielding, the record is fetched and what was actually
//    delivered is verified — length, shared prefix, sealed chain, every signature
//    — with a byte ceiling on every fetch. Anyone can claim a million acts;
//    nobody can produce them on demand. Addresses arriving in a roster are
//    untrusted input aimed at a fetch(), so they are stripped to bare origins and
//    never pointed at private or loopback ranges.
//
// ── WHAT BREAKS THE TIE WHEN NOTHING ELSE DOES ─────────────────────────────
//
// Two hosts that boot together with identical records rank identically on the
// published fields, and neither is seated. Something has to decide or nobody
// writes. The last comparator is therefore the origin string, ascending —
// deterministic, symmetric, computed identically on both sides, and applied ONLY
// where neither host is seated. An incumbent is never displaced by alphabetical
// order; incumbency is its own tiebreak, which is rule 2.
//
// Liveness is left out of that comparison on purpose, and leaving it in is a
// fork rather than a detail: a host is never stale to itself, so both sides of a
// symmetric pair would rank themselves first on liveness and both would take the
// pen. Liveness ranks peers against one another, where it means what it says.
//
// ── TWO SIGNED HISTORIES FREEZE THE HOST ───────────────────────────────────
//
// If a returning host and the winner have each sealed blocks the other does not
// have, nothing is adopted and nothing is written. The host says so and waits for
// a person. Code does not choose between two attributable records, and this
// repository has no merge: DECENTRALIZATION.md names deterministic rebase as
// ahead rather than describing it in the present tense.

import { blockHash, parseChain, signingBytes } from './block.mjs';
import { verifyBytes } from './keys.mjs';

/** The ceilings every fetch is held to. A peer is untrusted input with a URL. */
export const LIMITS = Object.freeze({
  maxRecordBytes: 8000000,
  maxStatusBytes: 65536,
  timeoutMs: 5000,
  maxPeers: 32,
});

/** What a peer serves, and the only paths this module asks for. */
export const ENDPOINTS = Object.freeze({ chain: '/api/chain', status: '/status.json' });

/** The roles a host can be in. `waiting` is not a failure state — it is a host
 * that has decided, correctly, that it must not write. */
export const ROLES = Object.freeze({ writer: 'writer', mirror: 'mirror', waiting: 'waiting' });

// ── addresses ──────────────────────────────────────────────────────────────

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether a host name may not be fetched.
 *
 * A roster arrives over the network and is fed to a fetch, so it is a
 * server-side request forgery primitive unless something narrows it. Loopback,
 * link-local, every private IPv4 range, unique-local and link-local IPv6, and
 * any name with no dot — a bare label is an internal service name far more often
 * than it is a public host.
 *
 * THE LIMIT THIS CANNOT CLOSE, stated because a deny-list on a string always
 * looks more complete than it is: a public name can resolve to a private address,
 * and no check on a URL sees that. Closing it needs the resolved address at
 * connect time, which is a property of the HTTP client rather than of this
 * function.
 */
export function isBlockedHost(host) {
  if (typeof host !== 'string' || host === '') return true;
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();

  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.home.arpa')) return true;

  const v4 = IPV4_RE.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (name.includes(':')) {
    if (name === '::1' || name === '::') return true;
    if (name.startsWith('fc') || name.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(name)) return true;
    if (name.startsWith('::ffff:')) return true;
    return false;
  }

  return !name.includes('.');
}

/**
 * Strip an address to a bare origin, or null.
 *
 * Scheme, host and port and nothing else: no path, no query, no fragment, and no
 * credentials — a roster entry carrying a username is an attempt to make this
 * host authenticate somewhere on somebody else's behalf.
 */
export function bareOrigin(address) {
  if (typeof address !== 'string' || address.trim() === '') return null;
  let url;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (isBlockedHost(url.hostname)) return null;
  return url.origin;
}

/** A roster reduced to the origins this host may probe: deduped, self removed,
 * blocked entries dropped, and capped so a hostile roster cannot turn one probe
 * round into a thousand requests. */
export function rosterOrigins(roster, selfOrigin) {
  const seen = new Set();
  const out = [];
  const self = bareOrigin(selfOrigin);
  for (const entry of Array.isArray(roster) ? roster : []) {
    const origin = bareOrigin(typeof entry === 'string' ? entry : entry && entry.origin);
    if (!origin || origin === self || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
    if (out.length >= LIMITS.maxPeers) break;
  }
  return out;
}

// ── ranking ────────────────────────────────────────────────────────────────

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function byOrigin(a, b) {
  return String(a.origin) < String(b.origin) ? -1 : String(a.origin) > String(b.origin) ? 1 : 0;
}

/**
 * The published order among PEERS: longest sealed chain, then longest log, then
 * liveness, then origin. Negative when `a` ranks ahead of `b`.
 */
export function compareCandidates(a, b) {
  if (num(b.height) !== num(a.height)) return num(b.height) - num(a.height);
  if (num(b.logLength) !== num(a.logLength)) return num(b.logLength) - num(a.logLength);
  if (num(b.liveAt) !== num(a.liveAt)) return num(b.liveAt) - num(a.liveAt);
  return byOrigin(a, b);
}

/**
 * The order used when THIS HOST is one of the candidates: the record alone, then
 * the origin. Liveness is deliberately absent.
 *
 * Liveness ranks peers against one another — a peer last heard from an hour ago
 * is a worse place to hand a pen than one heard from a second ago — and it cannot
 * rank a host against itself. A host is never stale to itself, so whatever value
 * it used for its own liveness would put it first on both sides of a symmetric
 * pair: two identical hosts would each rank themselves ahead of the other and
 * BOTH would take the pen, which is the fork this whole function exists to
 * prevent. Ordering the self-inclusive field by the record and then by the origin
 * is symmetric by construction: both hosts compute the same list from the same
 * two rows.
 */
export function compareByRecord(a, b) {
  if (num(b.height) !== num(a.height)) return num(b.height) - num(a.height);
  if (num(b.logLength) !== num(a.logLength)) return num(b.logLength) - num(a.logLength);
  return byOrigin(a, b);
}

/** Strictly longer: a higher sealed chain, or the same chain over a longer log.
 * This is the threshold an incumbent yields to and nothing else is. */
export function strictlyLonger(peer, self) {
  if (num(peer.height) !== num(self.height)) return num(peer.height) > num(self.height);
  return num(peer.logLength) > num(self.logLength);
}

/** At least as long. The threshold a host still in boot quarantine yields to,
 * and the reason it is a different function from the one above. */
export function atLeastAsLong(peer, self) {
  if (num(peer.height) !== num(self.height)) return num(peer.height) > num(self.height);
  return num(peer.logLength) >= num(self.logLength);
}

/**
 * How two sealed chains relate, by block hash.
 *
 * `same`, `ahead` (mine extends theirs), `behind` (theirs extends mine), or
 * `forked` — each has blocks the other does not, at the same height, and no
 * program may choose between them.
 */
export function compareRecords(mine, theirs) {
  const a = Array.isArray(mine) ? mine : [];
  const b = Array.isArray(theirs) ? theirs : [];
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return 'forked';
  }
  if (a.length === b.length) return 'same';
  return a.length > b.length ? 'ahead' : 'behind';
}

/** The block hashes of a delivered chain, which is what `compareRecords` reads. */
export function hashesOf(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((b) => {
    try {
      return blockHash(b);
    } catch {
      return 'unhashable';
    }
  });
}

// ── the decision ───────────────────────────────────────────────────────────

function decision(role, code, why, follow) {
  return Object.freeze({ role, code, why, follow: follow || null });
}

/**
 * Who holds the pen, given this host and the peers it actually heard from.
 *
 * Pure: no fetch, no clock, no randomness. `elect` does the fetching and the
 * verifying and then calls this, which is what makes all four rules testable
 * without a network.
 *
 *   self  = { origin, height, logLength, hashes[], incumbent, quarantined,
 *             promoted }
 *   peers = [{ origin, height, logLength, liveAt, role, follows, hashes[],
 *              verified }]
 *
 * `quarantined` defaults to true. A host that does not say it has been seated is
 * a host that just started, and boot is precisely where rule 1 applies.
 */
export function decide({ self, peers }) {
  const me = {
    origin: bareOrigin(self.origin) || String(self.origin),
    height: num(self.height),
    logLength: num(self.logLength),
    hashes: self.hashes || [],
    incumbent: Boolean(self.incumbent),
    quarantined: self.quarantined === undefined ? true : Boolean(self.quarantined),
    promoted: Boolean(self.promoted),
  };

  // ANSWERED and CANDIDATE are different sets and the difference is load-bearing.
  // A peer that answered is evidence that this host is not alone — that is what
  // lifts the boot quarantine, and it is true even when the peer turns out to be
  // our own mirror. A candidate is somewhere the pen could go, which a mirror of
  // ours is not.
  const answered = [];
  for (const raw of Array.isArray(peers) ? peers : []) {
    if (!raw || raw.verified === false) continue;
    const origin = bareOrigin(raw.origin);
    if (!origin) continue;
    // Never follow yourself. A host reading its own entry out of a roster and
    // seating itself as its own mirror is the degenerate case of rule 3, and it
    // has happened. Its own entry is also not evidence that it heard from anyone.
    if (origin === me.origin) continue;
    answered.push({
      origin,
      height: num(raw.height),
      logLength: num(raw.logLength),
      liveAt: num(raw.liveAt),
      role: raw.role === ROLES.writer ? ROLES.writer : raw.role === ROLES.mirror ? ROLES.mirror : ROLES.waiting,
      hashes: raw.hashes || [],
      follows: raw.follows ? bareOrigin(raw.follows) : null,
    });
  }

  // Rule 3: a peer that mirrors us is not a writer and is not a candidate.
  const candidates = answered.filter((p) => p.follows !== me.origin);

  // Rule 1. Heard from nobody at all: a booting host waits, a seated one keeps
  // writing through the partition, an operator-promoted one writes and says why.
  if (answered.length === 0) {
    if (me.promoted) {
      return decision(ROLES.writer, 'PROMOTED_BY_OPERATOR', 'no peer answered and this host was promoted by hand');
    }
    if (me.quarantined) {
      return decision(
        ROLES.waiting,
        'NO_PEER_HEARD',
        'no peer answered since this host started, and silence is not a mandate',
      );
    }
    return decision(
      ROLES.writer,
      'PARTITIONED_INCUMBENT',
      'no peer answered, and this host was already the seated writer before contact was lost',
    );
  }

  // Two signed histories freeze the host, whatever the ranking says. Checked over
  // everyone who answered, including a mirror of ours: a mirror that has sealed
  // a block we have not is still a second attributable record.
  for (const peer of answered) {
    if (compareRecords(me.hashes, peer.hashes) === 'forked') {
      return decision(
        ROLES.waiting,
        'FORK_NEEDS_A_PERSON',
        `this host and ${peer.origin} have each sealed blocks the other does not have`,
        null,
      );
    }
  }

  const ranked = [...candidates].sort(compareCandidates);

  if (me.quarantined && !me.promoted) {
    // Rule 2, the boot half: yield to any LIVE WRITER whose record is at least as
    // long. A peer that is not writing is not somewhere to hand a pen.
    const seated = ranked.filter((p) => p.role === ROLES.writer && atLeastAsLong(p, me));
    if (seated.length > 0) {
      return decision(
        ROLES.mirror,
        'YIELD_TO_SEATED_WRITER',
        `${seated[0].origin} is writing and its record is at least as long`,
        seated[0].origin,
      );
    }
    // Nobody is writing. The probe round succeeded, so quarantine lifts and the
    // record decides — including the origin tiebreak, which is what stops two
    // identical hosts from demoting into each other.
    const field = [me, ...ranked].sort(compareByRecord);
    if (field[0].origin === me.origin) {
      return decision(
        ROLES.writer,
        'QUARANTINE_LIFTED',
        `${answered.length} peer${answered.length === 1 ? '' : 's'} answered and none ranks ahead of this host`,
      );
    }
    return decision(
      ROLES.mirror,
      'YIELD_BY_ORDER',
      `${field[0].origin} ranks ahead of this host and no writer is seated`,
      field[0].origin,
    );
  }

  // Rule 2, the incumbent half: a seated writer yields only to a record that is
  // STRICTLY longer. An equal record leaves the pen exactly where it is.
  const longer = ranked.filter((p) => strictlyLonger(p, me));
  if (longer.length > 0) {
    return decision(
      ROLES.mirror,
      'YIELD_TO_LONGER',
      `${longer[0].origin} holds a strictly longer record`,
      longer[0].origin,
    );
  }
  return decision(
    ROLES.writer,
    me.promoted && me.quarantined ? 'PROMOTED_BY_OPERATOR' : 'INCUMBENT_HOLDS',
    'no peer holds a strictly longer record',
  );
}

// ── checking a claim ───────────────────────────────────────────────────────

/**
 * Verify what a peer actually delivered, rather than what it said.
 *
 * The chain is checked for internal linkage, one producer, and a valid signature
 * on every block; the claim is checked against the delivery. A peer that
 * advertises a height it cannot produce is dropped with a reason rather than
 * silently down-ranked, because "I could not verify you" and "you are behind" are
 * different facts and only one of them is about the record.
 *
 * WHAT THIS DOES NOT DO, and it is the honest half: it does not replay the log.
 * A delivered chain that links and verifies may still disagree with the acts it
 * claims to seal — that is what `server/chain/verify.mjs` is for, and a caller
 * that wants the full check passes it as `deepVerify`. Election is about who
 * holds the pen next; verification is about whether a record is true, and
 * conflating them would put a full replay inside every probe round.
 */
export function auditRecord(delivered, options = {}) {
  const problems = [];
  const blocks = Array.isArray(delivered && delivered.chain) ? delivered.chain : [];

  let producer = null;
  // Everything in here is a stranger's bytes, and canonical encoding refuses a
  // value it cannot represent exactly. A throw is one more way of failing to
  // verify, and it must not be a way of stopping this host.
  try {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block || typeof block !== 'object') {
        problems.push(`block ${i} is not a block`);
        break;
      }
      if (block.height !== i) {
        problems.push(`block ${i} calls itself height ${block.height}`);
        break;
      }
      const wantPrev = i === 0 ? '0'.repeat(64) : blockHash(blocks[i - 1]);
      if (block.prev !== wantPrev) {
        problems.push(`block ${i} does not link to the block before it`);
        break;
      }
      if (!verifyBytes(block.producer, signingBytes(block), block.sig)) {
        problems.push(`block ${i} is not signed by the producer it names`);
        break;
      }
      if (producer === null) producer = block.producer;
      else if (block.producer !== producer && !options.allowProducerChange) {
        problems.push(`block ${i} changes producer midway through the record`);
        break;
      }
    }
  } catch (err) {
    problems.push(`the delivered chain cannot be read: ${err && err.message ? err.message : String(err)}`);
  }

  const claim = (delivered && delivered.claim) || {};
  const height = blocks.length;
  const logLength = num(delivered && delivered.acts);
  if (num(claim.height) > height) problems.push(`claimed ${claim.height} blocks and delivered ${height}`);
  if (num(claim.logLength) > logLength) problems.push(`claimed ${claim.logLength} acts and delivered ${logLength}`);

  if (problems.length === 0 && typeof options.deepVerify === 'function') {
    try {
      const deep = options.deepVerify(delivered);
      if (!deep || deep.ok !== true) problems.push('the delivered record does not verify');
    } catch (err) {
      problems.push(`the delivered record does not verify: ${err && err.message ? err.message : String(err)}`);
    }
  }

  return {
    verified: problems.length === 0,
    origin: delivered && delivered.origin,
    height,
    logLength,
    liveAt: num(claim.liveAt),
    role: claim.role,
    follows: claim.follows || null,
    hashes: hashesOf(blocks),
    producer,
    problems,
  };
}

// ── the probe round ────────────────────────────────────────────────────────

/**
 * Fetch one peer's record, under a byte ceiling and a deadline.
 *
 * Two documents: the chain a peer publishes and the status beside it. Both are
 * read as capped streams rather than with `response.text()`, because a peer that
 * answers with an endless body would otherwise take the host down with a promise
 * it never settles. Not exercised by the test suite, which runs with no network
 * and injects a delivery instead — stated rather than implied.
 */
export async function fetchRecord(origin, options = {}) {
  const limits = { ...LIMITS, ...options };
  const chainText = await getCapped(origin + ENDPOINTS.chain, limits.maxRecordBytes, limits.timeoutMs);
  let claim = {};
  try {
    claim = JSON.parse(await getCapped(origin + ENDPOINTS.status, limits.maxStatusBytes, limits.timeoutMs));
  } catch {
    claim = {};
  }
  return {
    origin,
    chain: parseChain(chainText),
    acts: num(claim.acts),
    claim: {
      height: num(claim.height),
      logLength: num(claim.acts),
      liveAt: num(claim.liveAt),
      role: claim.role,
      follows: claim.follows || null,
    },
  };
}

async function getCapped(url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`PEER_HTTP_${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('PEER_RECORD_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One probe round: normalise the roster, fetch every peer, verify what arrived,
 * and decide.
 *
 * `deps.fetchRecord` is injectable, which is how the four rules are tested
 * offline. Every peer that fails to answer or fails to verify is carried into the
 * report with its reason, so an operator reading a `waiting` host can see whether
 * it heard nothing or heard something it could not check.
 */
export async function elect({ self, roster, deps = {} }) {
  const get = deps.fetchRecord || fetchRecord;
  const origins = rosterOrigins(roster, self.origin);
  const peers = [];
  const unreachable = [];

  for (const origin of origins) {
    let delivered;
    try {
      delivered = await get(origin, deps.limits || {});
    } catch (err) {
      unreachable.push({ origin, why: err && err.message ? err.message : String(err) });
      continue;
    }
    const audited = auditRecord({ ...delivered, origin }, deps);
    if (!audited.verified) {
      unreachable.push({ origin, why: audited.problems[0] || 'unverifiable' });
      continue;
    }
    peers.push(audited);
  }

  const outcome = decide({ self, peers });
  return { ...outcome, peers, unreachable, heard: peers.length, probed: origins.length };
}
