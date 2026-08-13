// Malformed input fired straight at applyAct.
//
// ARCHITECTURE §5 makes one promise about this function and it is absolute: an
// act that does not validate is SKIPPED WHOLE. Balances never move, no number
// ever becomes NaN, and the world after a rejected act is identical in content to
// the world before it. This file is that promise under fire.
//
// The check is the same for every input and it is deliberately blunt: encode the
// whole world canonically before and after, and compare the two strings. That
// single comparison holds three separate properties at once, which is why it is
// used instead of poking at individual balances:
//
//   * nothing moved — every balance, reserve, counter, escrow and index is
//     inside the encoding, so a single wei anywhere would change the string;
//   * nothing became NaN — core/canonical.mjs REFUSES non-finite numbers, so a
//     NaN or an Infinity that reached the world would throw here rather than
//     encode as `null` and slip past;
//   * nothing exotic was written — a Date, a Map or a boxed primitive smuggled
//     in through an act field would be refused by the encoder too.
//
// Every refusal is also checked against core/errors.mjs: a code outside the
// catalogue is a refusal a bot cannot branch on, which is the same as no answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PARAMS } from '../core/params.mjs';
import { E } from '../core/errors.mjs';
import { canonicalJson } from '../core/canonical.mjs';
import { emptyWorld, applyAct, actError, MAX_ACT_BYTES } from '../core/replay.mjs';

const A = '0x' + 'a'.repeat(40); // alice, the author
const B = '0x' + 'b'.repeat(40); // bob, the viewer
const K = '0x' + 'c'.repeat(40); // the rule key
const STRANGER = '0x' + 'd'.repeat(40); // never registered
const T0 = 1786445193465;
const DAY = 86400000;

/**
 * A world with two funded accounts, one live post, one settled post, and a
 * (viewer, post) pair inside its cooldown. Everything the hostile acts below need
 * to be refused for the RIGHT reason rather than for a missing precondition.
 */
function stage() {
  const world = emptyWorld({ ...PARAMS, ruleKey: K });
  let i = 0;
  let t = T0;
  const land = (as, k, fields = {}, dt = 1000) => {
    t += dt;
    const act = { i: i++, t, as, k, ...fields };
    const result = applyAct(world, act);
    assert.equal(result.ok, true, `staging ${k} failed: ${result.code} ${JSON.stringify(result.detail)}`);
    return act;
  };

  land(A, 'register', { handle: 'alice' });
  land(B, 'register', { handle: 'bob' });
  land(K, 'register', { handle: 'keyholder' });
  land(A, 'burnClaim', { txid: '1'.repeat(64), vout: 0, sat: '400000' });
  land(B, 'burnClaim', { txid: '2'.repeat(64), vout: 0, sat: '400000' });
  land(A, 'swap', { sell: 'btc', amt: '3000', minOut: '1' });
  land(B, 'swap', { sell: 'btc', amt: '3000', minOut: '1' });
  land(A, 'capBuy', { ptp: '2000000000000000000' });
  land(A, 'post', {
    cid: 'a'.repeat(64),
    bytes: 2000000,
    mime: 'image/jpeg',
    w: 1200,
    h: 1500,
    viewPriceNano: '100000',
    days: 30,
  });
  land(A, 'post', {
    cid: 'b'.repeat(64),
    bytes: 1000000,
    mime: 'image/png',
    w: 800,
    h: 800,
    viewPriceNano: '100000',
    days: 1,
  });
  // Walk past the short post's lease and its grace, then close it. The long post
  // is still live, which is what every act below needs.
  land(B, 'settle', { pid: 'p2' }, DAY + Number(PARAMS.settlementGraceSec) * 1000 + 1000);
  // One billable view, so the pair is inside its cooldown from here on.
  land(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 });

  return { world, at: t, nextIndex: i };
}

const { world, at, nextIndex } = stage();
const FROZEN = canonicalJson(world);

/**
 * Fire one act and hold the whole promise against it: refused, catalogued, and
 * the world untouched to the byte.
 */
