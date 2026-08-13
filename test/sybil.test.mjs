// Rule 4, under attack: weight is linear in PTP destroyed, so a stake split
// across twenty puppets weighs exactly what one account holding it weighs.
//
// ── WHY THIS FILE FARMS LIKES AND NOT VIEWS ────────────────────────────────
//
// A view farm is rate-limited before it is anything else. The cooldown allows one
// billable view of a (viewer, post) pair every fifteen minutes and the per-epoch
// cap allows twelve of them, so a bot attempting a view every ten minutes all day
// gets twelve of its 143 attempts billed — 8.39% — and the other 91.61% are
// refused and move no money at all. Whatever a view farm proves, it proves it
// about a rate limiter.
//
// A LIKE has no cooldown and no cap. It is one per (person, post) and it is
// therefore FULLY CREDITED, which makes it the case every sybil bound has to be
// stated against. So the farm below likes: 200 wallets, each publishing a picture
// and liking its neighbours', with every euro of the loop inside the farm.
//
// The measured result, and the one docs/ECONOMICS.md states: the farm recovers
// 6,820 bps of what it spends — 4000 direct to the creator, 300 through the
// capacity leg it can capture by running the storage nodes that hold its own
// posts, and 2520 through emission — and loses 31.80% of every euro, at every
// scale and at every token price, because the whole figure is a ratio of basis
// points and nothing in it depends on the DAU or the price.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PARAMS, BPS, applyEpochRail, creatorRebate } from '../core/params.mjs';
import { SPLIT_VECTORS, actionPriceNanoEur, nanoEurToPtpWei, splitFee } from '../core/pricing.mjs';
import { credit as creditV1 } from '../core/rules/v1.mjs';
import { applyAct, emptyWorld } from '../core/replay.mjs';

const T0 = 1786445193465;
const DAY = Number(PARAMS.epochSeconds) * 1000;
const COOLDOWN = Number(PARAMS.viewCooldownSec) * 1000;

/** Distinct, well-formed addresses, handles, txids and cids for n puppets. */
const addressOf = (n) => '0x' + (n + 1).toString(16).padStart(40, '0');
const handleOf = (n) => `farm${String(n).padStart(4, '0')}`;
const txidOf = (n) => (n + 1).toString(16).padStart(64, '0');
// Padded with '0', not 'a', because 'a' is a hex digit and padding with one is
// not injective: (0+1) padded to 64 with 'a' is 63 a's then "1", and (160+1) is
// 62 a's then "a1" — the same 64 characters. This fixture was minting duplicate
// cids for every 200-wallet run and nothing noticed, because posting a cid a
// live post already held used to be allowed. CID_IN_USE found it.
const cidOf = (n) => (n + 1).toString(16).padStart(64, '0');

function ledger(world) {
  let accounts = 0n;
  let credit = 0n;
  for (const a of Object.values(world.accounts)) accounts += a.ptp;
  for (const p of Object.values(world.posts)) credit += p.creditWei;
  return {
    accounts,
    credit,
    capacity: world.capacity.potPtp,
    burned: world.supply.burned,
    treasury: world.treasury.ptp,
  };
}

/**
 * Build a farm: every wallet registers, buys PTP with destroyed bitcoin, buys the
 * CAP its picture consumes, publishes, and then likes `fanout` of its neighbours'
 * pictures. Nothing honest is anywhere in the log, so every wei that moves is the
 * attacker's own.
 */
