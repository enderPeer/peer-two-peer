// The encoding either produces one byte string per value or refuses. These
// tests are the "no third outcome" clause of ARCHITECTURE §9 read as
// assertions: same value, same bytes, regardless of how the object was built;
// and anything that cannot be represented exactly comes back as an Error rather
// than as a plausible-looking digest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonicalJson, canonicalBytes, sha256Hex, QUANTUM, MAX_DEPTH } from '../core/canonical.mjs';

test('key order is irrelevant; nesting and arrays keep their own order', () => {
  const a = { b: 2, a: 1, c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: 1, b: 2 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":1,"b":2,"c":{"y":2,"z":1}}');
  assert.equal(sha256Hex(canonicalBytes(a)), sha256Hex(canonicalBytes(b)));

  // Arrays are ordered data, not a set: their order is content and is kept.
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));

  // Sorting is by UTF-16 code unit, so uppercase precedes lowercase and digits
  // precede both. Stated as a test because "sorted" alone is not a spec.
  assert.equal(canonicalJson({ b: 0, A: 0, a: 0, B: 0, 1: 0 }), '{"1":0,"A":0,"B":0,"a":0,"b":0}');

  // A key that is absent and a key explicitly undefined encode alike, which is
  // what JSON.stringify does and what a reader expects.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: undefined }));
});

test('non-finite numbers are refused, not nulled', () => {
  // JSON.stringify writes null for all three, which hashes three different
  // corruptions to one digest and loses the fact that anything went wrong.
  assert.equal(JSON.stringify({ x: NaN }), '{"x":null}');
  assert.throws(() => canonicalJson(NaN), /non-finite/);
  assert.throws(() => canonicalJson(Infinity), /non-finite/);
  assert.throws(() => canonicalJson(-Infinity), /non-finite/);
  assert.throws(() => canonicalJson({ x: NaN }), /non-finite/);
  assert.throws(() => canonicalJson([1, Infinity]), /non-finite/);
  assert.throws(() => canonicalJson({ a: { b: [NaN] } }), /non-finite/);
});

