// Capacity: who is asked to prove they hold bytes, and what the answer is worth.
//
// A member who grants storage keeps shards of other members' pictures. Placement
// is rendezvous hashing over the live pledged set (core/placement.mjs), so a
// browser node and a server node compute the same holders for a shard with no
// coordinator and no gossip. This file is the writer's half of the loop: it
// issues the challenges, checks the answers against bytes it holds itself, and
// reports what each provider has actually proven.
//
// ── THE SENTENCE THAT SHAPES THE FILE ──────────────────────────────────────
//
// A PLEDGE NOBODY CAN CHALLENGE EARNS NOTHING. That is not a rule this file
// enforces; it is a consequence of the ones core/replay.mjs already holds, and
// the only thing left to do here is make it VISIBLE. MB-days accrue from
// `capProof` acts and from nothing else, a proof is accepted only for a shard
// rendezvous placement assigned to that node, and payment is drawn per post out
// of that post's own escrow. So a node that pledges a terabyte and wins no
// placements is challenged about nothing, proves nothing and draws nothing —
// while still having paid the pledge bond. `ledger` reports that state under
// `challengeable`, because a provider watching a balance stay at zero deserves
// to be told which of the three reasons it is.
//
// ── WHAT REPLAY CANNOT CHECK, AND THEREFORE WHAT IS HERE ───────────────────
//
// Two things, and they are exactly the two that need bytes or a clock:
//
//   THE ANSWER. A challenge is sha256 of a 4 KiB window of a shard. Replay holds
//   the cid and nothing the cid addresses, so it can check that a node was
//   assigned the shard and that it is credited once, and it cannot check that
//   the hash is right. Whoever holds a complete copy checks that — here, before
//   the act is appended.
//
//   THE LATENCY. core/params.mjs bounds a proof at two seconds
//   (CAP_PROOF_LATENCY_BOUND_MS) and the reason is durability fraud rather than
//   payment fraud: three replicas answered from one disk is one disk pretending
//   to be three, and the network's promise of three independent holders quietly
//   becomes a promise of one. Concurrent random-range challenges bounded in time
//   are answerable by three disks and not by one, so the disk's own IOPS is the
//   distinctness test. A measurement is not a pure function, so it cannot live in
//   the rulebook; it lives here, and the bond is slashable so that failing it
//   costs something.
//
// A proof for a challenge this host never issued is refused. That is deliberate
// and it is the only way the latency bound can exist: the window is derived from
// public data and any node can compute it, so without an issue record there is
// no instant to measure from and the two-second bound would be decorative.

import { CAP_PROOF_LATENCY_BOUND_MS, CAP_COIN_PER_MB_DAY, REPLICATION } from '../core/params.mjs';
import { SHARD_BYTES } from '../core/replay.mjs';
import { answerChallenge, challengeFor, placeShard, shardsOf } from '../core/placement.mjs';
import { canonicalBytes, sha256Hex } from '../core/canonical.mjs';

/**
 * The seed every challenge window is derived from, this epoch.
 *
 * A pure function of the world, so every reader — the challenged node included —
 * can recompute which bytes are wanted. That does not weaken the proof: knowing
 * WHICH bytes are wanted is useless without having them. What the seed buys is
 * that the window MOVES each epoch, so an answer memorised last epoch is worth
 * nothing now, and that no secret has to travel from the writer to the node.
 */
export function epochSeed(world) {
  return sha256Hex(
    canonicalBytes({
      epoch: world.epoch.n,
      startedAt: world.epoch.startedAt,
      rate: world.epoch.oracle.eurPerBtcNano,
    }),
  );
}

/** The pledged nodes placement ranks over: every provider currently announcing
 * capacity. A pledge of zero is not a node, it is a withdrawal. */
export function liveNodes(world) {
  return Object.keys(world.capacity.providers).filter((id) => world.capacity.providers[id].mb > 0);
}

/** The byte length of one shard of a picture — short for the last one, because
 * a shard is never padded and the cid commits to the real length. */
function shardLength(bytes, index, shardBytes = SHARD_BYTES) {
  return Math.min(shardBytes, bytes - index * shardBytes);
}