function fires(what, act, expected) {
  test(what, () => {
    const before = canonicalJson(world);
    assert.equal(before, FROZEN, 'a previous case left the world changed');

    const problem = actError(world, act);
    const result = applyAct(world, act);

    assert.equal(result.ok, false, 'the act was accepted');
    assert.equal(result.code, expected, `expected ${expected}, got ${result.code}`);
    assert.ok(Object.prototype.hasOwnProperty.call(E, result.code), `${result.code} is not catalogued`);
    for (const field of ['msg', 'why', 'next']) {
      assert.equal(typeof result[field], 'string', `refusal is missing ${field}`);
      assert.ok(result[field].length > 0, `refusal has an empty ${field}`);
    }
    // The validator both readers use has to agree with the applier, or a server
    // accepts what a browser refuses and the one rulebook is two.
    assert.notEqual(problem, null, 'actError saw nothing wrong');
    assert.equal(problem.code, result.code);

    // Nothing moved, nothing became NaN, nothing exotic was written.
    assert.equal(canonicalJson(world), FROZEN);
  });
}

/** An act envelope at the staged instant, with a fresh index. */
function act(as, k, fields = {}) {
  return { i: nextIndex, t: at + 1, as, k, ...fields };
}

// ── negative amounts ───────────────────────────────────────────────────────

fires('a negative satoshi claim', act(A, 'burnClaim', { txid: '9'.repeat(64), vout: 0, sat: -5n }), 'BAD_AMOUNT');
fires('a negative satoshi claim, as a string', act(A, 'burnClaim', { txid: '9'.repeat(64), vout: 0, sat: '-5' }), 'BAD_AMOUNT');
fires('a negative swap', act(A, 'swap', { sell: 'ptp', amt: -1n, minOut: '0' }), 'BAD_AMOUNT');
fires('a negative minOut', act(A, 'swap', { sell: 'ptp', amt: '1000', minOut: -1n }), 'BAD_AMOUNT');
fires('a zero swap', act(A, 'swap', { sell: 'ptp', amt: '0', minOut: '0' }), 'BAD_AMOUNT');
fires('a negative liquidity deposit', act(A, 'liqAdd', { sat: '100', ptp: -1n }), 'BAD_AMOUNT');
fires('a negative capacity purchase', act(A, 'capBuy', { ptp: '-1' }), 'BAD_AMOUNT');

// ── non-integers, Infinity, NaN ────────────────────────────────────────────

fires('a fractional amount', act(A, 'capBuy', { ptp: 1.5 }), 'BAD_AMOUNT');
fires('a fractional amount, as a string', act(A, 'capBuy', { ptp: '1.5' }), 'BAD_AMOUNT');
fires('an infinite amount', act(A, 'burnClaim', { txid: '8'.repeat(64), vout: 0, sat: Infinity }), 'BAD_AMOUNT');
fires('a NaN amount', act(A, 'capBuy', { ptp: NaN }), 'BAD_AMOUNT');
fires('an infinite count', act(B, 'view', { pid: 'p1', dwellMs: Infinity, seq: 2 }), 'BAD_REQUEST');
fires('a NaN count', act(B, 'view', { pid: 'p1', dwellMs: NaN, seq: 2 }), 'BAD_REQUEST');
fires('a fractional count', act(B, 'view', { pid: 'p1', dwellMs: 2000.5, seq: 2 }), 'BAD_REQUEST');
fires('a NaN timestamp', { i: nextIndex, t: NaN, as: A, k: 'capClaim' }, 'TIMESTAMP_IMPLAUSIBLE');
fires('an infinite timestamp', { i: nextIndex, t: Infinity, as: A, k: 'capClaim' }, 'TIMESTAMP_IMPLAUSIBLE');
fires('a timestamp before the last act', { i: nextIndex, t: T0 - 1, as: A, k: 'capClaim' }, 'TIMESTAMP_IMPLAUSIBLE');

// ── strings where bigints belong ───────────────────────────────────────────
//
// Amounts arrive on the wire as canonical decimal strings — that is the format,
// and "1000" is a lawful amount. Everything else that is merely string-SHAPED is
// refused: exponent notation, hex, whitespace, leading zeros and words. A leading
// zero is refused because "007" and "7" would be two encodings of one amount, and
// the log is canonical.