test('everything else the encoding cannot represent is refused too', () => {
  assert.throws(() => canonicalJson(undefined), /undefined/);
  assert.throws(() => canonicalJson([1, undefined]), /undefined in array/);
  assert.throws(() => canonicalJson(() => 1), /cannot encode function/);
  assert.throws(() => canonicalJson(Symbol('x')), /cannot encode symbol/);
  assert.throws(() => canonicalJson(new Date(0)), /Date/);
  assert.throws(() => canonicalJson(new Map()), /Map/);
  assert.throws(() => canonicalJson(new Set()), /Set/);
  assert.throws(() => canonicalJson(new Uint8Array([1, 2])), /Uint8Array/);

  // The refusal is a whitelist, not a list of known offenders. Every one of
  // these used to encode to "{}" — and two of them to the SAME "{}", which is a
  // collision between distinct values rather than merely a lossy encoding.
  assert.throws(() => canonicalJson(new Number(5)), /Number/);
  assert.throws(() => canonicalJson(new Boolean(true)), /Boolean/);
  assert.throws(() => canonicalJson(new String('ab')), /String/);
  assert.throws(() => canonicalJson(/abc/g), /RegExp/);
  assert.throws(() => canonicalJson(new Error('x')), /Error/);
  assert.throws(() => canonicalJson(Object.create({ inherited: 1 })), /prototype/);
  // A null-prototype object is a plain bag of keys and is admitted.
  assert.equal(canonicalJson(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');

  const cycle = { a: 1 };
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /cycle/);
  // The same object twice is not a cycle and must still encode.
  const shared = { a: 1 };
  assert.equal(canonicalJson({ x: shared, y: shared }), '{"x":{"a":1},"y":{"a":1}}');
});

test('bigint round-trips as a sigilled decimal string, with every digit intact', () => {
  // The leading "~" is the domain tag that keeps a bigint and its own decimal
  // string apart; see the sigil note in core/canonical.mjs.
  assert.equal(canonicalJson(0n), '"~0"');
  assert.equal(canonicalJson(-7n), '"~-7"');
  assert.equal(canonicalJson(10000n * 10n ** 18n), '"~10000000000000000000000"');

  // Past 2^53 a JSON number would silently lose the low digits. This is the
  // whole reason money is quoted: the value that comes back is the value that
  // went in.
  const wei = 123456789012345678901234567890n;
  const back = BigInt(JSON.parse(canonicalJson({ ptp: wei })).ptp.slice(1));
  assert.equal(back, wei);
  assert.notEqual(String(Number(wei)), wei.toString(10));

  assert.equal(
    canonicalJson({ sat: 1000000n, ptp: 10n ** 22n }),
    '{"ptp":"~10000000000000000000000","sat":"~1000000"}'
  );
});

test('the encoding is injective: a bigint and its own digits never collide', () => {
  // This is the property the whole chain rests on. It failed once: 1000000n and
  // "1000000" both encoded to {"sat":"1000000"}, so two verifiers could agree on
  // a stateRoot while holding different worlds — the third outcome §9 says
  // cannot exist.
  assert.notEqual(canonicalJson(42n), canonicalJson('42'));
  assert.notEqual(
    sha256Hex(canonicalBytes({ sat: 1000000n })),
    sha256Hex(canonicalBytes({ sat: '1000000' }))
  );

  // The escape has to be injective too, or the collision just moves one step
  // along: a string that already begins with the sigil gets one more.
  assert.equal(canonicalJson(5n), '"~5"');
  assert.equal(canonicalJson('~5'), '"~~5"');
  assert.equal(canonicalJson('~~5'), '"~~~5"');
  assert.notEqual(canonicalJson('~5'), canonicalJson(5n));

  // Sweep the neighbourhood: every distinct value below must encode distinctly.
  const values = [0n, -0n, 1n, 42n, '0', '42', '~42', '~~42', 0, 42, '~', '', [42n], ['42']];
  const seen = new Map();
  for (const v of values) {
    const enc = canonicalJson(v);
    if (seen.has(enc)) {
      // 0n and -0n are the same bigint; that is JavaScript, not the encoder.
      assert.equal(String(seen.get(enc)), String(v), `collision: ${enc}`);
    }
    seen.set(enc, v);
  }
});

test('nesting is bounded, so one hostile act cannot halt every reader', () => {
  // The log is public and append-only, so this encoder is reachable by anyone.
  // Unbounded recursion turned a single 20,000-deep array into a crash for the
  // writer AND for every reader replaying past it.
  let deep = [];
  let cur = deep;
  for (let i = 0; i < 20000; i++) {
    const next = [];
    cur.push(next);
    cur = next;
  }
  assert.throws(() => canonicalJson(deep), /deeper than 64/);

  // The bound is published, so verifiers share it rather than discovering it.
  assert.equal(typeof MAX_DEPTH, 'number');
  const atLimit = JSON.parse('[' .repeat(MAX_DEPTH - 1) + '1' + ']'.repeat(MAX_DEPTH - 1));
  assert.doesNotThrow(() => canonicalJson(atLimit));
});

test('the quantum is applied, and only where it belongs', () => {
  assert.equal(QUANTUM, 1e-9);

  // The classic double: 0.1 + 0.2 is not 0.3, and both must hash alike.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(canonicalJson(0.1 + 0.2), '0.3');
  assert.equal(canonicalJson(0.1 + 0.2), canonicalJson(0.3));

  // Anything below half a quantum is rounded away.
  assert.equal(canonicalJson(1 + 4e-10), '1');
  assert.equal(canonicalJson(1 + 6e-10), '1.000000001');
  assert.equal(canonicalJson(-0.0000000004), '0');
  // Two engines disagreeing in the last bits of a transcendental land together.
  assert.equal(canonicalJson(0.30000000000000004), canonicalJson(0.29999999999999993));

  // Negative zero carries no information here and must not change a hash.
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson(-0), canonicalJson(0));

  // Integers pass through untouched, including large ones, so no digit is lost
  // to a rounding step that was only ever meant for inexact values.
  assert.equal(canonicalJson(9007199254740993), '9007199254740992'); // the double itself
  assert.equal(canonicalJson(1e21), '1e+21');
  assert.equal(canonicalJson(123456), '123456');

  // Shortest round-trip form, which is what Number::toString specifies.
  assert.equal(canonicalJson(1.5), '1.5');
  assert.equal(canonicalJson(0.000001), '0.000001');
  assert.equal(canonicalJson(1e-7), '1e-7');
});

test('canonicalBytes is UTF-8 of canonicalJson, and sha256Hex hashes bytes', () => {
  const v = { handle: 'ünïcøde', n: 1n };
  assert.deepEqual(canonicalBytes(v), Buffer.from(canonicalJson(v), 'utf8'));
  assert.equal(sha256Hex(canonicalBytes(v)), createHash('sha256').update(canonicalBytes(v)).digest('hex'));
  assert.equal(sha256Hex(canonicalBytes(v)), sha256Hex(canonicalJson(v)));

  // A known vector, so a rewrite of this file cannot quietly change the
  // encoding: every root in the chain depends on this digest.
  assert.equal(canonicalJson({}), '{}');
  assert.equal(
    sha256Hex(canonicalBytes({})),
    createHash('sha256').update('{}').digest('hex'),
  );
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // Lowercase hex, 64 characters, no "0x": a digest in a JSON document, not an
  // EVM word.
  assert.match(sha256Hex(canonicalBytes(v)), /^[0-9a-f]{64}$/);
});

test('an act encodes the same however it was assembled', () => {
  // The shape from ARCHITECTURE §4, built in two orders, one of them through a
  // getter that only settles when it is read.
  const a = { i: 1042, t: 1786445193465, as: '0x7a', k: 'view', pid: 3, dwellMs: 1200, seq: 1 };
  const b = {};
  b.seq = 1;
  b.dwellMs = 1200;
  Object.defineProperty(b, 'pid', { get: () => 3, enumerable: true });
  b.k = 'view';
  b.as = '0x7a';
  b.t = 1786445193465;
  b.i = 1042;
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Hex(canonicalBytes(a)), sha256Hex(canonicalBytes(b)));
});
