#!/usr/bin/env node
// Close an epoch by hand.
//
//   node server/scripts/close-epoch.mjs --key 0x<32 bytes> [--url http://127.0.0.1:8787] [--dry]
//
// An epoch closes because an ACT LANDED, never because a clock said so
// (ARCHITECTURE §0). This script builds that act, signs it with a key it is
// given, and posts it through the same door every other act goes through. It has
// no privileges: `closeEpoch` is permissionless among registered accounts, the
// same way settling a lapsed post is, so that a network whose writer is asleep
// still closes its epochs. What makes that safe is the time bound inside the
// rulebook — the act is refused until the epoch's own length has elapsed — and
// not any check made here.
//
// It is deliberately a thin script. It reads the writer's status, refuses early
// if the epoch is not due, prints what it is about to send, sends it, and prints
// what happened. The emission, the rebates, the rate seal and the counter resets
// all happen inside core/replay.mjs when the act lands; nothing in this file
// computes any of them, because a second implementation of an epoch close is a
// second answer to what an epoch closed with.
//
// ── ONE HONEST LIMITATION, STATED WHERE THE OPERATOR WILL SEE IT ───────────
//
// This script does NOT seal a fresh EUR/BTC rate into the epoch, and it cannot.
// core/replay.mjs's `closeEpoch` hands `act.oracle` to `sealRate`, which requires
// BIGINT source values — and an act is JSON, which has no bigint. Every spelling
// of a rate that can survive JSON (a decimal string, a JSON number) is rejected
// by `sealRate` as ORACLE_STALE, so the only `closeEpoch` act a JSON transport
// can carry is one with no oracle at all, which carries the previous rate
// forward unchanged.
//
// The consequence is precise and worth reading: the epoch still closes, emission
// is still minted, the per-pair view counters still reset, and prices still work
// — but they keep pricing at the rate the network started with until core grows
// a way to carry an integer rate through an act. This script therefore reads the
// writer's live oracle anyway and PRINTS the divergence, so the operator can see
// how far the sealed rate has drifted from the market rather than discovering it
// in a fee.

import { readFileSync } from 'node:fs';
import { addressOf, signAct } from '../index.mjs';
import { formatEur } from '../../core/pricing.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const url = String(arg('url', process.env.PTP_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const dry = Boolean(arg('dry', false));
const keyFile = arg('key-file', process.env.PTP_KEY_FILE);
let key = arg('key', process.env.PTP_CLOSE_KEY);
if (!key && keyFile) key = readFileSync(String(keyFile), 'utf8').trim();

if (!key || typeof key !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  die(
    [
      'close-epoch needs a key to sign with.',
      '',
      '  --key 0x<64 hex>        the private key of a REGISTERED account',
      '  --key-file <path>       the same, read from a file',
      '  PTP_CLOSE_KEY / PTP_KEY_FILE are read too',
      '',
      'The account needs no privilege beyond being registered: closing an epoch is',
      'permissionless, so that a network whose writer is asleep still closes.',
    ].join('\n'),
  );
}

const as = addressOf(key);

async function get(path) {
  const res = await fetch(url + path);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const status = await get('/api/v1/status').catch((err) => die(`cannot reach the writer at ${url}: ${err.message}`));
if (status.status !== 200) die(`the writer at ${url} answered ${status.status} for /api/v1/status`);

const { epoch, log } = status.body;
const now = Date.now();
const dueIn = epoch.opensAt - now;

process.stdout.write(
  [
    `writer   ${url}`,
    `signer   ${as}`,
    `epoch    ${epoch.n}, opened ${new Date(epoch.startedAt).toISOString()}, ${epoch.acts} acts, ${epoch.burnedWei} wei burned`,
    `closes   ${new Date(epoch.opensAt).toISOString()}${dueIn > 0 ? `  (in ${Math.ceil(dueIn / 1000)}s)` : '  (due now)'}`,
    `log      ${log.count} acts, ${log.skipped} skipped by replay`,
    '',
  ].join('\n'),
);

// The writer's own signed reading, for the divergence note. A failure here is
// not fatal: the close does not depend on it, and saying so is the point.
const oracle = await get('/api/v1/oracle').catch(() => ({ status: 0, body: {} }));
if (oracle.status === 200 && oracle.body.eurPerBtcNano && oracle.body.sealed) {
  const live = BigInt(oracle.body.eurPerBtcNano);
  const sealed = BigInt(oracle.body.sealed.eurPerBtcNano);
  const driftBps = sealed === 0n ? 0n : ((live - sealed) * 10000n) / sealed;
  const lines = [
    `oracle   live ${formatEur(live)} / BTC from ${oracle.body.answered}/${oracle.body.sources.length} sources`,
    `         sealed ${formatEur(sealed)} / BTC — drift ${driftBps} bps`,
  ];
  if (oracle.body.clamped) lines.push('         the live reading was CLAMPED by the per-epoch move limit');
  lines.push('         this close carries the sealed rate forward: core/replay.mjs cannot take a rate through a JSON act.');
  process.stdout.write(lines.join('\n') + '\n\n');
}

// A world where nothing has happened has no epoch to seal. core/replay.mjs
// refuses the very first act of a network being a close, and says so with
// EPOCH_NOT_CLOSED and `acts: 0` — worth catching here so an operator is not
// told the epoch is "due now" on the strength of a start time of zero.
if (epoch.startedAt === 0 && !dry) {
  die('refusing to send: nothing has happened on this network yet, so there is no epoch to seal. The genesis epoch starts with its first act.');
}

if (dueIn > 0 && !dry) {
  die(
    `refusing to send: the epoch is not due for another ${Math.ceil(dueIn / 1000)}s, and core/replay.mjs would answer EPOCH_NOT_CLOSED.\nRun with --dry to see the act anyway.`,
  );
}

// No `oracle` field. See the note at the head of this file: an act carrying one
// is refused by the rulebook, and a rate carried forward is the honest outcome
// rather than a rate this script invented.
const act = signAct({ t: now, as, k: 'closeEpoch' }, key);

process.stdout.write(`act      ${JSON.stringify(act)}\n\n`);
if (dry) {
  process.stdout.write('dry run — nothing sent.\n');
  process.exit(0);
}

const res = await fetch(url + '/api/v1/act', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(act),
});
const body = await res.json().catch(() => ({}));

if (!res.ok || body.ok !== true) {
  process.stderr.write(
    [
      `refused ${res.status} ${body.code || ''}`,
      body.msg ? `  ${body.msg}` : '',
      body.why ? `  why:  ${body.why}` : '',
      body.next ? `  next: ${body.next}` : '',
      body.detail ? `  detail: ${JSON.stringify(body.detail)}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  process.exit(1);
}

const after = await get('/api/v1/status');
process.stdout.write(
  [
    `closed   epoch ${epoch.n} sealed as act ${body.i}`,
    `now      epoch ${after.body.epoch.n}, supply emitted ${after.body.supply.emitted}, burned ${after.body.supply.burned}`,
    '',
  ].join('\n'),
);
