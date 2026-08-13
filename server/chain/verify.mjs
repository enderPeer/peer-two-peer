// Replay everything. Check every root and every signature. Need nobody's help.
//
//   node server/chain/verify.mjs                  the record in ./data
//   node server/chain/verify.mjs --dir <record>   a record fetched from anywhere
//
// This is the program that makes the rest of the network checkable. It takes a
// directory holding `acts.jsonl` and `chain.json`, replays the log under the same
// rulebook the producer ran, reseals every epoch, and compares. It opens no
// socket, reads no clock, and holds no key — the public half travels in each
// block as `producer`, so a machine that has never signed anything can hold the
// producer to their own signature.
//
// Exit 0 means: every block reproduces from the log, every root matches its own
// contents, every signature checks, and one producer published the whole chain.
// Exit non-zero means at least one of those is false, and the report says which
// block, which field, and where possible which act.
//
// An EMPTY record verifies. A fresh fork with no acts and no blocks is a valid
// record of nothing, and refusing it would break the one case that has to work
// before anybody has done anything.
//
// ── WHAT COUNTS AS A FAILURE, AND WHAT COUNTS AS A WARNING ─────────────────
//
// A log AHEAD of the chain is a warning. Acts land continuously and blocks are
// sealed at a close, so a record fetched between the two is normally in exactly
// this state — and a verifier that failed on it would fail on most honest
// records. A chain ahead of the log is a failure: a block exists for a close the
// log cannot produce, which is either a truncated log or a rewritten one.
//
// EDITION DRIFT is reported per block and, on its own, is not fatal. A block
// names the sha256 of the two files that computed it; if this checkout's files
// hash differently but the state still reproduces bit for bit, the two editions
// agree about this record and the honest report is exactly that. What drift costs
// is the guarantee that they agree about EVERY record, so it is printed loudly
// and `--strict-editions` makes it fatal for a caller who wants that guarantee.
//
// A PRODUCER CHANGE inside one chain is a failure. An internally consistent
// forgery signed by a different key verifies perfectly on its own terms; the only
// thing that distinguishes it from the record is that the record was always
// signed by one key. A genuine handover of the pen is a human act and is declared
// with --allow-producer-change.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { orderedRootOf } from '../../core/merkle.mjs';
import {
  BLOCK_VERSION,
  GENESIS_PREV,
  blockDifference,
  blockHash,
  digestOf,
  editionsOf,
  isDigest,
  parseActLog,
  parseChain,
  payloadOf,
  payloadView,
  sealEpoch,
  signingBytes,
  walkLog,
} from './block.mjs';
import { pinnedPublicHex, verifyBytes } from './keys.mjs';

export const ACTS_FILE = 'acts.jsonl';
export const CHAIN_FILE = 'chain.json';

export function defaultDir() {
  return process.env.PTP_DATA_DIR || 'data';
}

const REQUIRED_FIELDS = [
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
  'producer',
  'sig',
];

/**
 * Everything a block claims about itself, checked without the log.
 *
 * This half needs no replay: the roots have to match the lists the block itself
 * carries, the state root has to match the package it itself carries, and the
 * signature has to check against the key it itself names. A block that fails here
 * is internally inconsistent and the log has nothing to do with it.
 *
 * A chain document may have been fetched from a stranger, so every step that
 * encodes part of it is allowed to fail: canonical encoding refuses a value it
 * cannot represent exactly, and a nesting depth past the published bound. A
 * verifier that crashed on hostile input would be a verifier an attacker can
 * stop, so a throw becomes a refusal like any other.
 */
