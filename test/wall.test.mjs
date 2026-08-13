// RULE 5 — money never buys reach.
//
// ARCHITECTURE §0: "No balance enters any feed score, any rank, any distribution
// weight beyond the burn that produced it." This file is that wall, and it is
// stated as a rule rather than as a preference because it is the one property of
// this network that cannot be recovered after it is lost: a feed that can be paid
// into is a feed nobody can afford to trust again, and no later parameter change
// un-ranks the posts that were bought.
//
// ── HOW THE WALL IS TESTED, AND WHY IT IS TESTED THIS WAY ──────────────────
//
// Two worlds are built that differ in exactly one thing: in the second, one
// account is a token millionaire. Same posts, same authors, same views, likes and
// comments, same ages, same prices — one account simply holds a fortune. Every
// ranking the client can produce is then computed over both, and the two answers
// must be identical to the bit.
//
// A difference test needs a control, or it passes on a function that returns a
// constant. So the same file asserts the opposite direction too: the ranking DOES
// move with attention and with recency, and a creator's rebate DOES move with the
// burn their own content caused. The wall is that money is on one side of that
// line and attention is on the other — not that nothing ever moves.
//
// Three quantities are pushed, because they are the three ways money reaches a
// ranking function and they fail differently:
//
//   a BALANCE      — what an account holds. The direct form: buy PTP, rank higher.
//   a BURN TOTAL   — what an account has destroyed. The subtle form, and the
//                    dangerous one, because burn IS the lawful weight in the
//                    DISTRIBUTION (rule 4). Rule 5's "beyond the burn that
//                    produced it" is exactly the seam: burn earns a rebate on the
//                    fees a creator's own content caused, and it buys no reach.
//   a FEE VOLUME   — what a post has taken in and what it costs to look at. The
//                    plausible form: "surely a post that earns is a good post."
//                    It is the price band from docs/ECONOMICS.md — 20,000 to
//                    400,000 n€ — and if it entered the score, a poster could buy
//                    twenty times the reach per euro by moving one number.
//
// The last one is the attack the predecessor measured: with weight counted over a
// 20x price band, buying at the floor against honest users at the ceiling took 20x
// the weight per euro and recovered 5.346x the spend. It is closed in the
// distribution by burn-linear weight, and it is closed in the feed by this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PARAMS } from '../core/params.mjs';
import { canonicalJson } from '../core/canonical.mjs';
import { emptyWorld, applyAct } from '../core/replay.mjs';
import { credit } from '../core/rules/v1.mjs';
import { rankScore, feedOrder } from '../app/app.mjs';

const HEX = (n) => n.toString(16).padStart(64, '0');
const DAY = 86400000;
const T0 = 1786445193465;

const ALICE = '0x' + 'a'.repeat(40); // an author
const BRUNO = '0x' + 'b'.repeat(40); // another author, who becomes the millionaire
const CARA = '0x' + 'c'.repeat(40); // a viewer
const DEV = '0x' + 'd'.repeat(40); // another viewer

/**
 * A structural clone that keeps BigInts as BigInts and null prototypes null.
 *
 * `structuredClone` refuses a null-prototype object's identity and JSON cannot
 * carry a BigInt at all, and both of those are what the World is made of. The
 * clone has to be exact, because the whole test is "these two worlds differ in
 * one number".
 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const k of Object.keys(value)) out[k] = clone(value[k]);
    return out;
  }
  return value;
}

/**
 * A world with four accounts, three live pictures priced across the whole
 * permitted band, and real engagement on each.
 *
 * Everything here lands as an act, so the world is one replay could have
 * produced. A hand-assembled world would let this file assert a property of a
 * shape that the rulebook never actually builds.
 */
