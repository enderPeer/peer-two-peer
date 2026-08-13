// RULE 2 — one rulebook, three readers.
//
// ARCHITECTURE §0 states the rule and names this file as where it is enforced:
// "The server, the browser and the chain builder run the *same file*. A server
// may not accept what replay would skip."
//
// That sentence contains three separate claims, and a test that checks only one
// of them leaves the network free to break the other two. So this file holds all
// three, in the order they can fail:
//
//   1. SAME FILE.   Every reader's import specifier resolves to one URL, that URL
//                   is `core/replay.mjs`, and the module object each reader would
//                   receive is `===` the module object the others receive. Node
//                   keys its module registry on the resolved URL, so identity of
//                   the namespace object is the strongest available form of "the
//                   same file, loaded once" — stronger than comparing bytes,
//                   because two byte-identical copies at two paths would pass a
//                   byte comparison and still be two rulebooks.
//
//   2. NAMED EDITION. `EDITION` is the sha256 of `core/replay.mjs` as it sits on
//                   disk. A block seals that string, so a verifier can say "this
//                   state was computed by THIS rulebook" rather than "by some
//                   rulebook". A hand-maintained constant lies the first time
//                   somebody forgets, so it is checked against the file.
//
//   3. NO WIDER DOOR. The host refuses exactly what `actError` refuses. Twenty-six
//                   invalid acts are fired at both, and the codes are compared one
//                   for one. Where they differ at all, the difference must run in
//                   one direction only.
//
// ── THE ONE LAWFUL ASYMMETRY, STATED RATHER THAN ASSUMED ───────────────────
//
// The host may refuse MORE than the rulebook does, and it must be able to: a
// signature, a picture's bytes, a bitcoin explorer and a wall clock are all
// things `core/replay.mjs` cannot consult, because replay must be pure (rule 1's
// corollary) and reproducible on a machine with no network. Every one of those
// checks can only ever turn an accepted act into a refused one.
//
// The reverse — the host ACCEPTING an act the rulebook would skip — is the fork.
// It writes a line every future replay drops, so the host's own numbers and
// everybody else's diverge from that line onward with nothing in the record
// saying why. So the two directions are asserted separately: parity on the
// rulebook's own refusals, and a strictly one-way asymmetry on the host's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as rulebook from '../core/replay.mjs';
import { EDITION, actError, replay, MAX_COMMENT_CHARS } from '../core/replay.mjs';
import { E } from '../core/errors.mjs';
import { parseCanonical } from '../core/canonical.mjs';
import { PARAMS } from '../core/params.mjs';
import { editionsOf } from '../server/chain/block.mjs';
import { createServer, addressOf, signAct } from '../server/index.mjs';
import { BURN_SCRIPT_HEX, bech32Address } from '../server/burnwatch.mjs';

const ROOT = new URL('../', import.meta.url);
const RULEBOOK_URL = new URL('core/replay.mjs', ROOT);
const RULEBOOK_PATH = fileURLToPath(RULEBOOK_URL);

// The three readers ARCHITECTURE §0 names, by the file that does the reading.
// `app/app.mjs` is the browser's, `server/index.mjs` is the writer's, and
// `server/chain/block.mjs` is the chain builder's.
const READERS = [
  { role: 'the browser', file: 'app/app.mjs' },
  { role: 'the writer', file: 'server/index.mjs' },
  { role: 'the chain builder', file: 'server/chain/block.mjs' },
];

/** Every `.mjs` in the repository's own source directories, repo-relative. */
function sourceFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = fileURLToPath(new URL(rel, ROOT));
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = rel + e.name + (e.isDirectory() ? '/' : '');
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.mjs')) out.push(child);
    }
  };
  for (const dir of ['core/', 'server/', 'app/', 'ops/', 'agents/', 'test/']) walk(dir);
  return out.sort();
}