fires('a word where an amount belongs', act(A, 'swap', { sell: 'ptp', amt: 'lots', minOut: '0' }), 'BAD_AMOUNT');
fires('exponent notation', act(A, 'swap', { sell: 'ptp', amt: '1e18', minOut: '0' }), 'BAD_AMOUNT');
fires('hexadecimal', act(A, 'swap', { sell: 'ptp', amt: '0x10', minOut: '0' }), 'BAD_AMOUNT');
fires('a padded amount', act(A, 'swap', { sell: 'ptp', amt: '007', minOut: '0' }), 'BAD_AMOUNT');
fires('a spaced amount', act(A, 'swap', { sell: 'ptp', amt: ' 7', minOut: '0' }), 'BAD_AMOUNT');
fires('an empty amount', act(A, 'swap', { sell: 'ptp', amt: '', minOut: '0' }), 'BAD_AMOUNT');
fires('an amount as an object', act(A, 'capBuy', { ptp: { value: '10' } }), 'BAD_AMOUNT');
fires('an amount as an array', act(A, 'capBuy', { ptp: ['10'] }), 'BAD_AMOUNT');
fires('a string where a count belongs', act(B, 'view', { pid: 'p1', dwellMs: '2000', seq: 2 }), 'BAD_REQUEST');

// ── overdrafts ─────────────────────────────────────────────────────────────

fires(
  'selling more PTP than the account holds',
  act(B, 'swap', { sell: 'ptp', amt: '99999999999999999999999', minOut: '0' }),
  'INSUFFICIENT_PTP',
);
fires(
  'selling more satoshis than the account holds',
  act(B, 'swap', { sell: 'btc', amt: '99999999', minOut: '0' }),
  'INSUFFICIENT_RESERVE',
);
fires('removing liquidity nobody deposited', act(B, 'liqRemove', { shares: '1' }), 'INSUFFICIENT_SHARES');
fires(
  'depositing liquidity the account cannot cover',
  act(B, 'liqAdd', { sat: '1', ptp: '99999999999999999999999' }),
  'INSUFFICIENT_PTP',
);
fires(
  'publishing without the CAP the post consumes',
  act(B, 'post', {
    cid: 'e'.repeat(64),
    bytes: 2000000,
    mime: 'image/jpeg',
    w: 100,
    h: 100,
    viewPriceNano: '100000',
    days: 1,
  }),
  'INSUFFICIENT_CAP',
);

// ── swaps that name the wrong pair ─────────────────────────────────────────
//
// There is one pool and one pair, so a "self-paired" swap cannot be expressed by
// naming two assets — it can only arrive as a side this rulebook does not know,
// or as an extra field pretending the act has a second leg. Both are refused
// before any arithmetic runs.

fires('a swap that sells nothing known', act(A, 'swap', { sell: 'eur', amt: '10', minOut: '0' }), 'BAD_REQUEST');
fires('a swap with a second leg', act(A, 'swap', { sell: 'btc', buy: 'btc', amt: '10', minOut: '0' }), 'BAD_REQUEST');
fires('a swap selling the side it buys', act(A, 'swap', { sell: 'ptp', amt: '10', minOut: '0', into: 'ptp' }), 'BAD_REQUEST');
fires(
  'a swap whose fill is worse than the screen showed',
  act(A, 'swap', { sell: 'ptp', amt: '1000000000000000000', minOut: '99999999' }),
  'SLIPPAGE_EXCEEDED',
);

// ── unknown kinds ──────────────────────────────────────────────────────────

fires('a kind nobody wrote', act(A, 'mint'), 'UNKNOWN_ACT_KIND');
fires('a kind that is not a string', act(A, 42), 'UNKNOWN_ACT_KIND');
fires('a kind that is a prototype key', act(A, '__proto__'), 'UNKNOWN_ACT_KIND');
fires('a kind that is an inherited method', act(A, 'constructor'), 'UNKNOWN_ACT_KIND');
fires('a kind that is absent', { i: nextIndex, t: at + 1, as: A }, 'UNKNOWN_ACT_KIND');

// ── acts from addresses that never registered ──────────────────────────────

