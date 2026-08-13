// Seal every closed epoch into the chain. Incremental, and it refuses forks.
//
//   node server/chain/build.mjs                 seal whatever is newly closed
//   node server/chain/build.mjs --dir <record>  against a record somewhere else
//   node server/chain/build.mjs --rebuild       reseal from genesis
//
// The ordinary run is incremental: it replays the log, finds the epochs that have
// closed since the last run, and appends one signed block for each. Blocks that
// are already sealed are not resealed and not re-signed — they are compared
// against what the log produces now, and a disagreement is a FORK.
//
// ── WHY A FORK IS A REFUSAL AND NOT A REPAIR ───────────────────────────────
//
// A sealed block is a published claim about an ordered act range. If the log no
// longer produces that block, one of two things happened: the log was edited
// under a chain that had already committed to it, or the chain was built from a
// different log. Neither is fixable by a program. Overwriting the block would
// destroy the only evidence that anything changed, which is the exact event this
// whole layer exists to make detectable — so the builder stops, names the height,
// names the first field that differs, and leaves both records intact for a person
// to compare.
//
// `--rebuild` reseals from genesis and is BYTE-IDENTICAL when nothing has
// changed: canonical JSON is a pure function of the values, Ed25519 is
// deterministic, and nothing in a block is read from a clock — `time` is the
// closing act's own stamp. It still refuses a fork, for the same reason, and it
// still refuses to re-sign a block published by a different producer: putting
// your name on somebody else's publication is not a rebuild, it is a forgery
// that happens to be internally consistent.
//
// ── WHAT THIS PROGRAM NEEDS ────────────────────────────────────────────────
//
// The act log, the chain, and the producer key beside them. No network, no
// clock, no third party. It writes one file, `<record>/chain.json`, atomically —
// a temporary file and a rename, so a machine that dies mid-write leaves the
// previous chain intact rather than half of the next one.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { canonicalBytes } from '../../core/canonical.mjs';
import {
  DEFAULT_NET,
  GENESIS_PREV,
  blockDifference,
  blockHash,
  parseActLog,
  parseChain,
  sealEpoch,
  serialiseChain,
  signBlock,
  walkLog,
} from './block.mjs';
import { KEY_SUBDIR, loadOrCreateProducer } from './keys.mjs';

export const ACTS_FILE = 'acts.jsonl';
export const CHAIN_FILE = 'chain.json';

/** Where a record lives when nobody says otherwise. The server writes its log to
 * the same place, so the two halves of a host's state sit together. */
export function defaultDir() {
  return process.env.PTP_DATA_DIR || 'data';
}

/**
 * The chain also exists as one file per block under `<record>/chain/`.
 *
 * `chain.json` is the AUTHORITY: it is what `verify.mjs` reads, what
 * `.github/workflows/archive.yml` writes into the record it verifies, and what
 * this part's brief pins. The per-block files are a byte-identical projection of
 * it, written because two other parts read the chain that way — `server/index.mjs`
 * serves `/api/chain` and `/api/chain/head` out of that directory, and
 * `ops/ipfs-pack.mjs` copies it file by file into the archive.
 *
 * Duplication of a record is a real cost and it is bounded here in the only way
 * that makes it safe: the projection is derived from the same in-memory blocks in
 * the same canonical bytes, it is rewritten whenever it disagrees, and NOTHING
 * VERIFIES AGAINST IT. A stale or edited projection can make a host serve the
 * wrong thing; it can never make a bad record verify, because verification reads
 * the authority and replays the log.
 *
 * The names are zero-padded so that sorting them as strings and sorting them as
 * numbers give the same order — `server/index.mjs` sorts by name and would
 * otherwise read block 10 between blocks 1 and 2. The head is `head.json` in
 * lower case, which is the name that host excludes from the block list; the
 * upper-case `HEAD.json` that `ops/ipfs-pack.mjs` looks for would be served back
 * as a fourteenth block in a chain of thirteen.
 */
const BLOCK_DIR = KEY_SUBDIR;
const HEAD_FILE = 'head.json';
const blockFileName = (height) => String(height).padStart(8, '0') + '.json';

function writeIfDifferent(file, text) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
  writeFileSync(file, text, 'utf8');
  return true;
}

function writeProjection(dir, blocks) {
  if (blocks.length === 0) return 0;
  const home = path.join(dir, BLOCK_DIR);
  mkdirSync(home, { recursive: true });
  let written = 0;
  for (const block of blocks) {
    const text = canonicalBytes(block).toString('utf8') + '\n';
    if (writeIfDifferent(path.join(home, blockFileName(block.height)), text)) written += 1;
  }
  const head = canonicalBytes(blocks[blocks.length - 1]).toString('utf8') + '\n';
  if (writeIfDifferent(path.join(home, HEAD_FILE), head)) written += 1;
  return written;
}

/** A refusal with a stable first word, so a caller branches on the code rather
 * than on a sentence. */