/**
 * Every (post, shard) this node is currently responsible for.
 *
 * Live posts only. A settled post's bytes are gone from every device by
 * construction, so challenging a node about them would be asking it to prove it
 * ignored a deletion.
 */
export function assignmentsFor(world, nodeId, { shardBytes = SHARD_BYTES, at = null } = {}) {
  const nodes = liveNodes(world);
  const out = [];
  if (!nodes.includes(nodeId)) return out;
  const replication = Number(REPLICATION);
  for (const pid of Object.keys(world.posts)) {
    const post = world.posts[pid];
    if (post.state !== 'live') continue;
    if (at !== null && at >= post.expires) continue;
    for (const shard of shardsOf(post.cid, post.bytes, shardBytes)) {
      const holders = placeShard(nodes, post.cid, shard, replication);
      if (holders.includes(nodeId)) out.push({ pid, cid: post.cid, shard, bytes: post.bytes });
    }
  }
  return out;
}

/**
 * The challenges to put to one node, with the window each answer must cover.
 *
 * The response is everything the node needs and nothing it does not: the post,
 * the shard, the byte range, and the shape of the act it should send back. The
 * act itself carries only `{ pid, shard }` and the answer, because the window is
 * recomputable and a challenge that travelled inside the act would be a challenge
 * the prover chose.
 */
export function challengesFor(world, nodeId, { limit = 16, shardBytes = SHARD_BYTES, at = null } = {}) {
  const seed = epochSeed(world);
  return assignmentsFor(world, nodeId, { shardBytes, at })
    .slice(0, limit)
    .map(({ pid, cid, shard, bytes }) => {
      const length = shardLength(bytes, shard, shardBytes);
      const window = challengeFor(cid, shard, seed, length);
      return {
        pid,
        cid,
        shard,
        offset: window.offset,
        length: window.length,
        shardBytes: length,
        epoch: world.epoch.n,
        seed,
        answerWith: {
          k: 'capProof',
          challenge: { pid, shard },
          answer: 'sha256 hex of the bytes in [offset, offset+length) of this shard',
        },
        boundMs: Number(CAP_PROOF_LATENCY_BOUND_MS),
      };
    });
}

/**
 * The register of challenges this host has actually put, and when.
 *
 * It exists only so the latency bound can be measured. Entries are keyed by
 * (node, post, shard, epoch) — the same granularity replay credits a proof at —
 * and are dropped when the epoch they belong to closes, because a proof answered
 * against a stale seed is refused on its content anyway.
 */
export function createChallengeRegister({ boundMs = Number(CAP_PROOF_LATENCY_BOUND_MS) } = {}) {
  const issued = new Map();
  const key = (addr, pid, shard, epoch) => `${addr}|${pid}|${shard}|${epoch}`;
  return {
    boundMs,
    issue(addr, pid, shard, epoch, at) {
      issued.set(key(addr, pid, shard, epoch), at);
    },
    issuedAt(addr, pid, shard, epoch) {
      const v = issued.get(key(addr, pid, shard, epoch));
      return v === undefined ? null : v;
    },
    /** Forget everything from before this epoch. Called at close. */
    sweep(epoch) {
      for (const k of issued.keys()) {
        const n = Number(k.slice(k.lastIndexOf('|') + 1));
        if (n < epoch) issued.delete(k);
      }
    },
    get size() {
      return issued.size;
    },
  };
}

/**
 * Check a `capProof` act's answer, and only its answer.
 *
 * Deliberately narrow. Whether the post exists, whether it is live, whether this
 * node was placed on this shard and whether it has already been credited this
 * epoch are all decisions core/replay.mjs makes, and server/index.mjs asks
 * `actError` before it asks this. Repeating those checks here would give one act
 * two answers, and the answers would drift.
 *
 * Returns `null` when the answer is right, or `{ code, detail }` when it is not.
 */