function checkBlockAlone(block, height, problems) {
  const at = (code, message, detail) => problems.push({ code, height, message, detail: detail || null });

  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    at('BLOCK_MALFORMED', 'the entry is not an object');
    return false;
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(block, field)) {
      at('BLOCK_MALFORMED', `field "${field}" is missing`);
      return false;
    }
  }
  if (block.v !== BLOCK_VERSION) {
    at('BLOCK_VERSION_UNKNOWN', `block format v${block.v}; this build reads v${BLOCK_VERSION}`);
    return false;
  }
  if (block.height !== height) {
    at('BLOCK_HEIGHT_OUT_OF_ORDER', `block sits at position ${height} and calls itself height ${block.height}`);
    return false;
  }
  if (!Array.isArray(block.acts) || !Array.isArray(block.payloads)) {
    at('BLOCK_MALFORMED', 'acts and payloads must be arrays of digests');
    return false;
  }
  if (block.acts.length !== block.payloads.length) {
    at(
      'BLOCK_MALFORMED',
      `${block.acts.length} structural commitments against ${block.payloads.length} payload commitments; ` +
        'each act is committed exactly twice',
    );
    return false;
  }

  let ok = true;
  try {
    const derivedActsRoot = orderedRootOf(block.acts);
    if (derivedActsRoot !== block.actsRoot) {
      at('ACTS_ROOT_MISMATCH', `actsRoot says ${block.actsRoot} and its own list roots to ${derivedActsRoot}`);
      ok = false;
    }
  } catch (err) {
    at('ACTS_ROOT_MISMATCH', `the acts list is not a list of digests: ${err.message}`);
    ok = false;
  }
  try {
    const derivedPayloadsRoot = orderedRootOf(block.payloads);
    if (derivedPayloadsRoot !== block.payloadsRoot) {
      at(
        'PAYLOADS_ROOT_MISMATCH',
        `payloadsRoot says ${block.payloadsRoot} and its own list roots to ${derivedPayloadsRoot}`,
      );
      ok = false;
    }
  } catch (err) {
    at('PAYLOADS_ROOT_MISMATCH', `the payloads list is not a list of digests: ${err.message}`);
    ok = false;
  }

  try {
    const derivedStateRoot = digestOf(block.package);
    if (derivedStateRoot !== block.stateRoot) {
      at('STATE_ROOT_MISMATCH', `stateRoot says ${block.stateRoot} and its own package hashes to ${derivedStateRoot}`);
      ok = false;
    }
  } catch (err) {
    at('BLOCK_MALFORMED', `the state package cannot be encoded: ${err.message}`);
    return false;
  }

  if (!isDigest(block.prev) && block.prev !== GENESIS_PREV) {
    at('BLOCK_MALFORMED', 'prev is not a digest');
    ok = false;
  }

  let signed = false;
  try {
    signed = verifyBytes(block.producer, signingBytes(block), block.sig);
  } catch (err) {
    at('BLOCK_MALFORMED', `the block cannot be encoded for signing: ${err.message}`);
    return false;
  }
  if (!signed) {
    at(
      'BAD_SIGNATURE',
      `the signature does not check against the producer this block names (${String(block.producer).slice(0, 16)}…)`,
      { producer: block.producer },
    );
    ok = false;
  }

  return ok;
}

/**
 * Verify a record: the log, the chain, and the agreement between them.
 *
 * Returns a report. Nothing is printed, nothing is written, nothing is fetched.
 */