function farm({ wallets, fanout, viewPriceNano = PARAMS.viewPriceDefaultNanoEur }) {
  const world = emptyWorld(PARAMS);
  let i = 0;
  let t = T0;
  const land = (as, k, fields = {}, dt = 100) => {
    t += dt;
    const result = applyAct(world, { i: i++, t, as, k, ...fields });
    assert.equal(result.ok, true, `${k} refused: ${result.code} ${JSON.stringify(result.detail)}`);
  };

  for (let n = 0; n < wallets; n += 1) {
    const addr = addressOf(n);
    land(addr, 'register', { handle: handleOf(n) });
    land(addr, 'burnClaim', { txid: txidOf(n), vout: 0, sat: '2000' });
    land(addr, 'swap', { sell: 'btc', amt: '300', minOut: '1' });
    land(addr, 'capBuy', { ptp: '4000000000000000' });
  }
  // The pictures: one each, and every wallet is both a creator and a payer.
  const beforePosts = ledger(world);
  const posts = [];
  for (let n = 0; n < wallets; n += 1) {
    const owner = addressOf(n);
    land(owner, 'post', {
      cid: cidOf(n),
      bytes: 200000,
      mime: 'image/jpeg',
      w: 800,
      h: 1000,
      viewPriceNano: String(viewPriceNano),
      days: 1,
    });
    posts.push(`p${n + 1}`);
  }

  const beforeLikes = ledger(world);
  let likes = 0;
  for (let n = 0; n < wallets; n += 1) {
    for (let k = 1; k <= fanout; k += 1) {
      const target = (n + k) % wallets;
      if (world.posts[posts[target]].author === addressOf(n)) continue;
      land(addressOf(n), 'like', { pid: posts[target] });
      likes += 1;
    }
  }
  const afterLikes = ledger(world);

  return { world, posts, likes, beforePosts, beforeLikes, afterLikes, land, at: () => t };
}

test('a 200-wallet like farm recovers 6820 bps and loses 31.80% of every euro', () => {
  const f = farm({ wallets: 200, fanout: 5 });
  assert.equal(f.likes, 1000);

  // What the farm spent on likes, and where each leg of it went. splitFee is
  // exactly conservative, so these four must reconstruct the spend to the wei.
  const spend = f.beforeLikes.accounts - f.afterLikes.accounts;
  const creator = f.afterLikes.credit - f.beforeLikes.credit;
  const capacity = f.afterLikes.capacity - f.beforeLikes.capacity;
  const burned = f.afterLikes.burned - f.beforeLikes.burned;
  const treasury = f.afterLikes.treasury - f.beforeLikes.treasury;
  assert.equal(creator + capacity + burned + treasury, spend);

  // The emission the epoch pays, computed by the rules module and the rail, not
  // by this test.
  const beforeClose = ledger(f.world).accounts;
  f.land(addressOf(0), 'closeEpoch', {}, DAY);
  const minted = ledger(f.world).accounts - beforeClose;
  // The rebate is computed per creator, so the division truncates once per
  // creator rather than once for the epoch: 200 wallets can be up to 199 wei
  // short of the aggregate figure, and never over it. Rounding that mints is
  // rounding that can be farmed, so it rounds the other way.
  const aggregate = (PARAMS.emissionCapBps * burned) / BPS;
  assert.ok(minted <= aggregate);
  assert.ok(aggregate - minted < 200n, `${aggregate - minted} wei of drift`);

  // The maximally integrated attacker: it is its own creator, it runs the storage
  // nodes holding its own posts, and it is the whole of the epoch's burn.
  const recovered = creator + capacity + minted;
  const recoveryBps = (recovered * BPS) / spend;
  assert.ok(recoveryBps < BPS, `the loop paid for itself at ${recoveryBps} bps`);

  // 6820 bps is the closed form and it is an exact UPPER bound on what the
  // integers can produce: every truncation in splitFee pushes its dust into the
  // burn, and burn only comes back at 70%. The measured figure is 6819 — one
  // basis point under, a shortfall of one part in 68 million, and it is in the
  // network's favour rather than the attacker's. Asserting the bound rather than
  // the round number is what keeps that true at every price and every scale.
  assert.ok(recovered * BPS <= spend * 6820n, `recovered ${recoveryBps} bps, above the closed form`);
  assert.ok(recoveryBps >= 6819n, `recovered only ${recoveryBps} bps — the model has drifted`);
  assert.ok(BPS - recoveryBps >= 3180n); // a loss of at least 31.80%, as ECONOMICS.md states

  // The same number, from the constants alone. If these two ever disagree, one of
  // them is wrong and it is not obvious which — so they are asserted together.
  const closedForm = PARAMS.splitCreatorBps + PARAMS.splitCapacityBps + (PARAMS.emissionCapBps * PARAMS.splitBurnBps) / BPS;
  assert.equal(closedForm, 6820n);
  assert.ok(BPS - closedForm >= 3000n, 'the margin fell below the loss floor');

  // Without the capacity leg — an attacker that does not run the storage nodes
  // holding its own posts — it is worse still: 6520 bps, the creator take that
  // docs/ECONOMICS.md calls the one free number in this economy.
  assert.equal(((creator + minted) * BPS) / spend, 6520n);
});