export async function verifyProof(act, { world, store, register, now = Date.now, shardBytes = SHARD_BYTES }) {
  const pid = act.challenge && act.challenge.pid;
  const shard = act.challenge && act.challenge.shard;
  const post = world.posts[pid];
  if (!post) return { code: 'POST_NOT_FOUND', detail: { pid } };

  const issuedAt = register ? register.issuedAt(act.as, pid, shard, world.epoch.n) : null;
  if (issuedAt === null) {
    return {
      code: 'CAPACITY_PROOF_WRONG',
      detail: {
        pid,
        shard,
        issued: false,
        why: 'this host issued no challenge for that shard this epoch, so there is no instant to measure the answer against',
        next: 'GET /api/v1/capacity/challenges?as=<your address> and answer one of those',
      },
    };
  }
  const elapsed = now() - issuedAt;
  if (elapsed > register.boundMs) {
    // The bound is a distinctness test, not a service-level target: three disks
    // answer concurrent random reads inside it and one disk pretending to be
    // three does not.
    return {
      code: 'CAPACITY_PROOF_WRONG',
      detail: { pid, shard, elapsedMs: elapsed, boundMs: register.boundMs, why: 'answered too slowly to be a distinct disk' },
    };
  }

  const bytes = await store.shard(post.cid, shard, shardBytes);
  if (!bytes) {
    // This host cannot check an answer about bytes it does not hold. Refusing is
    // the honest outcome: accepting would credit MB-days on the strength of the
    // prover's own arithmetic.
    return {
      code: 'CAPACITY_PROOF_WRONG',
      detail: { pid, shard, held: false, why: 'this host holds no copy of that shard and cannot verify the answer' },
    };
  }

  const length = shardLength(post.bytes, shard, shardBytes);
  const window = challengeFor(post.cid, shard, epochSeed(world), length);
  const expected = answerChallenge(Uint8Array.prototype.slice.call(bytes), window);
  if (expected !== String(act.answer).toLowerCase()) {
    return {
      code: 'CAPACITY_PROOF_WRONG',
      detail: { pid, shard, offset: window.offset, length: window.length },
    };
  }
  return null;
}

/** CAP units as a decimal MB-day string, in integers. Six decimals, which is
 * CAP's own precision — no float touches it, because a count that is displayed
 * through a double is a count that disagrees with the ledger at scale. */
function mbDayString(units) {
  const whole = units / CAP_COIN_PER_MB_DAY;
  const frac = (units % CAP_COIN_PER_MB_DAY).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/**
 * What every provider has pledged, proven and been paid — and, when that is
 * zero, which of the reasons applies.
 *
 * `challengeable` is the count of (post, shard) placements this node currently
 * holds. Zero means the network has never asked it for anything, which is the
 * one failure mode that looks identical to being ignored and is not: it is
 * rendezvous hashing having placed the shards elsewhere, and the answer is to
 * wait for more pictures or for the node set to change, not to pledge harder.
 */
export function ledger(world, { shardBytes = SHARD_BYTES } = {}) {
  const nodes = liveNodes(world);
  const rows = [];
  for (const addr of Object.keys(world.capacity.providers)) {
    const p = world.capacity.providers[addr];
    const placements = nodes.includes(addr) ? assignmentsFor(world, addr, { shardBytes }).length : 0;
    rows.push({
      address: addr,
      endpoint: p.endpoint,
      pledgedMb: p.mb,
      bondPtp: p.bondPtp,
      provenUnits: p.proven,
      mbDays: mbDayString(p.proven),
      paidPtp: p.paidPtp,
      challengeable: placements,
      note:
        placements === 0
          ? 'no shard is placed on this node right now, so nothing can be challenged and nothing accrues'
          : p.proven === 0n
            ? 'placed but unproven — answer a challenge from GET /api/v1/capacity/challenges'
            : null,
    });
  }
  rows.sort((a, b) => (a.provenUnits > b.provenUnits ? -1 : a.provenUnits < b.provenUnits ? 1 : 0));

  // The pot is the sum of every live post's two escrows; the world keeps the
  // running total, and this is the same number decomposed so a provider can see
  // which posts it is drawn from.
  let holding = 0n;
  let serving = 0n;
  for (const pid of Object.keys(world.posts)) {
    const post = world.posts[pid];
    if (post.state !== 'live') continue;
    holding += post.escrow.holdingWei;
    serving += post.escrow.servingWei;
  }

  return {
    replication: Number(REPLICATION),
    shardBytes,
    seed: epochSeed(world),
    nodes: nodes.length,
    potPtp: world.capacity.potPtp,
    escrow: { holdingWei: holding, servingWei: serving },
    bondsPtp: world.capacity.bondsPtp,
    providers: rows,
  };
}