export function verifyChain(options = {}) {
  const dir = path.resolve(options.dir || defaultDir());
  const problems = [];
  const warnings = [];
  const actsPath = path.join(dir, ACTS_FILE);
  const chainPath = path.join(dir, CHAIN_FILE);

  let acts = [];
  let chain = [];
  try {
    acts = existsSync(actsPath) ? parseActLog(readFileSync(actsPath, 'utf8')) : [];
  } catch (err) {
    problems.push({ code: 'ACTS_UNREADABLE', height: null, message: err.message, detail: null });
    return report(dir, problems, warnings, 0, 0, null);
  }
  try {
    chain = existsSync(chainPath) ? parseChain(readFileSync(chainPath, 'utf8')) : [];
  } catch (err) {
    problems.push({ code: 'CHAIN_UNREADABLE', height: null, message: err.message, detail: null });
    return report(dir, problems, warnings, acts.length, 0, null);
  }

  // Every block checked against itself first, so a broken block is reported as
  // broken rather than as a disagreement with the log.
  const soundness = chain.map((block, height) => checkBlockAlone(block, height, problems));

  // The producer the record was published under. The pinned public key wins when
  // there is one; otherwise the first block's producer is the record's own claim
  // about itself, which is still enough to catch a key that changes midway.
  const pinned = options.producer || pinnedPublicHex(dir);
  const expectedProducer = pinned || (chain.length > 0 ? chain[0].producer : null);
  const expectedNet = chain.length > 0 && typeof chain[0].net === 'string' ? chain[0].net : null;
  const allowProducerChange = Boolean(options.allowProducerChange);

  let checked = 0;
  let closes = 0;
  let sealedTombstones = 0;

  // One sealed block against what the log produces for its epoch. It is a named
  // function rather than the walk's callback so that a throw out of encoding a
  // hostile block becomes a refusal, and the verifier keeps going through the
  // rest of the chain instead of stopping at the first block somebody crafted.
  const compare = (candidate, sealed, height) => {
    // `prev` is derived from the SEALED predecessor, so a broken link is reported
    // once, at the block whose prev is wrong, instead of cascading through every
    // block after it.
    const prev = height === 0 ? GENESIS_PREV : blockHash(chain[height - 1]);
    const derived = sealEpoch(candidate, { prev, net: sealed.net });
    const diff = blockDifference(sealed, derived);

    if (diff && diff.field === 'acts' && diff.index !== null) {
      const entry = candidate.entries[diff.index];
      const act = entry ? entry.act : null;
      problems.push({
        code: 'ACT_MISMATCH',
        height,
        message:
          `block ${height} (epoch ${candidate.epoch}) commits a different act at position ${diff.index}: ` +
          (act
            ? `log index ${entry.i} is a "${act.k}" from ${act.as} whose structural hash is ${diff.derived}, ` +
              `and the block sealed ${diff.sealed}`
            : `the block sealed ${diff.sealed} and the log has no act at that position`),
        detail: {
          position: diff.index,
          logIndex: entry ? entry.i : null,
          kind: act ? act.k : null,
          as: act ? act.as : null,
          sealed: diff.sealed,
          derived: diff.derived,
        },
      });
    } else if (diff && diff.field === 'payloads' && diff.index !== null) {
      const entry = candidate.entries[diff.index];
      problems.push({
        code: 'PAYLOAD_MISMATCH',
        height,
        message:
          `block ${height} (epoch ${candidate.epoch}) commits a different payload at position ${diff.index}` +
          (entry ? ` (log index ${entry.i}, a "${entry.act.k}")` : ''),
        detail: {
          position: diff.index,
          logIndex: entry ? entry.i : null,
          sealed: diff.sealed,
          derived: diff.derived,
        },
      });
    } else if (diff) {
      problems.push({
        code: 'BLOCK_MISMATCH',
        height,
        message:
          `block ${height} (epoch ${candidate.epoch}) does not reproduce from the log: field "${diff.field}" differs`,
        detail: { field: diff.field, sealed: diff.sealed, derived: diff.derived },
      });
    }

    // The payload residue, re-derived only where the payload survives. After a
    // lawful deletion it cannot be recomputed and is not expected to be: the
    // sealed list is checked against its own root, above, and that is the whole
    // of what a residue can promise.
    for (let k = 0; k < candidate.entries.length; k++) {
      const { act, i } = candidate.entries[k];
      if (Object.keys(payloadView(act)).length === 0) continue;
      const want = sealed.payloads[k];
      if (want === undefined) continue;
      const got = payloadOf(act);
      if (got !== want && !problems.some((p) => p.code === 'PAYLOAD_MISMATCH' && p.height === height)) {
        problems.push({
          code: 'PAYLOAD_MISMATCH',
          height,
          message:
            `block ${height} sealed payload ${want} for log index ${i} (a "${act.k}") and its payload now hashes to ${got}`,
          detail: { position: k, logIndex: i, sealed: want, derived: got },
        });
      }
    }

    // Edition drift: the block names the two files that computed it.
    const here = editionsOf(candidate.rulesVersion);
    for (const leg of ['replay', 'rules']) {
      const theirs = sealed.editions && sealed.editions[leg];
      if (theirs && here[leg] !== 'unavailable' && theirs !== here[leg]) {
        const entry = {
          code: 'EDITION_DRIFT',
          height,
          message:
            `block ${height} was computed by ${leg} edition ${String(theirs).slice(0, 16)}… and this checkout holds ` +
            `${here[leg].slice(0, 16)}…`,
          detail: { leg, sealed: theirs, here: here[leg] },
        };
        if (options.strictEditions) problems.push(entry);
        else warnings.push(entry);
      }
    }

    // The network id is taken FROM the block when the epoch is resealed, because
    // a verifier holds a record and not an opinion about which network it belongs
    // to. What it does hold is that a record is one record: a chain whose net
    // changes midway is two chains in one file.
    if (expectedNet !== null && sealed.net !== expectedNet) {
      problems.push({
        code: 'NET_CHANGED',
        height,
        message: `block ${height} belongs to network "${sealed.net}" and the record opens on "${expectedNet}"`,
        detail: { was: expectedNet, now: sealed.net },
      });
    }

    if (expectedProducer && sealed.producer !== expectedProducer && !allowProducerChange) {
      problems.push({
        code: 'PRODUCER_CHANGED',
        height,
        message:
          `block ${height} was published by ${String(sealed.producer).slice(0, 16)}… and the record is published by ` +
          `${expectedProducer.slice(0, 16)}…. A key change is a human act, not a verification outcome.`,
        detail: { was: expectedProducer, now: sealed.producer },
      });
    }
  };

  const walked = walkLog(acts, (candidate) => {
    closes += 1;
    const height = candidate.height;
    const sealed = chain[height];
    if (!sealed) return; // the log is ahead of the chain; reported as a warning below
    if (!soundness[height]) return; // already reported; comparing a broken block adds noise

    checked += 1;
    sealedTombstones += Array.isArray(sealed.tombstones) ? sealed.tombstones.length : 0;
    try {
      compare(candidate, sealed, height);
    } catch (err) {
      problems.push({
        code: 'BLOCK_MALFORMED',
        height,
        message: `block ${height} cannot be compared with the log: ${err.message}`,
        detail: null,
      });
    }
  });

  // A chain ahead of the log is a failure: a block exists for a close the log
  // cannot produce, which is a truncated log or a rewritten one.
  if (chain.length > closes) {
    problems.push({
      code: 'CHAIN_AHEAD_OF_LOG',
      height: closes,
      message:
        `the chain holds ${chain.length} blocks and the log closes ${closes} epochs. ` +
        'Sealed blocks are never dropped, so the log is short, truncated, or from another record.',
      detail: { chain: chain.length, closes },
    });
  }

  // A log ahead of the chain is the ordinary state of a record fetched between a
  // close and the next build, and of every record with an epoch in progress.
  // Failing on it would fail on most honest records.
  if (closes > chain.length) {
    warnings.push({
      code: 'LOG_AHEAD_OF_CHAIN',
      height: chain.length,
      message: `the log closes ${closes} epochs and the chain seals ${chain.length}. Run build to seal the rest.`,
      detail: { chain: chain.length, closes },
    });
  }
  if (walked.open.count > 0) {
    warnings.push({
      code: 'OPEN_EPOCH',
      height: null,
      message: `epoch ${walked.open.epoch} is open with ${walked.open.count} act${walked.open.count === 1 ? '' : 's'} in it, sealed by nothing yet`,
      detail: { ...walked.open },
    });
  }

  return report(dir, problems, warnings, acts.length, chain.length, {
    checked,
    closes,
    tombstones: sealedTombstones,
    producer: expectedProducer,
    head: chain.length > 0 && soundness[chain.length - 1] ? blockHash(chain[chain.length - 1]) : null,
  });
}