function stage() {
  const world = emptyWorld(PARAMS);
  let t = T0;
  const land = (as, k, fields = {}, dt = 1000) => {
    t += dt;
    const r = applyAct(world, { as, k, t, ...fields });
    assert.equal(r.ok, true, `staging ${k} failed: ${r.code} ${JSON.stringify(r.detail || {})}`);
    return r;
  };

  land(ALICE, 'register', { handle: 'alice' });
  land(BRUNO, 'register', { handle: 'bruno' });
  land(CARA, 'register', { handle: 'cara' });
  land(DEV, 'register', { handle: 'dev' });
  let n = 1;
  for (const who of [ALICE, BRUNO, CARA, DEV]) {
    land(who, 'burnClaim', { txid: HEX(n++), vout: 0, sat: '400000' });
    land(who, 'swap', { sell: 'btc', amt: '20000', minOut: '1' });
  }
  land(ALICE, 'capBuy', { ptp: '20000000000000000' });
  land(BRUNO, 'capBuy', { ptp: '20000000000000000' });

  // Three pictures, priced at the floor, the default and the ceiling — the whole
  // 20x band docs/ECONOMICS.md keeps for posters. If price bought reach, these
  // three would not be able to rank on attention alone.
  const shot = (as, cid, priceNano) =>
    land(as, 'post', {
      cid,
      bytes: 400000,
      mime: 'image/jpeg',
      w: 1200,
      h: 900,
      viewPriceNano: priceNano,
      days: 30,
    });
  shot(ALICE, HEX(0xa1), PARAMS.viewPriceMinNanoEur.toString()); // p1, the floor
  shot(BRUNO, HEX(0xb1), PARAMS.viewPriceMaxNanoEur.toString()); // p2, the ceiling
  shot(ALICE, HEX(0xa2), PARAMS.viewPriceDefaultNanoEur.toString()); // p3, the default

  // Attention, spread so the three posts are genuinely different in the only
  // dimension the ranking is allowed to see.
  let seq = { [CARA]: 0, [DEV]: 0 };
  const look = (who, pid, dt = 1000) => land(who, 'view', { pid, dwellMs: 2000, seq: seq[who]++, vp: 80 }, dt);
  const cooldown = Number(PARAMS.viewCooldownSec) * 1000 + 1000;

  look(CARA, 'p1');
  look(DEV, 'p1', cooldown);
  look(CARA, 'p2', cooldown);
  look(DEV, 'p2', cooldown);
  look(CARA, 'p3', cooldown);
  land(CARA, 'like', { pid: 'p1' });
  land(DEV, 'like', { pid: 'p2' });
  land(CARA, 'comment', { pid: 'p2', text: 'the light on the left' });
  land(DEV, 'comment', { pid: 'p3', text: 'where was this' });

  return { world, at: t };
}

const { world: HONEST, at: NOW } = stage();

/** The whole ranking the client would produce, as a comparable string: the order,
 * and the score attached to each entry. Comparing the order alone would miss a
 * score that moved without changing the sort on this particular fixture. */