test('the farm loses more once its publish fees are counted', () => {
  // The headline is measured on engagement alone, which is the attacker's best
  // case. The pictures had to be published first, and a publish fee has NO
  // creator leg: 6000 bps of it is destroyed, 3500 goes to the treasury, and the
  // burn it causes is not credited to anybody — a poster's own spending must not
  // rebate to the poster, or publishing is a faucet with no viewer in it.
  const f = farm({ wallets: 50, fanout: 4 });

  // Everything that left farm accounts from the first publish to the last like,
  // against everything that came back to the farm: the creator legs, every
  // capacity leg and every wei of rent (both recoverable by an attacker running
  // the storage nodes that hold its own posts), and the epoch's emission.
  const spend = f.beforePosts.accounts - f.afterLikes.accounts;
  const creator = f.afterLikes.credit - f.beforePosts.credit;
  const capacity = f.afterLikes.capacity - f.beforePosts.capacity;
  assert.ok(f.beforeLikes.burned > f.beforePosts.burned, 'the publishes burned nothing');

  const beforeClose = ledger(f.world).accounts;
  f.land(addressOf(0), 'closeEpoch', {}, DAY);
  const minted = ledger(f.world).accounts - beforeClose;

  const allIn = ((creator + capacity + minted) * BPS) / spend;
  assert.ok(allIn < 6820n, `all-in recovery was ${allIn} bps, no worse than engagement alone`);
  assert.ok(allIn > 0n);
});

test('a rebate never depends on anybody else\'s credited burn', () => {
  // The anti-pot assertion. Under a pot, an attacker's recovery is
  // creatorBps + kappa × burnBps × r, where r is their weight-per-euro advantage
  // over everybody else — so the presence of other creators CHANGES what the
  // attacker gets. Per creator it cannot: the farm's mint is computed from the
  // farm's own burn and nothing else, so adding a busy honest creator to the same
  // epoch leaves it identical to the wei.
  const alone = farm({ wallets: 20, fanout: 4 });
  const withCompany = farm({ wallets: 20, fanout: 4 });

  // The company: three more wallets, one picture, and heavy engagement on it.
  const honestAuthor = addressOf(500);
  const fans = [addressOf(501), addressOf(502), addressOf(503)];
  for (const [n, addr] of [honestAuthor, ...fans].entries()) {
    withCompany.land(addr, 'register', { handle: `honest${n}` });
    withCompany.land(addr, 'burnClaim', { txid: txidOf(600 + n), vout: 0, sat: '4000' });
    withCompany.land(addr, 'swap', { sell: 'btc', amt: '1500', minOut: '1' });
  }
  withCompany.land(honestAuthor, 'capBuy', { ptp: '9000000000000000' });
  withCompany.land(honestAuthor, 'post', {
    cid: cidOf(900),
    bytes: 200000,
    mime: 'image/jpeg',
    w: 800,
    h: 1000,
    viewPriceNano: String(PARAMS.viewPriceMaxNanoEur),
    days: 1,
  });
  const honestPid = `p${21}`;
  for (const fan of fans) {
    withCompany.land(fan, 'like', { pid: honestPid });
    withCompany.land(fan, 'comment', { pid: honestPid, text: 'a real one' });
    withCompany.land(fan, 'view', { pid: honestPid, dwellMs: 3000, seq: 1, vp: 90 });
  }

  const farmMint = (f) => {
    const before = new Map(Object.entries(f.world.accounts).map(([a, r]) => [a, r.ptp]));
    f.land(addressOf(0), 'closeEpoch', {}, DAY);
    let minted = 0n;
    for (let n = 0; n < 20; n += 1) {
      const addr = addressOf(n);
      minted += f.world.accounts[addr].ptp - before.get(addr);
    }
    return minted;
  };

  const mintAlone = farmMint(alone);
  const mintWithCompany = farmMint(withCompany);
  assert.ok(mintAlone > 0n);
  assert.equal(mintWithCompany, mintAlone);
});