fires('an act from a stranger', act(STRANGER, 'capClaim'), 'UNKNOWN_ACCOUNT');
fires('an act from the zero address', act('0x' + '0'.repeat(40), 'capClaim'), 'BAD_ADDRESS');
fires('an act from a handle', act('alice', 'capClaim'), 'BAD_ADDRESS');
fires('an act from a short address', act('0x' + 'a'.repeat(39), 'capClaim'), 'BAD_ADDRESS');
fires('an act from no address at all', { i: nextIndex, t: at + 1, k: 'capClaim' }, 'BAD_ADDRESS');
fires('a stranger publishing', act(STRANGER, 'post', {
  cid: 'f'.repeat(64),
  bytes: 1000,
  mime: 'image/png',
  w: 10,
  h: 10,
  viewPriceNano: '100000',
  days: 1,
}), 'UNKNOWN_ACCOUNT');

// ── the rule key ───────────────────────────────────────────────────────────

fires(
  'a rules change from the wrong key',
  act(A, 'rulesSet', { version: 'v1', hash: '0'.repeat(64), fromEpoch: 5 }),
  'RULES_KEY_ONLY',
);
fires(
  'a rules change naming the current epoch',
  act(K, 'rulesSet', { version: 'v1', hash: '0'.repeat(64), fromEpoch: 0 }),
  'RULES_EPOCH_PAST',
);
fires(
  'a rules change naming a closed epoch',
  act(K, 'rulesSet', { version: 'v1', hash: '0'.repeat(64), fromEpoch: 0 }),
  'RULES_EPOCH_PAST',
);
fires(
  'a rules change naming a module nobody published',
  act(K, 'rulesSet', { version: 'v9', hash: '0'.repeat(64), fromEpoch: 5 }),
  'RULES_VERSION_UNKNOWN',
);
fires(
  'a rules change with no module hash',
  act(K, 'rulesSet', { version: 'v1', hash: 'not-a-hash', fromEpoch: 5 }),
  'RULES_VERSION_UNKNOWN',
);

// ── the post lifecycle ─────────────────────────────────────────────────────

fires('settling a post still inside its lease', act(B, 'settle', { pid: 'p1' }), 'SETTLE_BEFORE_GRACE');
fires('settling a post that already settled', act(B, 'settle', { pid: 'p2' }), 'POST_ALREADY_SETTLED');
fires('extending a post after it settled', act(A, 'extend', { pid: 'p2', days: 1 }), 'EXTEND_ON_SETTLED');
fires('extending somebody else\'s post', act(B, 'extend', { pid: 'p1', days: 1 }), 'NOT_THE_AUTHOR');
fires('settling a post that never existed', act(B, 'settle', { pid: 'p404' }), 'POST_NOT_FOUND');
fires('viewing a post that settled', act(B, 'view', { pid: 'p2', dwellMs: 2000, seq: 2 }), 'POST_ALREADY_SETTLED');
fires('liking your own picture', act(A, 'like', { pid: 'p1' }), 'SELF_ENGAGEMENT');
fires('viewing your own picture', act(A, 'view', { pid: 'p1', dwellMs: 2000, seq: 1 }), 'SELF_ENGAGEMENT');

// ── billable views ─────────────────────────────────────────────────────────

fires(
  'a view that did not last long enough',
  act(B, 'view', { pid: 'p1', dwellMs: 100, seq: 2 }),
  'VIEW_DWELL_TOO_SHORT',
);
fires(
  'a view that never filled the viewport',
  act(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 2, vp: 10 }),
  'VIEW_DWELL_TOO_SHORT',
);
fires(
  'a view inside the cooldown',
  act(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 2, vp: 80 }),
  'VIEW_TOO_SOON',
);
fires(
  'a view replaying a sequence number',
  act(B, 'view', { pid: 'p1', dwellMs: 2000, seq: 1, vp: 80 }),
  'VIEW_SEQ_REPLAY',
);

// ── shape ──────────────────────────────────────────────────────────────────

const deep = (() => {
  let node = { end: true };
  for (let n = 0; n < 20000; n += 1) node = { n: node };
  return node;
})();