class BuildRefusal extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`);
    this.code = code;
    this.detail = detail || null;
  }
}

function readRecord(dir) {
  const actsPath = path.join(dir, ACTS_FILE);
  const chainPath = path.join(dir, CHAIN_FILE);
  const acts = existsSync(actsPath) ? parseActLog(readFileSync(actsPath, 'utf8')) : [];
  let chain = [];
  if (existsSync(chainPath)) {
    try {
      chain = parseChain(readFileSync(chainPath, 'utf8'));
    } catch (err) {
      throw new BuildRefusal('CHAIN_UNREADABLE', `${chainPath}: ${err.message}`);
    }
  }
  return { acts, chain, actsPath, chainPath };
}

/**
 * Build or extend the chain for one record.
 *
 * Returns a report rather than printing one, so the same function serves the CLI
 * and the tests. Nothing is written when the run refuses.
 */
export function buildChain(options = {}) {
  const dir = path.resolve(options.dir || defaultDir());
  const net = options.net || DEFAULT_NET;
  const rebuild = Boolean(options.rebuild);
  const force = Boolean(options.force);

  const { acts, chain, chainPath } = readRecord(dir);

  // The key is loaded only when something will actually be signed. A machine that
  // is merely re-checking an up-to-date chain does not need one, and should not
  // create one as a side effect of a read.
  let signer = options.signer || null;
  const needsKey = () => {
    if (!signer) signer = loadOrCreateProducer(dir);
    return signer;
  };

  const out = [];
  let kept = 0;
  let added = 0;
  let resealed = 0;

  walkLog(acts, (candidate) => {
    const prev = out.length === 0 ? GENESIS_PREV : blockHash(out[out.length - 1]);
    const derived = sealEpoch(candidate, { prev, net });
    const stored = chain[candidate.height];

    if (stored && !rebuild) {
      const diff = blockDifference(stored, derived);
      if (diff) {
        throw new BuildRefusal(
          'CHAIN_FORK',
          `block ${candidate.height} (epoch ${candidate.epoch}) is already sealed and the log now produces a different one: ` +
            `field "${diff.field}"${diff.index === null ? '' : ` at index ${diff.index}`} differs`,
          { height: candidate.height, epoch: candidate.epoch, ...diff },
        );
      }
      out.push(stored);
      kept += 1;
      return;
    }

    if (stored && rebuild) {
      const diff = blockDifference(stored, derived);
      if (diff && !force) {
        throw new BuildRefusal(
          'CHAIN_FORK',
          `--rebuild would rewrite sealed block ${candidate.height} (epoch ${candidate.epoch}): ` +
            `field "${diff.field}"${diff.index === null ? '' : ` at index ${diff.index}`} differs. ` +
            'Rewriting a published block is the event the chain exists to make visible; ' +
            'move the chain aside and rebuild into an empty one if that is what you mean.',
          { height: candidate.height, epoch: candidate.epoch, ...diff },
        );
      }
      const key = needsKey();
      if (stored.producer && stored.producer !== key.publicHex && !force) {
        throw new BuildRefusal(
          'CHAIN_PRODUCER_CHANGE',
          `block ${candidate.height} was published by ${stored.producer.slice(0, 16)}… and this host holds ` +
            `${key.publicHex.slice(0, 16)}…. Re-signing it would publish somebody else's block under this name.`,
          { height: candidate.height, was: stored.producer, now: key.publicHex },
        );
      }
      out.push(signBlock(derived, key));
      resealed += 1;
      return;
    }

    out.push(signBlock(derived, needsKey()));
    added += 1;
  });

  // A chain longer than the log can produce is the same fork seen from the other
  // side: blocks exist for closes the log no longer contains.
  if (chain.length > out.length && !force) {
    throw new BuildRefusal(
      'CHAIN_AHEAD_OF_LOG',
      `the chain holds ${chain.length} blocks and the log closes ${out.length} epochs. ` +
        'Sealed blocks are never dropped; the log is short, truncated, or from another network.',
      { chain: chain.length, log: out.length },
    );
  }

  const text = serialiseChain(out);
  const previous = existsSync(chainPath) ? readFileSync(chainPath, 'utf8') : null;
  const changed = previous !== text;
  if (changed) {
    mkdirSync(dir, { recursive: true });
    // A temporary file and a rename, so a machine that dies mid-write leaves the
    // previous chain intact rather than half of the next one.
    const tmp = chainPath + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, chainPath);
  }
  const projected = writeProjection(dir, out);

  return {
    ok: true,
    dir,
    chainPath,
    blocks: out.length,
    kept,
    added,
    resealed,
    changed,
    projected,
    bytes: Buffer.byteLength(text, 'utf8'),
    head: out.length > 0 ? blockHash(out[out.length - 1]) : null,
    producer: signer ? signer.publicHex : null,
    log: { acts: acts.length },
  };
}

// ── the command line ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dir: null, rebuild: false, force: false, net: undefined, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--rebuild') opts.rebuild = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--dir') opts.dir = argv[++i];
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice(6);
    else if (arg === '--net') opts.net = argv[++i];
    else if (arg.startsWith('--net=')) opts.net = arg.slice(6);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new BuildRefusal('BAD_ARGUMENT', `unknown argument ${arg}`);
  }
  return opts;
}

const USAGE = `node server/chain/build.mjs [--dir <record>] [--rebuild] [--force] [--net <id>] [--quiet]

  --dir      the record to seal: acts.jsonl in, chain.json out. Default $PTP_DATA_DIR or ./data
  --rebuild  reseal every block from genesis. Byte-identical when nothing changed
  --force    proceed past a fork or a producer change. Both are events for a person
  --net      the network id sealed into each block. Default "${DEFAULT_NET}"
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
    const report = buildChain(opts);
    if (!opts.quiet) {
      process.stdout.write(
        `chain ${report.blocks} block${report.blocks === 1 ? '' : 's'} ` +
          `(${report.added} sealed, ${report.resealed} resealed, ${report.kept} kept)\n` +
          `head  ${report.head || '(none)'}\n` +
          `file  ${report.chainPath}${report.changed ? '' : ' (unchanged)'}\n` +
          `serve ${report.projected} file${report.projected === 1 ? '' : 's'} written under ${BLOCK_DIR}/\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