/**
 * Twenty pictures, twenty likes, and a switch for who owns the pictures: one
 * account, or twenty. The payers are a separate set of wallets in both worlds, so
 * the two logs differ in exactly one thing — the ownership of the posts — and
 * nothing else moves.
 *
 * The view price is 180,000 n€ rather than the default so that every division in
 * the chain is exact: the like fee is 2e16 wei, the burn leg 7.2e15 and the
 * rebate 5.04e15, none of them with a remainder. The claim under test is that the
 * arithmetic is LINEAR; measuring it at a price that also truncates would measure
 * the rounding as well, and the rounding is the subject of the next test.
 */
function likeRound({ creators }) {
  const world = emptyWorld(PARAMS);
  let i = 0;
  let t = T0;
  const land = (as, k, fields = {}, dt = 100) => {
    t += dt;
    const r = applyAct(world, { i: i++, t, as, k, ...fields });
    assert.equal(r.ok, true, `${k} refused: ${r.code} ${JSON.stringify(r.detail)}`);
  };
  const creatorAt = (n) => addressOf(creators === 1 ? 0 : n);
  const payerAt = (n) => addressOf(100 + n);

  const wallets = new Set();
  for (let n = 0; n < 20; n += 1) {
    wallets.add(creatorAt(n));
    wallets.add(payerAt(n));
  }
  for (const addr of wallets) {
    const n = Number(BigInt(addr)) - 1;
    land(addr, 'register', { handle: handleOf(n) });
    land(addr, 'burnClaim', { txid: txidOf(n), vout: 0, sat: '4000' });
    land(addr, 'swap', { sell: 'btc', amt: '900', minOut: '1' });
    land(addr, 'capBuy', { ptp: '9000000000000000' });
  }
  for (let n = 0; n < 20; n += 1) {
    land(creatorAt(n), 'post', {
      cid: cidOf(n),
      bytes: 200000,
      mime: 'image/jpeg',
      w: 800,
      h: 1000,
      viewPriceNano: '180000',
      days: 1,
    });
  }
  for (let n = 0; n < 20; n += 1) land(payerAt(n), 'like', { pid: `p${n + 1}` });

  return {
    world,
    likes: 20,
    land,
  };
}