fires('a twenty-thousand-deep payload', act(B, 'comment', { pid: 'p1', text: deep }), 'BAD_REQUEST');
fires(
  'an act ten megabytes long',
  act(B, 'comment', { pid: 'p1', text: 'x'.repeat(10000000) }),
  'ACT_TOO_LARGE',
);
fires(
  'a comment longer than the network carries',
  act(B, 'comment', { pid: 'p1', text: 'x'.repeat(1001) }),
  'COMMENT_TOO_LONG',
);
fires('an act that is not an object', 'view p1', 'BAD_REQUEST');
fires('an act that is null', null, 'BAD_REQUEST');
fires('an act that is an array', ['view', 'p1'], 'BAD_REQUEST');
fires('an act carrying a Date', act(B, 'comment', { pid: 'p1', text: new Date() }), 'BAD_REQUEST');
fires('an act carrying a Map', act(B, 'comment', { pid: 'p1', text: new Map() }), 'BAD_REQUEST');
fires('an act carrying a function', act(B, 'comment', { pid: 'p1', text: () => 'hello' }), 'BAD_REQUEST');
fires('an act with a field its kind does not carry', act(B, 'like', { pid: 'p1', amount: '1' }), 'BAD_REQUEST');
fires(
  'an act whose field is a getter that throws',
  Object.defineProperty(act(B, 'like'), 'pid', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  }),
  'BAD_REQUEST',
);
fires(
  'an act whose field is a getter that answers differently each time',
  (() => {
    let n = 0;
    return Object.defineProperty(act(B, 'like'), 'pid', {
      enumerable: true,
      get: () => (n++ % 2 === 0 ? 'p1' : 'p2'),
    });
  })(),
  'BAD_REQUEST',
);
fires(
  'an act behind a proxy whose traps throw',
  new Proxy(act(B, 'like', { pid: 'p1' }), {
    ownKeys() {
      throw new Error('boom');
    },
  }),
  'BAD_REQUEST',
);
fires('an act with a signature that is not a string', act(B, 'like', { pid: 'p1', sig: 42 }), 'BAD_REQUEST');

// ── duplicate act indices ──────────────────────────────────────────────────

fires(
  'an index that was already used',
  { i: nextIndex - 1, t: at + 1, as: A, k: 'capClaim' },
  'DUPLICATE_ACT',
);
fires('an index that goes backwards', { i: 0, t: at + 1, as: A, k: 'capClaim' }, 'DUPLICATE_ACT');
fires('an index that is not an integer', { i: 1.5, t: at + 1, as: A, k: 'capClaim' }, 'BAD_REQUEST');

// ── identity ───────────────────────────────────────────────────────────────

fires('registering twice', act(A, 'register', { handle: 'alice2' }), 'ALREADY_REGISTERED');
fires('taking a handle that is held', act(STRANGER, 'register', { handle: 'alice' }), 'HANDLE_TAKEN');
fires('taking a handle that only looks different', act(STRANGER, 'register', { handle: 'a1ice' }), 'HANDLE_TAKEN');
fires('a handle outside the alphabet', act(STRANGER, 'register', { handle: 'Алиса' }), 'HANDLE_INVALID');
fires('a handle with a space', act(STRANGER, 'register', { handle: 'al ice' }), 'HANDLE_INVALID');
fires('a handle that is one character', act(STRANGER, 'register', { handle: 'a' }), 'HANDLE_INVALID');
fires('claiming a burn somebody already claimed', act(B, 'burnClaim', { txid: '1'.repeat(64), vout: 0, sat: '1000' }), 'BURN_ALREADY_CLAIMED');
fires('a burn with no transaction', act(B, 'burnClaim', { txid: 'nope', vout: 0, sat: '1000' }), 'BAD_REQUEST');

// ── publishing ─────────────────────────────────────────────────────────────