function report(dir, problems, warnings, actCount, blockCount, extra) {
  return {
    ok: problems.length === 0,
    dir,
    acts: actCount,
    blocks: blockCount,
    problems,
    warnings,
    ...(extra || {}),
  };
}

/** The report as lines a person reads. The failure lines lead with the code, so
 * the same text is greppable and quotable. */
export function formatReport(r) {
  const lines = [];
  lines.push(`record ${r.dir}`);
  lines.push(`log    ${r.acts} act${r.acts === 1 ? '' : 's'}`);
  lines.push(
    `chain  ${r.blocks} block${r.blocks === 1 ? '' : 's'}` +
      (r.checked === undefined ? '' : `, ${r.checked} reproduced from the log`) +
      (r.tombstones ? `, ${r.tombstones} tombstone${r.tombstones === 1 ? '' : 's'}` : ''),
  );
  if (r.head) lines.push(`head   ${r.head}`);
  if (r.producer) lines.push(`by     ${r.producer}`);
  for (const w of r.warnings) lines.push(`warn   ${w.code}: ${w.message}`);
  for (const p of r.problems) lines.push(`FAIL   ${p.code}: ${p.message}`);
  lines.push(r.ok ? 'ok' : `refused: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`);
  return lines.join('\n') + '\n';
}

// ── the command line ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice(6);
    else if (arg === '--strict-editions') opts.strictEditions = true;
    else if (arg === '--allow-producer-change') opts.allowProducerChange = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!arg.startsWith('-') && opts.dir === null) opts.dir = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

const USAGE = `node server/chain/verify.mjs [--dir <record>] [--strict-editions] [--allow-producer-change]

  --dir                      the record to check: acts.jsonl and chain.json.
                             Default $PTP_DATA_DIR or ./data
  --strict-editions          treat a formula edition that differs from this
                             checkout as a failure rather than a warning
  --allow-producer-change    accept a chain whose producer key changes midway

Exit 0 when every block reproduces from the log, every root matches its own
contents and every signature checks. An empty record is a valid record of
nothing and exits 0.
`;

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(err.message + '\n\n' + USAGE);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const r = verifyChain(opts);
    const text = formatReport(r);
    if (r.ok) {
      if (!opts.quiet) process.stdout.write(text);
      return 0;
    }
    process.stderr.write(text);
    return 1;
  } catch (err) {
    process.stderr.write('FAIL   VERIFY_THREW: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