test('a stake split across twenty puppets returns exactly what one account returns', () => {
  // ARCHITECTURE rule 4, end to end. Twenty likes are paid either way and the
  // same PTP is destroyed either way; the only difference is whether one creator
  // owns the twenty pictures or twenty creators own one each.
  const concentrated = likeRound({ creators: 1 });
  const split = likeRound({ creators: 20 });

  // One creator holds every picture on the concentrated side.
  const owners = new Set(Object.values(concentrated.world.posts).map((p) => p.author));
  assert.equal(owners.size, 1);
  assert.equal(new Set(Object.values(split.world.posts).map((p) => p.author)).size, 20);
  assert.equal(concentrated.likes, split.likes);

  // The burn that ENGAGEMENT caused is identical, and that is the quantity the
  // emission rail reads. It is asserted here rather than supply.burned, which is
  // not equal and should not be: twenty puppets each buy their own CAP to be
  // able to post, and a capBuy destroys PTP. Nineteen extra wallets means
  // nineteen extra purchases, so the split side burns 1.71e17 wei MORE in
  // setup costs alone.
  //
  // That difference is not a rule-4 violation, it is rule 4 working. Splitting a
  // stake buys no extra WEIGHT — the credited burn and the mint below are equal
  // to the wei — while still paying every per-identity cost twenty times over.
  // An attacker gains nothing and pays more, which is the direction the whole
  // design leans.
  assert.equal(concentrated.world.epoch.burnedWei, split.world.epoch.burnedWei);
  assert.ok(split.world.supply.burned > concentrated.world.supply.burned);

  const creditedConcentrated = creditV1(concentrated.world, concentrated.world.epoch.acts);
  const creditedSplit = creditV1(split.world, split.world.epoch.acts);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n);
  assert.equal(creditedConcentrated.size, 1);
  assert.equal(creditedSplit.size, 20);
  assert.equal(sum(creditedConcentrated), sum(creditedSplit));

  const mint = (m) => [...m.values()].reduce((a, wei) => a + creatorRebate(wei), 0n);
  assert.equal(mint(creditedConcentrated), mint(creditedSplit));

  // And through the whole rulebook rather than the rules module alone: close both
  // epochs and compare what was actually minted.
  const mintedBy = (f) => {
    const before = ledger(f.world).accounts;
    f.land(addressOf(0), 'closeEpoch', {}, DAY);
    return ledger(f.world).accounts - before;
  };
  const one = mintedBy(concentrated);
  const twenty = mintedBy(split);
  assert.ok(one > 0n);
  assert.equal(twenty, one);
});

test('where the division is not exact, splitting loses the dust and never gains it', () => {
  // At an arbitrary price the rebate truncates once per creator, so twenty
  // creators can lose up to nineteen wei against one creator holding the same
  // burn. The direction is what matters: splitting is never rewarded, so no farm
  // can buy weight by adding accounts. Nineteen wei is 2e-18 PTP.
  const burn = 4000000000000001n; // the burn leg of one like at the default price
  const concentrated = creatorRebate(burn * 20n);
  let split = 0n;
  for (let n = 0; n < 20; n += 1) split += creatorRebate(burn);
  assert.ok(split <= concentrated);
  assert.ok(concentrated - split < 20n);

  // Under the epoch rail the same holds, and for the same reason: the rail scales
  // every rebate by ONE fraction, so it can only ever reduce, and reduce everyone
  // identically. A pot would let a larger share take a larger fraction of
  // somebody else's contribution; uniform scaling cannot.
  const epoch = 0;
  const totalBurn = burn * 20n;
  const asOne = applyEpochRail(new Map([['0xone', creatorRebate(totalBurn)]]), epoch, totalBurn);
  const asMany = new Map();
  for (let n = 0; n < 20; n += 1) asMany.set(`0x${n}`, creatorRebate(burn));
  const railed = applyEpochRail(asMany, epoch, totalBurn);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n);
  assert.ok(sum(railed) <= sum(asOne));
  assert.ok(sum(asOne) - sum(railed) < 20n);
});