fires(
  'a picture larger than the network carries',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 9000000, mime: 'image/jpeg', w: 10, h: 10, viewPriceNano: '100000', days: 1 }),
  'PAYLOAD_TOO_LARGE',
);
fires(
  'a media type members did not agree to hold',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 1000, mime: 'application/pdf', w: 10, h: 10, viewPriceNano: '100000', days: 1 }),
  'MIME_REFUSED',
);
fires(
  'a price below the published band',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 1000, mime: 'image/png', w: 10, h: 10, viewPriceNano: '1', days: 1 }),
  'BAD_REQUEST',
);
fires(
  'a price above the published band',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 1000, mime: 'image/png', w: 10, h: 10, viewPriceNano: '400001', days: 1 }),
  'BAD_REQUEST',
);
fires(
  'a picture with no dimensions',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 1000, mime: 'image/png', w: 0, h: 0, viewPriceNano: '100000', days: 1 }),
  'BAD_REQUEST',
);
fires(
  'a lease of no days',
  act(A, 'post', { cid: 'c'.repeat(64), bytes: 1000, mime: 'image/png', w: 10, h: 10, viewPriceNano: '100000', days: 0 }),
  'BAD_REQUEST',
);
// The staged world holds p1 under 'aaa…' for thirty days and p2 under 'bbb…',
// which has already settled. Republishing the live one is the cheapest deletion
// in the network — one publish fee to make a stranger's picture a 404 that her
// viewers keep paying for — and republishing the settled one is lawful, because
// settlement is when the bytes actually go.
fires(
  'republishing a cid a live post holds',
  act(B, 'post', { cid: 'a'.repeat(64), bytes: 2000000, mime: 'image/jpeg', w: 1200, h: 1500, viewPriceNano: '100000', days: 1 }),
  'CID_IN_USE',
);
fires(
  'republishing your own live cid',
  act(A, 'post', { cid: 'a'.repeat(64), bytes: 10, mime: 'image/png', w: 1, h: 1, viewPriceNano: '100000', days: 1 }),
  'CID_IN_USE',
);

// ── capacity purchases that mint for nothing ───────────────────────────────

fires('buying CAP with one wei', act(A, 'capBuy', { ptp: '1' }), 'DUST_BELOW_MINIMUM');
fires('buying CAP with a thousand wei', act(A, 'capBuy', { ptp: '1000' }), 'DUST_BELOW_MINIMUM');

// ── capacity ───────────────────────────────────────────────────────────────

fires('proving a shard for a node that pledged nothing', act(B, 'capProof', {
  challenge: { pid: 'p1', shard: 0 },
  answer: 'f'.repeat(64),
}), 'CAPACITY_PLEDGE_UNPROVEN');
fires('claiming capacity nobody proved', act(B, 'capClaim'), 'CAPACITY_PLEDGE_UNPROVEN');
fires('a pledge with no endpoint', act(B, 'capPledge', { mb: 100, endpoint: '' }), 'BAD_REQUEST');
fires('a pledge of no capacity', act(B, 'capPledge', { mb: 0, endpoint: 'https://x' }), 'BAD_REQUEST');

// ── the closing move ───────────────────────────────────────────────────────