/**
 * Every specifier in `source` that names a file called `replay.mjs`, resolved
 * against the importing file.
 *
 * Both quote styles and both forms — `import … from` and `await import()` — are
 * matched, because a fork does not have to arrive through a static import to be
 * a fork.
 */
function replaySpecifiers(sourcePath) {
  const text = readFileSync(fileURLToPath(new URL(sourcePath, ROOT)), 'utf8');
  const found = [];
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]*replay\.mjs)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return found.map((spec) => ({ spec, url: new URL(spec, new URL(sourcePath, ROOT)).href }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE SAME FILE
// ═══════════════════════════════════════════════════════════════════════════

test('the server, the browser and the chain builder resolve one URL', () => {
  const resolved = [];
  for (const reader of READERS) {
    const imports = replaySpecifiers(reader.file);
    assert.ok(imports.length > 0, `${reader.file} (${reader.role}) does not import the rulebook at all`);
    for (const i of imports) {
      assert.equal(
        i.url,
        RULEBOOK_URL.href,
        `${reader.file} imports "${i.spec}", which resolves to ${i.url}, not to the one rulebook`,
      );
      resolved.push(i.url);
    }
  }
  // One URL, three readers. Stated as a set so the failure names the count.
  assert.equal(new Set(resolved).size, 1, 'the readers resolve more than one rulebook');
});

test('and every reader receives the identical module object', async () => {
  // Node keys its module registry on the resolved URL, so importing through each
  // reader's own specifier — resolved from that reader's own directory — returns
  // the very same namespace object when and only when they are the same file.
  // Two byte-identical copies at two paths would pass a byte comparison and fail
  // this one, which is why identity is the assertion rather than bytes.
  const seen = [];
  for (const reader of READERS) {
    for (const { spec, url } of replaySpecifiers(reader.file)) {
      const mod = await import(url);
      assert.equal(mod, rulebook, `${reader.file}'s "${spec}" is a second instance of the rulebook`);
      seen.push(mod);
    }
  }
  assert.ok(seen.length >= READERS.length);
  // The same claim from the other side: a path that differs only in spelling is
  // still the same module, and a copy at another path would not be.
  const spelled = await import(new URL('./core/../core/replay.mjs', ROOT).href);
  assert.equal(spelled, rulebook);
});

test('the rulebook is never forked: one file, one definition of each rule', () => {
  const files = sourceFiles();

  // Exactly one file in the repository is called replay.mjs.
  const named = files.filter((f) => f.endsWith('/replay.mjs') || f === 'replay.mjs');
  assert.deepEqual(named, ['core/replay.mjs'], 'there is more than one file called replay.mjs');

  // Every importer anywhere in the repository — not only the three readers —
  // resolves to it. A fourth reader that quietly loaded a copy would be a fork
  // nobody had named.
  const importers = [];
  for (const f of files) {
    for (const i of replaySpecifiers(f)) {
      assert.equal(i.url, RULEBOOK_URL.href, `${f} imports a rulebook at ${i.url}`);
      importers.push(f);
    }
  }
  assert.ok(importers.length >= READERS.length, 'nothing imports the rulebook');

  // And the rules themselves are defined once. A second `export function
  // actError` anywhere is a second validator, which is the fork wearing the
  // right filename.
  for (const symbol of ['actError', 'applyAct', 'replay', 'emptyWorld']) {
    const definers = files.filter((f) =>
      new RegExp(`^export\\s+function\\s+${symbol}\\b`, 'm').test(
        readFileSync(fileURLToPath(new URL(f, ROOT)), 'utf8'),
      ),
    );
    assert.deepEqual(definers, ['core/replay.mjs'], `${symbol} is defined in more than one place`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE NAMED EDITION
// ═══════════════════════════════════════════════════════════════════════════

test('EDITION is the sha256 of core/replay.mjs as it sits on disk', () => {
  const onDisk = createHash('sha256').update(readFileSync(RULEBOOK_PATH)).digest('hex');
  assert.match(EDITION, /^[0-9a-f]{64}$/, 'EDITION is not a sha256 digest');
  assert.equal(EDITION, onDisk, 'EDITION does not match the file that reported it');

  // The digest is of the whole file, so any edit at all moves it. Checked rather
  // than asserted in prose: a digest computed over some subset of the source
  // would still look like a sha256 and would still be wrong.
  const source = readFileSync(RULEBOOK_PATH);
  const oneByteOff = Buffer.concat([source, Buffer.from('\n')]);
  assert.notEqual(createHash('sha256').update(oneByteOff).digest('hex'), EDITION);
  assert.ok(statSync(RULEBOOK_PATH).size > 0);
});

test('and it is the edition a block seals, so a verifier can name the rulebook', () => {
  const editions = editionsOf('v1');
  assert.equal(editions.replay, EDITION, 'the chain seals a different rulebook edition than the one it imported');
  assert.equal(editions.rulesVersion, 'v1');
  assert.match(editions.rules, /^[0-9a-f]{64}$/);
  assert.equal(
    editions.rules,
    createHash('sha256').update(readFileSync(fileURLToPath(new URL('core/rules/v1.mjs', ROOT)))).digest('hex'),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. NO WIDER DOOR
// ═══════════════════════════════════════════════════════════════════════════

const PK = {
  alice: '0x' + '11'.repeat(32),
  bob: '0x' + '22'.repeat(32),
  carol: '0x' + '33'.repeat(32),
  dave: '0x' + '44'.repeat(32),
};
const ADDR = Object.fromEntries(Object.entries(PK).map(([k, v]) => [k, addressOf(v)]));

/** An explorer that answers from a table, so a burnClaim can be made to fail for
 * the one reason the rulebook cannot see: bitcoin. */
function fakeExplorer(name, table) {
  return {
    name,
    async tx(txid) {
      const row = table[txid];
      if (!row) throw new Error('404');
      return row;
    },
  };
}

function fakeSource(name, eurPerBtcNano) {
  return { name, async read() { return BigInt(eurPerBtcNano); } };
}

/**
 * A writer with a fake clock, fake explorers and fake price sources, and two
 * funded accounts.
 *
 * Acts go in through `srv.submit`, which is the one door: signature, then
 * `actError`, then the host's own checks, then the append. Driving it directly
 * rather than over HTTP is deliberate — the claim under test is about which
 * function decides, not about a status line, and `submit` is the function whose
 * second step is the rule.
 */
async function writer(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-rule2-'));
  const clock = { t: Date.parse('2026-08-12T09:00:00.000Z') };
  const burns = {
    ['a'.repeat(64)]: { confirmations: 6, outputs: [{ sat: 500000n, scriptHex: BURN_SCRIPT_HEX }] },
    ['b'.repeat(64)]: { confirmations: 6, outputs: [{ sat: 500000n, scriptHex: BURN_SCRIPT_HEX }] },
    // A real transaction that pays a spendable address instead of the keyless
    // output. Reserve from it would be reserve from nothing.
    ['f'.repeat(64)]: { confirmations: 6, outputs: [{ sat: 500000n, scriptHex: '0014' + '11'.repeat(20) }] },
  };
  const srv = await createServer({
    dir,
    now: () => clock.t,
    explorers: [fakeExplorer('one', burns), fakeExplorer('two', burns)],
    oracleSources: [90000, 90010, 89990, 90005, 89995].map((v, i) => fakeSource(`src${i}`, BigInt(v) * 1000000000n)),
  });
  t.after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Offer one already-signed act at the one door. */
  const send = (signed) => srv.submit(signed);
  const ok = async (body, pk) => {
    const r = await send(signAct(body, pk));
    assert.equal(r.ok, true, `staging ${body.k} failed: ${r.code} ${JSON.stringify(r.detail)}`);
    return r;
  };
  await ok({ t: clock.t, as: ADDR.alice, k: 'register', handle: 'alice' }, PK.alice);
  await ok({ t: clock.t, as: ADDR.bob, k: 'register', handle: 'bob' }, PK.bob);
  await ok({ t: clock.t, as: ADDR.alice, k: 'burnClaim', txid: 'a'.repeat(64), vout: 0, sat: '500000' }, PK.alice);
  await ok({ t: clock.t, as: ADDR.bob, k: 'burnClaim', txid: 'b'.repeat(64), vout: 0, sat: '500000' }, PK.bob);
  await ok({ t: clock.t, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '200000', minOut: '1' }, PK.alice);
  // CAP, so that a `post` act can be lawful to the rulebook and still be refused
  // by the host for the one reason only the host can see: the bytes.
  await ok({ t: clock.t, as: ADDR.alice, k: 'capBuy', ptp: '10000000000000000' }, PK.alice);

  return { srv, clock, send, ok };
}

/** What the rulebook says about an act, asked exactly the way the writer asks
 * it: over the live world, with the index the act is about to receive. */
const rulebookSays = (srv, signed) => actError(srv.world, { ...signed, i: srv.log.nextIndex });

test('the host refuses exactly what actError refuses, code for code', async (t) => {
  const { srv, clock, send } = await writer(t);
  const T = clock.t;
  const hex64 = 'e'.repeat(64);

  // Twenty-six acts that are wrong for twenty-six different reasons, every one of
  // them correctly signed by the address it claims. The signature is correct on
  // purpose: an unsigned act is refused at the door, before the rulebook is ever
  // asked, and would test nothing about whether the two agree.
  const cases = [
    ['UNKNOWN_ACT_KIND', { t: T, as: ADDR.alice, k: 'teleport' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.bob, k: 'like', pid: 'p1', extra: 1 }, PK.bob],
    ['UNKNOWN_ACCOUNT', { t: T, as: ADDR.dave, k: 'like', pid: 'p1' }, PK.dave],
    ['ALREADY_REGISTERED', { t: T, as: ADDR.alice, k: 'register', handle: 'alice2' }, PK.alice],
    ['HANDLE_INVALID', { t: T, as: ADDR.carol, k: 'register', handle: 'NOT valid!' }, PK.carol],
    ['HANDLE_TAKEN', { t: T, as: ADDR.carol, k: 'register', handle: 'alice' }, PK.carol],
    ['BAD_AMOUNT', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '0', minOut: '0' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.alice, k: 'swap', sell: 'eth', amt: '10', minOut: '0' }, PK.alice],
    ['INSUFFICIENT_RESERVE', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '999999999999', minOut: '0' }, PK.alice],
    ['INSUFFICIENT_PTP', { t: T, as: ADDR.alice, k: 'swap', sell: 'ptp', amt: '9'.repeat(30), minOut: '0' }, PK.alice],
    ['SLIPPAGE_EXCEEDED', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '1000', minOut: '9'.repeat(30) }, PK.alice],
    ['INSUFFICIENT_SHARES', { t: T, as: ADDR.alice, k: 'liqRemove', shares: '1' }, PK.alice],
    ['POST_NOT_FOUND', { t: T, as: ADDR.bob, k: 'view', pid: 'p999', dwellMs: 2000, seq: 0 }, PK.bob],
    ['POST_NOT_FOUND', { t: T, as: ADDR.bob, k: 'like', pid: 'p999' }, PK.bob],
    ['POST_NOT_FOUND', { t: T, as: ADDR.bob, k: 'comment', pid: 'p999', text: 'hello' }, PK.bob],
    ['POST_NOT_FOUND', { t: T, as: ADDR.alice, k: 'extend', pid: 'p999', days: 1 }, PK.alice],
    ['POST_NOT_FOUND', { t: T, as: ADDR.bob, k: 'settle', pid: 'p999' }, PK.bob],
    ['COMMENT_TOO_LONG', { t: T, as: ADDR.bob, k: 'comment', pid: 'p999', text: 'x'.repeat(MAX_COMMENT_CHARS + 1) }, PK.bob],
    ['BAD_REQUEST', { t: T, as: ADDR.bob, k: 'comment', pid: 'p999', text: '' }, PK.bob],
    ['MIME_REFUSED', { t: T, as: ADDR.alice, k: 'post', cid: hex64, bytes: 100, mime: 'image/gif', w: 4, h: 4, viewPriceNano: '100000', days: 1 }, PK.alice],
    ['PAYLOAD_TOO_LARGE', { t: T, as: ADDR.alice, k: 'post', cid: hex64, bytes: 9000000, mime: 'image/png', w: 4, h: 4, viewPriceNano: '100000', days: 1 }, PK.alice],
    ['RULES_KEY_ONLY', { t: T, as: ADDR.alice, k: 'rulesSet', version: 'v1', hash: hex64, fromEpoch: 9 }, PK.alice],
    ['EPOCH_NOT_CLOSED', { t: T, as: ADDR.alice, k: 'closeEpoch' }, PK.alice],
    ['CAPACITY_PLEDGE_UNPROVEN', { t: T, as: ADDR.alice, k: 'capClaim' }, PK.alice],
    ['BAD_AMOUNT', { t: T, as: ADDR.alice, k: 'capBuy', ptp: '0' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.alice, k: 'capPledge', mb: 0, endpoint: 'https://x.example' }, PK.alice],
  ];
  assert.ok(cases.length >= 20, 'rule 2 is not worth asserting on fewer than twenty acts');

  const before = srv.log.count;
  const mismatches = [];
  const codes = new Set();

  for (const [expected, body, pk] of cases) {
    const signed = signAct(body, pk);
    const rule = rulebookSays(srv, signed);
    const host = await send(signed);

    if (!rule) {
      // The one direction that is never lawful in this list: if the rulebook
      // sees nothing wrong, the host has no business inventing a refusal here,
      // and if the host accepted it then the case is not the refusal it claims.
      mismatches.push({ k: body.k, expected, actError: null, host: host.ok ? 'ACCEPTED' : host.code });
      continue;
    }
    if (host.ok) {
      // THE FORK. The host wrote a line every future replay will skip.
      mismatches.push({ k: body.k, expected, actError: rule.code, host: 'ACCEPTED — THIS IS THE FORK' });
      continue;
    }
    if (rule.code !== host.code) mismatches.push({ k: body.k, actError: rule.code, host: host.code });
    else if (rule.code !== expected) mismatches.push({ k: body.k, expected, got: rule.code });
    else codes.add(rule.code);

    assert.ok(Object.prototype.hasOwnProperty.call(E, host.code), `${host.code} is not in the catalogue`);
  }

  assert.deepEqual(mismatches, [], 'the host and the rulebook must answer identically');
  // A comparison where every answer is the same code proves nothing, so the
  // spread is asserted too: these acts are wrong in many distinct ways.
  assert.ok(codes.size >= 15, `only ${codes.size} distinct codes — the cases are not distinguishing enough`);
  assert.equal(srv.log.count, before, 'a refused act reached the log');
});

test('the host may refuse more — signature, bytes, bitcoin and a clock — and only more', async (t) => {
  const { srv, clock, send } = await writer(t);
  const T = clock.t;

  // Four acts the RULEBOOK is happy with and this host is not. Every one of them
  // turns on something replay cannot consult without giving up purity: who really
  // signed it, whether the bytes exist, what bitcoin says, and what time it is
  // here. These are the whole of the lawful asymmetry.
  const wider = [
    {
      why: 'a signature is arithmetic over a key replay never sees',
      code: 'BAD_SIGNATURE',
      // A perfectly lawful registration, signed by dave and claiming to be
      // carol. The body is exactly what the rulebook accepts; only the curve
      // knows it was the wrong hand.
      signed: signAct({ t: T, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.dave),
    },
    {
      why: 'the picture is bytes on a disk, and replay reads no disk',
      code: 'CID_MISMATCH',
      signed: signAct(
        { t: T, as: ADDR.alice, k: 'post', cid: 'c'.repeat(64), bytes: 2000, mime: 'image/png', w: 40, h: 30, viewPriceNano: '100000', days: 1 },
        PK.alice,
      ),
    },
    {
      why: 'bitcoin is a network, and replay reads no network',
      code: 'BURN_NOT_KEYLESS',
      signed: signAct({ t: T, as: ADDR.bob, k: 'burnClaim', txid: 'f'.repeat(64), vout: 0, sat: '500000' }, PK.bob),
    },
    {
      why: 'a stamp far from this clock is a clock, and replay reads no clock',
      code: 'TIMESTAMP_IMPLAUSIBLE',
      signed: signAct({ t: T + 40 * 24 * 3600 * 1000, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.carol),
    },
  ];

  const before = srv.log.count;
  for (const c of wider) {
    // The signature case is the one exception to "ask the rulebook first": the
    // body it carries is lawful, and that is exactly the point being made.
    const rule = rulebookSays(srv, c.signed);
    assert.equal(rule, null, `${c.code}: the rulebook already refuses this, so it is not an asymmetry — ${c.why}`);

    const host = await send(c.signed);
    assert.equal(host.ok, false, `${c.code}: the host accepted an act only it can check — ${c.why}`);
    assert.equal(host.code, c.code, JSON.stringify(host.detail));
    assert.ok(Object.prototype.hasOwnProperty.call(E, host.code), `${host.code} is not in the catalogue`);
  }
  assert.equal(srv.log.count, before, 'one of them was written anyway');
});

test('and the asymmetry runs one way only: nothing the rulebook refuses is ever written', async (t) => {
  const { srv, clock, send, ok } = await writer(t);

  // The direction that is never lawful, swept rather than argued. Every act the
  // rulebook refuses is offered to the host, and the host's log must not grow by
  // a single line — because a line the rulebook skips is a line whose effects
  // exist on this host and nowhere else.
  const T = clock.t;
  const offers = [
    { t: T, as: ADDR.bob, k: 'view', pid: 'p999', dwellMs: 2000, seq: 0 },
    { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '-1', minOut: '0' },
    { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '1e9', minOut: '0' },
    { t: T, as: ADDR.alice, k: 'capBuy', ptp: '0.5' },
    { t: T, as: ADDR.alice, k: 'liqAdd', sat: '0', ptp: '0' },
    { t: T, as: ADDR.bob, k: 'register', handle: 'bob' },
    { t: T, as: ADDR.alice, k: 'rulesSet', version: 'v1', hash: 'e'.repeat(64), fromEpoch: 0 },
    { t: T, as: ADDR.alice, k: 'settle', pid: 'p1' },
  ];

  const before = srv.log.count;
  const worldBefore = srv.world;
  let refused = 0;
  for (const body of offers) {
    const signed = signAct(body, body.as === ADDR.bob ? PK.bob : PK.alice);
    const rule = rulebookSays(srv, signed);

    if (!rule) continue; // not part of this claim; the parity test covers those
    refused++;
    const host = await send(signed);
    assert.equal(host.ok, false, `the host accepted ${body.k}, which replay skips — this is the fork`);
    assert.equal(host.code, rule.code);
  }
  assert.ok(refused >= 6, 'the sweep did not actually exercise the direction it claims to');
  assert.equal(srv.log.count, before, 'the log grew on acts the rulebook refuses');
  assert.equal(srv.world, worldBefore, 'the world object was replaced by a refused act');

  // And the door still works: an act both readers accept is still accepted, so
  // this file cannot pass by refusing everything.
  await ok({ t: clock.t, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.carol);
  assert.equal(srv.log.count, before + 1);
});

// ── 4. THE BROWSER CAN ACTUALLY FETCH IT ───────────────────────────────────
//
// The three claims above are all about the module graph inside one Node process.
// They were all green while the app was broken in every browser, because
// app/app.mjs imports `../core/replay.mjs` and the host served nothing under
// /core/ — so the client died at its first import and never ran.
//
// That is the whole failure mode this rule exists to prevent, reached from the
// one direction the other tests cannot see: sharing a file is not the same as
// being able to GET it. test/client.test.mjs imports core/ from disk and every
// end-to-end check drove the API rather than the page, so nothing noticed.
//
// A rule enforced only where it is convenient to test is not enforced.

test('the browser can fetch the rulebook, and gets the same bytes the host runs', async (t) => {
  const { srv } = await writer(t);
  // The harness never binds a port — every other test in this file talks to
  // srv.submit() directly. A browser cannot, which is the point of these two.
  const { url } = await srv.listen(0);
  const origin = url.replace(/\/$/, '');

  // Every core module app/ imports, resolved the way a browser resolves it: the
  // page is served at the root, so `../core/x.mjs` from /app.mjs is /core/x.mjs.
  const imported = new Set();
  for (const file of ['app.mjs', 'storage.mjs', 'wallet.mjs']) {
    const src = readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/from\s+'\.\.\/(core\/[A-Za-z0-9_./-]+\.mjs)'/g)) imported.add(m[1]);
  }
  assert.ok(imported.has('core/replay.mjs'), 'the client must import the rulebook at all');
  assert.ok(imported.size >= 5, `expected the client to share several core modules, saw ${imported.size}`);

  for (const rel of imported) {
    const res = await fetch(`${origin}/${rel}`);
    assert.equal(res.status, 200, `${rel} must be fetchable — the client cannot run without it`);
    assert.match(res.headers.get('content-type') || '', /javascript/, `${rel} must be served as a module`);

    // The same bytes, not a faithful-looking copy. Two byte-identical files at
    // two paths would still be two rulebooks; here it must be the one on disk.
    const served = Buffer.from(await res.arrayBuffer());
    const disk = readFileSync(new URL(`../${rel}`, import.meta.url));
    assert.equal(
      createHash('sha256').update(served).digest('hex'),
      createHash('sha256').update(disk).digest('hex'),
      `${rel} served differs from ${rel} on disk`
    );
  }

  // And the copy the browser is handed is the edition a block seals, so a reader
  // can check what they were served rather than trust it.
  const servedReplay = Buffer.from(await (await fetch(`${origin}/core/replay.mjs`)).arrayBuffer());
  assert.equal(createHash('sha256').update(servedReplay).digest('hex'), EDITION);
});

test('opening core/ to the browser does not open anything else', async (t) => {
  const { srv } = await writer(t);
  const { url } = await srv.listen(0);
  const origin = url.replace(/\/$/, '');

  // The static root for core/ exists so the browser can import the rulebook, not
  // so the process directory becomes browsable. Traversal is refused on the
  // RESOLVED path, so encoded and unencoded forms fall the same way.
  const forbidden = [
    '/core/../server/index.mjs',
    '/core/%2e%2e/package.json',
    '/core/../../package.json',
    '/core/..%2fserver%2findex.mjs',
    '/server/index.mjs',
    '/package.json',
    '/data/acts.jsonl',
    '/core/params.json',      // core/ serves .mjs and nothing else
    '/core/',                 // no directory listing
  ];
  for (const path of forbidden) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 404, `${path} must not be served`);
  }
});

// ── 5. THE CLIENT'S CONTRACT IS THE HOST'S CONTRACT ────────────────────────
//
// Rule 1 says every number is a pure function of the act log. A client that
// cannot GET the log cannot compute any of them and has to believe whatever the
// host's derived views say — which is exactly the trust this design exists to
// remove.
//
// The host did not serve the log at all. app/app.mjs asked for /api/v1/acts on
// every refresh, got a 404, fell through to its archive fallback, and announced
// "No host answered" on the published site while the host was answering
// everything else. 347 tests were green: test/server.test.mjs drives the API and
// never replays, test/client.test.mjs replays and never crosses a socket, and
// the two path constants were only ever compared by a person reading both files.
//
// So this asserts the join. Every path the CLIENT asks for is read out of the
// client's own source and demanded of a real host over HTTP.

test('every path the client fetches, the host actually serves', async (t) => {
  const { srv } = await writer(t);
  const { url } = await srv.listen(0);
  const origin = url.replace(/\/$/, '');

  // Read the client's own constants rather than restating them here: a test that
  // hardcodes the path cannot catch the two files drifting apart, which is the
  // failure it exists to catch.
  const src = readFileSync(new URL('../app/app.mjs', import.meta.url), 'utf8');
  const paths = [...src.matchAll(/^const [A-Z_]+_PATH = '(\/api\/[^']+)';/gm)].map((m) => m[1]);
  assert.ok(paths.length > 0, 'the client must declare the API paths it depends on as constants');
  assert.ok(paths.includes('/api/v1/acts'), 'the client must fetch the act log');

  for (const path of paths) {
    // Some of these are read paths and some are the write door, so the route is
    // considered present if EITHER verb reaches it. What is being asserted is
    // that the host routes it at all — the failure this catches was a path the
    // client asks for on every refresh and the host had never heard of.
    const get = await fetch(origin + path);
    const post = get.status === 404
      ? await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      : null;
    const routed = get.status !== 404 || (post && post.status !== 404);
    assert.ok(routed, `the client uses ${path} and this host answers 404 to both GET and POST`);
  }
});

test('the act log is served verbatim, and replaying it reproduces the host', async (t) => {
  const { srv } = await writer(t);
  const { url } = await srv.listen(0);
  const origin = url.replace(/\/$/, '');

  const res = await fetch(origin + '/api/v1/acts');
  assert.ok(res.ok);
  assert.match(res.headers.get('content-type') || '', /ndjson/);
  const body = await res.text();
  const lines = body.split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'the staged world put acts in the log');
  assert.equal(res.headers.get('x-ptp-acts'), String(lines.length));

  // The bytes are the bytes the writer appended, not a re-serialisation of the
  // parsed values. That is what lets a verifier check a root against what it was
  // handed rather than against something that merely looks the same.
  assert.equal(body, readFileSync(srv.log.path, 'utf8'));

  // And because it is the log, replaying it gives the host's own world back —
  // which is Rule 1 stated as an assertion a stranger could run.
  const mine = replay(lines.map((l) => parseCanonical(l)), PARAMS);
  assert.equal(mine.epoch.n, srv.world.epoch.n);
  assert.equal(mine.supply.burned, srv.world.supply.burned);
  assert.equal(Object.keys(mine.accounts).length, Object.keys(srv.world.accounts).length);
  assert.equal(Object.keys(mine.posts).length, Object.keys(srv.world.posts).length);
});

test('the host publishes a burn address a person can actually send to', async (t) => {
  const { srv } = await writer(t);
  const { url } = await srv.listen(0);
  const body = await (await fetch(url.replace(/\/$/, '') + '/api/v1/burn')).json();

  // Rule 3 makes burn the only way in, so this field is the network's front
  // door. It published only `scriptHex` — the truth, but not something anybody
  // can paste into a wallet — and the app said "this host publishes no burn
  // address" as a result.
  assert.match(body.burnAddress, /^bc1[02-9ac-hj-np-z]{39,71}$/, 'a bech32 P2WSH address');
  assert.equal(body.burnAddress, bech32Address(Buffer.from(body.scriptHex.slice(4), 'hex')));

  // And it is really the script's own address, checked against BIP-173's own
  // vector rather than against this implementation's opinion of itself.
  assert.equal(
    bech32Address(Buffer.from('1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262', 'hex')),
    'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'
  );
});