test('the rail scales everybody by the same fraction, so growing does not pay', () => {
  // The rail binds only when an epoch's rebates exceed the schedule — 2000 PTP in
  // the first year, which is a burn of 2857 PTP and about 17,200 DAU. It cannot
  // be reached by a test that has to buy its PTP out of a 900 EUR pool, so it is
  // asserted against the function that implements it.
  const huge = 10000n * 10n ** 18n; // 10,000 PTP of burn caused by one creator
  const rebates = new Map([
    ['0xattacker', creatorRebate(huge)],
    ['0xhonest', creatorRebate(huge / 4n)],
  ]);
  const railed = applyEpochRail(rebates, 0, huge + huge / 4n);
  const asked = [...rebates.values()].reduce((a, b) => a + b, 0n);
  const paid = [...railed.values()].reduce((a, b) => a + b, 0n);
  assert.ok(paid < asked, 'the rail did not bind where it should have');

  // Both were cut by the same fraction, to within the truncation of a single
  // division. The attacker's SHARE of the round is unchanged by the rail, which
  // is what stops the rail from quietly becoming a pot.
  const attackerShareBefore = (rebates.get('0xattacker') * BPS) / asked;
  const attackerShareAfter = (railed.get('0xattacker') * BPS) / paid;
  assert.equal(attackerShareBefore, attackerShareAfter);
});

test('view farming is rate-limited long before it is anything else', () => {
  // One pair, one epoch, one attempt every ten minutes all day. The cooldown is
  // fifteen minutes and the cap is twelve, so twelve attempts are billed and the
  // rest are refused — 8.39% of what the farm tried to spend, and the refusals
  // move no money at all. That is why the like is the binding case and this is
  // not: a view farm's problem is throughput, not margin.
  const world = emptyWorld(PARAMS);
  const author = addressOf(0);
  const viewer = addressOf(1);
  let i = 0;
  let t = T0;
  const send = (as, k, fields = {}, dt = 1000) => {
    t += dt;
    return applyAct(world, { i: i++, t, as, k, ...fields });
  };
  const must = (...args) => assert.equal(send(...args).ok, true);

  must(author, 'register', { handle: 'author' });
  must(viewer, 'register', { handle: 'viewer' });
  must(author, 'burnClaim', { txid: txidOf(0), vout: 0, sat: '9000' });
  must(viewer, 'burnClaim', { txid: txidOf(1), vout: 0, sat: '9000' });
  must(author, 'swap', { sell: 'btc', amt: '2000', minOut: '1' });
  must(viewer, 'swap', { sell: 'btc', amt: '2000', minOut: '1' });
  must(author, 'capBuy', { ptp: '4000000000000000' });
  must(author, 'post', {
    cid: cidOf(0),
    bytes: 200000,
    mime: 'image/jpeg',
    w: 800,
    h: 1000,
    viewPriceNano: String(PARAMS.viewPriceDefaultNanoEur),
    days: 1,
  });

  const ATTEMPTS = 143;
  const SPACING = 600000; // ten minutes
  let billed = 0;
  const refusals = new Map();
  const before = world.accounts[viewer].ptp;
  for (let n = 0; n < ATTEMPTS; n += 1) {
    const r = send(viewer, 'view', { pid: 'p1', dwellMs: 2000, seq: n + 1, vp: 100 }, SPACING);
    if (r.ok) billed += 1;
    else refusals.set(r.code, (refusals.get(r.code) || 0) + 1);
  }

  assert.equal(billed, Number(PARAMS.maxViewsPerPairPerEpoch));
  assert.equal(billed, 12);
  const creditedBps = (BigInt(billed) * BPS) / BigInt(ATTEMPTS);
  assert.equal(creditedBps, 839n); // 8.39%, the figure the brief measured
  assert.ok(refusals.get('VIEW_TOO_SOON') > 0);
  assert.ok(refusals.get('VIEW_PAIR_CAP') > 0);

  // The refused attempts cost the farm nothing and earned it nothing: the viewer
  // paid for exactly the twelve that landed.
  const price = nanoEurToPtpWei(actionPriceNanoEur(PARAMS.viewPriceDefaultNanoEur, 'view', PARAMS), world.epoch.oracle);
  assert.equal(before - world.accounts[viewer].ptp, price * 12n);
  assert.equal(world.posts.p1.creditWei, splitFee(price, SPLIT_VECTORS.fee).creator * 12n);
  assert.ok(COOLDOWN > 0);
});