test('an epoch cannot be closed before it has run', () => {
  // On its own world, because the staged one has deliberately walked a day
  // forward to settle a post and is therefore genuinely closeable.
  const fresh = emptyWorld(PARAMS);
  assert.equal(applyAct(fresh, { i: 0, t: T0, as: A, k: 'register', handle: 'alice' }).ok, true);
  const sealed = canonicalJson(fresh);
  const early = applyAct(fresh, { i: 1, t: T0 + 60000, as: A, k: 'closeEpoch' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'EPOCH_NOT_CLOSED');
  assert.equal(canonicalJson(fresh), sealed);
});

test('the very first act of a network cannot be a close', () => {
  const fresh = emptyWorld(PARAMS);
  const sealed = canonicalJson(fresh);
  const result = applyAct(fresh, { i: 0, t: T0, as: A, k: 'closeEpoch' });
  assert.equal(result.ok, false);
  // UNKNOWN_ACCOUNT comes first — nobody has registered — and a close from a
  // registered account on an empty world is refused too.
  assert.equal(result.code, 'UNKNOWN_ACCOUNT');
  assert.equal(canonicalJson(fresh), sealed);
});

test('nothing above changed the world, and the world still encodes', () => {
  assert.equal(canonicalJson(world), FROZEN);
  assert.ok(FROZEN.length > 1000);
});

test('the encoder is what proves no NaN survived', () => {
  // The comparison every case above makes is only worth anything if the encoder
  // would have caught a bad number. It does: non-finite values are refused rather
  // than written as `null`, which is what would otherwise hash two different
  // corruptions to one digest.
  const probe = emptyWorld(PARAMS);
  probe.seq.post = NaN;
  assert.throws(() => canonicalJson(probe), /non-finite/);
  probe.seq.post = Infinity;
  assert.throws(() => canonicalJson(probe), /non-finite/);
});

test('a refused act does not advance the log, the epoch or an account', () => {
  const before = {
    count: world.log.count,
    lastIndex: world.log.lastIndex,
    lastAt: world.log.lastAt,
    acts: world.epoch.acts.length,
    aliceActs: world.accounts[A].acts,
    burned: world.supply.burned,
  };
  assert.equal(applyAct(world, act(A, 'mint')).ok, false);
  assert.equal(applyAct(world, act(STRANGER, 'capClaim')).ok, false);
  assert.deepEqual(
    {
      count: world.log.count,
      lastIndex: world.log.lastIndex,
      lastAt: world.log.lastAt,
      acts: world.epoch.acts.length,
      aliceActs: world.accounts[A].acts,
      burned: world.supply.burned,
    },
    before,
  );
});

// ── the catalogue is a contract, and both ends of it are checked ───────────

test('every code the dependency-free core modules throw is catalogued', () => {
  // core/params.mjs, core/pricing.mjs and core/amm.mjs cannot import
  // core/errors.mjs — they have to load in a browser, a server and a chain
  // builder with nothing behind them — so they signal by throwing an Error
  // whose message is a catalogued code, and core/replay.mjs turns that string
  // into a refusal through `attempt`. The contract is therefore one-directional
  // and unenforced by the module system: a code thrown but not catalogued
  // becomes BAD_REQUEST, whose published `why` describes a shape check that
  // never ran, so the caller reads a mechanism that did not happen.
  //
  // core/params.mjs states its half of the contract in prose — "core/errors.mjs
  // must carry an entry for each" — and PARAMS_INVALID and BAD_EPOCH were both
  // missing. This is that prose, executed.
  const thrown = new Set();
  for (const file of ['params', 'pricing', 'amm']) {
    const source = readFileSync(new URL(`../core/${file}.mjs`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/new Error\(['"`]([A-Z][A-Z0-9_]*)/g)) thrown.add(match[1]);
  }
  // The regex has to have found the codes rather than nothing at all.
  assert.ok(thrown.size >= 5, `only found ${thrown.size} thrown codes`);
  assert.ok(thrown.has('PARAMS_INVALID') && thrown.has('BAD_EPOCH'));
  for (const code of thrown) {
    assert.ok(Object.prototype.hasOwnProperty.call(E, code), `${code} is thrown by core and not catalogued`);
    for (const field of ['msg', 'why', 'next']) {
      assert.equal(typeof E[code][field], 'string');
      assert.ok(E[code][field].length > 0, `${code} has an empty ${field}`);
    }
    assert.notEqual(E[code].why, E[code].msg, `${code}: why must not restate msg`);
  }
});

test('the capacity refusals describe the payout that exists', () => {
  // docs/ECONOMICS.md sets capacityPayout to perPostEscrow and core/replay.mjs
  // implements it: every draw is bounded by the escrows of the post that was
  // proved. CAPACITY_POT_EMPTY used to publish the opposite — "paid pro rata
  // from a pot funded solely by capBuy" — which named a mechanism that pays
  // nobody, and a caller who believed it would have waited for a pot to fill.
  assert.equal(PARAMS.capacityPayout, 'perPostEscrow');
  assert.match(E.CAPACITY_POT_EMPTY.why, /escrow/i);
  assert.doesNotMatch(E.CAPACITY_POT_EMPTY.why, /pro rata from a pot funded solely/i);
  assert.match(E.CAPACITY_OVER_PLEDGE.why, /megabyte-day/i);
  assert.match(E.CID_IN_USE.why, /settlement redacts/i);
});

test('the size bound is stated, not implied', () => {
  // A limit only two readers share is a limit. This is the number both of them
  // read, and the act that exceeds it is refused with the code that names it.
  assert.equal(typeof MAX_ACT_BYTES, 'number');
  const big = act(B, 'comment', { pid: 'p1', text: 'x'.repeat(MAX_ACT_BYTES + 1) });
  assert.equal(applyAct(world, big).code, 'ACT_TOO_LARGE');
  assert.equal(canonicalJson(world), FROZEN);
});