function ranking(world, now = NOW, options = {}) {
  return feedOrder(world, now, options).map((e) => `${e.pid} ${e.score}`).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. A BALANCE BUYS NOTHING
// ═══════════════════════════════════════════════════════════════════════════

test('a token millionaire ranks exactly where a pauper does', () => {
  const rich = clone(HONEST);

  // Everything money can be. A million PTP is a hundred times the entire genesis
  // supply; the satoshis are more than the pool holds; the CAP and the liquidity
  // shares are there because "balance" in rule 5 means every balance, not the one
  // that was easiest to think of.
  const bruno = rich.accounts[BRUNO];
  bruno.ptp = 1000000n * 10n ** 18n;
  bruno.sat = 10n ** 12n;
  bruno.cap = 10n ** 15n;
  bruno.shares = 10n ** 12n;

  // The two worlds now differ in exactly four numbers, all of them balances of
  // one account. Asserted, so that a later edit to `stage()` cannot quietly make
  // this test compare two worlds that differ in something else as well.
  const diff = [];
  for (const addr of Object.keys(HONEST.accounts)) {
    for (const field of ['handle', 'sat', 'ptp', 'cap', 'shares', 'joined', 'acts', 'viewSeq']) {
      if (HONEST.accounts[addr][field] !== rich.accounts[addr][field]) diff.push(`${addr}.${field}`);
    }
  }
  assert.deepEqual(diff.sort(), [`${BRUNO}.cap`, `${BRUNO}.ptp`, `${BRUNO}.sat`, `${BRUNO}.shares`]);
  assert.equal(canonicalJson(HONEST.posts), canonicalJson(rich.posts), 'the posts must be identical');

  assert.equal(ranking(rich), ranking(HONEST), 'a balance changed the feed');
  // And in every view of the feed the client offers, not only the default one.
  assert.equal(ranking(rich, NOW, { author: BRUNO }), ranking(HONEST, NOW, { author: BRUNO }));
  assert.equal(ranking(rich, NOW + 6 * 3600000), ranking(HONEST, NOW + 6 * 3600000));

  // The millionaire's own picture is where it was, by position and by score.
  const before = feedOrder(HONEST, NOW).findIndex((e) => e.pid === 'p2');
  const after = feedOrder(rich, NOW).findIndex((e) => e.pid === 'p2');
  assert.equal(after, before);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A BURN TOTAL BUYS NOTHING EITHER
// ═══════════════════════════════════════════════════════════════════════════

test('destroying PTP earns a rebate and buys no reach', () => {
  const burner = clone(HONEST);

  // Burn is the lawful weight in the DISTRIBUTION — rule 4 makes it linear there
  // on purpose. Rule 5 is the seam: it may not also be weight in the FEED. So the
  // network-wide totals and this account's own destroyed quantity are pushed as
  // far as they go, and the feed must not notice.
  burner.supply.burned = 10n ** 30n;
  burner.epoch.burnedWei = 10n ** 30n;
  burner.accounts[BRUNO].ptp = HONEST.accounts[BRUNO].ptp / 2n;
  burner.history = [10n ** 30n, 10n ** 30n, 10n ** 30n];

  assert.equal(ranking(burner), ranking(HONEST), 'a burn total changed the feed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FEE VOLUME AND THE PRICE BAND BUY NOTHING
// ═══════════════════════════════════════════════════════════════════════════

test('what a post earned, and what it costs to look at, are not reach', () => {
  const earning = clone(HONEST);

  // Everything the money side of a post accumulates, moved to absurdity: what it
  // has grossed in euros, what it is holding for its creator, what it has already
  // paid out, and what its escrows carry.
  for (const pid of Object.keys(earning.posts)) {
    const p = earning.posts[pid];
    p.grossNano = 10n ** 21n;
    p.creditWei = 10n ** 30n;
    p.paidWei = 10n ** 30n;
    p.escrow = { holdingWei: 10n ** 30n, servingWei: 10n ** 30n };
  }
  assert.equal(ranking(earning), ranking(HONEST), 'fee volume changed the feed');

  // The price band on its own. Every post moved to the ceiling, then every post
  // moved to the floor: a 20x swing in what a look costs, and not one place moves.
  const ceiling = clone(HONEST);
  const floor = clone(HONEST);
  for (const pid of Object.keys(HONEST.posts)) {
    ceiling.posts[pid].viewPriceNano = PARAMS.viewPriceMaxNanoEur;
    floor.posts[pid].viewPriceNano = PARAMS.viewPriceMinNanoEur;
  }
  assert.equal(ranking(ceiling), ranking(HONEST), 'pricing at the ceiling changed the feed');
  assert.equal(ranking(floor), ranking(HONEST), 'pricing at the floor changed the feed');
  assert.equal(ranking(ceiling), ranking(floor));

  // Two pictures alike in everything the feed may see, priced twenty times apart,
  // score EXACTLY the same. This is the 20x band attack in its smallest form.
  const shape = { created: NOW - 3600000, expires: NOW + DAY, state: 'live', uniqueViewers: 9, likes: 4, comments: 2, views: 40 };
  const cheap = { ...shape, viewPriceNano: PARAMS.viewPriceMinNanoEur, creditWei: 0n, grossNano: 0n, paidWei: 0n };
  const dear = { ...shape, viewPriceNano: PARAMS.viewPriceMaxNanoEur, creditWei: 10n ** 24n, grossNano: 10n ** 18n, paidWei: 10n ** 24n };
  assert.equal(rankScore(dear, NOW), rankScore(cheap, NOW));
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE CONTROL — the ranking is not a constant, it is blind to one thing
// ═══════════════════════════════════════════════════════════════════════════

test('attention and recency do move the feed, or none of the above means anything', () => {
  const base = { created: NOW - 3600000, expires: NOW + DAY, state: 'live', uniqueViewers: 4, likes: 1, comments: 0, views: 10, viewPriceNano: PARAMS.viewPriceDefaultNanoEur };
  const s = rankScore(base, NOW);

  assert.ok(rankScore({ ...base, uniqueViewers: 40 }, NOW) > s, 'unique viewers must count');
  assert.ok(rankScore({ ...base, likes: 20 }, NOW) > s, 'likes must count');
  assert.ok(rankScore({ ...base, comments: 8 }, NOW) > s, 'comments must count');
  assert.ok(rankScore(base, NOW + 12 * 3600000) < s, 'a picture must get older');
  // Breadth beats depth, which is where the two damping terms docs/ECONOMICS.md
  // zeroes in the distribution are correct and belong: in the feed they shape
  // attention and move no money.
  assert.ok(rankScore(base, NOW, 6) < s, "a viewer's own repeats must damp their own feed");
  assert.notEqual(ranking(HONEST), '');
  assert.equal(new Set(feedOrder(HONEST, NOW).map((e) => e.score)).size > 1, true, 'the fixture does not distinguish anything');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE WALL, READ OUT OF THE SOURCE
// ═══════════════════════════════════════════════════════════════════════════

test('no money field is even mentioned inside the ranking functions', () => {
  const source = readFileSync(fileURLToPath(new URL('../app/app.mjs', import.meta.url)), 'utf8');

  // The two functions' bodies, taken from the source rather than from a claim
  // about the source. A behavioural test catches a balance that changes the
  // answer; this catches a balance that is read and merely does not happen to
  // change the answer on this fixture, which is the same defect one edit earlier.
  const bodies = ['rankScore', 'feedOrder'].map((name) => {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start > 0, `${name} is not exported from app/app.mjs any more`);
    let depth = 0;
    let i = source.indexOf('{', start);
    const from = i;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    return { name, body: source.slice(from, i + 1) };
  });

  const money = [
    'ptp', 'sat', 'cap', 'wei', 'nano', 'balance', 'burn', 'burned', 'credit',
    'creditWei', 'paidWei', 'grossNano', 'viewPriceNano', 'escrow', 'treasury',
    'supply', 'price', 'fee', 'shares', 'pool',
  ];
  for (const { name, body } of bodies) {
    for (const term of money) {
      assert.ok(
        !new RegExp(`\\b${term}\\b`, 'i').test(body),
        `${name}() mentions "${term}" — money has reached the ranking`,
      );
    }
  }
  // What they may read: attention and time. Named positively so this test says
  // what the ranking IS, not only what it is not.
  for (const allowed of ['uniqueViewers', 'likes', 'comments', 'created']) {
    assert.ok(bodies.some(({ body }) => body.includes(allowed)), `nothing in the ranking reads ${allowed}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. AND NOT IN THE DISTRIBUTION WEIGHT EITHER
// ═══════════════════════════════════════════════════════════════════════════

test('a millionaire is credited exactly what a pauper causing the same burn is credited', () => {
  const rich = clone(HONEST);
  rich.accounts[BRUNO].ptp = 1000000n * 10n ** 18n;
  rich.accounts[BRUNO].sat = 10n ** 12n;
  rich.accounts[BRUNO].cap = 10n ** 15n;
  rich.accounts[ALICE].ptp = 1n;

  const honestCredit = credit(HONEST, HONEST.epoch.acts);
  const richCredit = credit(rich, rich.epoch.acts);

  const asString = (m) => [...m.entries()].map(([a, w]) => `${a} ${w}`).sort().join('\n');
  assert.equal(asString(richCredit), asString(honestCredit), 'a balance entered the distribution weight');
  assert.ok(honestCredit.size >= 2, 'the fixture credits too few creators to be evidence of anything');

  // The whole epoch, closed on both worlds, so the claim covers what is actually
  // minted rather than the input to the rule alone.
  const closeAt = HONEST.epoch.startedAt + Number(PARAMS.epochSeconds) * 1000 + 1000;
  const mint = (w) => {
    const before = Object.fromEntries(Object.keys(w.accounts).map((a) => [a, w.accounts[a].ptp]));
    const r = applyAct(w, { as: CARA, k: 'closeEpoch', t: closeAt });
    assert.equal(r.ok, true, `closeEpoch was refused: ${r.code}`);
    return Object.keys(w.accounts).map((a) => `${a} ${w.accounts[a].ptp - before[a]}`).sort().join('\n');
  };
  const honestMint = mint(clone(HONEST));
  const richMint = mint(clone(rich));
  assert.equal(richMint, honestMint, 'a balance changed what the epoch minted');
  assert.ok(/[1-9]/.test(honestMint.replace(/0x[0-9a-f]+/g, '')), 'the epoch minted nothing, so this proves nothing');
});

test('but the burn a creator caused does move their rebate — the one lawful entrance', () => {
  // Rule 5 says "beyond the burn that produced it", and this is the "beyond":
  // burn earns, so a world where a creator's pictures caused more engagement must
  // credit them more. Without this the wall would be satisfied by a rule that
  // credits nobody, which is not the property anybody wants.
  const busier = clone(HONEST);
  const quiet = clone(HONEST);
  quiet.epoch.acts = HONEST.epoch.acts.filter((a) => !(a.k === 'view' && a.pid === 'p2'));

  const of = (w, addr) => credit(w, w.epoch.acts).get(addr) || 0n;
  assert.ok(of(busier, BRUNO) > of(quiet, BRUNO), 'engagement with a creator’s own pictures must credit them');
  assert.equal(of(busier, ALICE), of(quiet, ALICE), 'and it must not credit anybody else');

  // Self-engagement is the one kind of attention that credits nothing, in every
  // version of the rules — otherwise the wall has a door in it marked "own post".
  const selfDealt = clone(HONEST);
  selfDealt.epoch.acts = HONEST.epoch.acts.map((a) => (a.k === 'view' && a.pid === 'p2' ? { ...a, as: BRUNO } : a));
  assert.ok(credit(selfDealt, selfDealt.epoch.acts).get(BRUNO) < of(busier, BRUNO));
});
