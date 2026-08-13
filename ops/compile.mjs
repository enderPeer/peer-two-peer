#!/usr/bin/env node
// Compile contracts/*.sol into build/*.json.
//
//   node ops/compile.mjs            # compile everything in contracts/
//   node ops/compile.mjs PtpToken   # compile one file, by name or path
//
// Output is one JSON per contract: the ABI, the creation bytecode, the
// deployed bytecode, the method identifiers, the solc metadata, and a sha256
// of both the source and the bytecode. ops/deploy.mjs reads nothing else, so
// what gets deployed is exactly what was compiled here, from sources sitting
// in this repository, with the settings printed in the same file.
//
// ── Why the fingerprints are in the output ──────────────────────────────────
// A deployment is irreversible. The failure that actually happens is not an
// attacker, it is a stale artifact: a build/ left over from an earlier edit, a
// second checkout, a worktree — and deploying it is silent, permanent, and
// leaves the host calling functions the contract does not have. Recording the
// source hash beside the bytecode hash makes "is this the contract I just
// read?" a comparison rather than a hope, and deploy.mjs re-checks the source
// hash against the file on disk before it signs anything.
//
// ── Why solc is not vendored, and what happens when it is missing ───────────
// solc is a devDependency and nothing else in this repository imports it. A
// machine that only runs the network never needs it; a machine that deploys
// does. When it is absent this exits with the one command that fixes it,
// rather than a stack trace about a module specifier — an operator hitting
// this at deploy time needs an instruction, not a diagnosis.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const CONTRACTS = process.env.PTP_CONTRACTS_DIR || join(REPO, 'contracts');
const BUILD = process.env.PTP_BUILD_DIR || join(REPO, 'build');

/**
 * The compiler settings, in one place, because they are part of the artifact's
 * identity. Optimizer on at 200 runs matches what the predecessor's contracts
 * were deployed and verified with, and an explicit evmVersion keeps a solc
 * point release from silently retargeting a chain's opcode set — a contract
 * that compiles to different bytecode on a different day is a contract nobody
 * can verify on an explorer afterwards.
 */
export const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  outputSelection: {
    '*': {
      '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers', 'metadata'],
    },
  },
};

/** Load solc, or exit with the command that installs it. Never a stack trace. */
export async function loadSolc() {
  try {
    const mod = await import('solc');
    return mod.default ?? mod;
  } catch {
    console.error('solc is not installed.');
    console.error('');
    console.error('It is the only devDependency this repository has, and only deployment needs it:');
    console.error('');
    console.error('    npm install');
    console.error('');
    console.error('If you are offline or do not want it in this checkout, compile elsewhere and');
    console.error('drop the resulting build/*.json here — ops/deploy.mjs reads those files and');
    console.error('nothing else. Settings that must match, so the bytecode matches:');
    console.error(`    solidity 0.8.24, optimizer on, ${SETTINGS.optimizer.runs} runs, evmVersion ${SETTINGS.evmVersion}`);
    process.exit(1);
  }
}

/** Every .sol in contracts/, sorted, so a build is not at the mercy of readdir order. */
export function sourceFiles(only = null) {
  if (!existsSync(CONTRACTS)) {
    console.error(`no contracts directory at ${CONTRACTS}`);
    process.exit(1);
  }
  let names = readdirSync(CONTRACTS).filter((n) => n.endsWith('.sol')).sort();
  if (only) {
    const want = basename(only).replace(/\.sol$/, '');
    names = names.filter((n) => n.replace(/\.sol$/, '') === want);
    if (names.length === 0) {
      console.error(`no contract named ${want} in ${CONTRACTS}`);
      process.exit(1);
    }
  }
  return names;
}

/**
 * Compile a set of sources as one standard-JSON unit.
 *
 * They go in together rather than one at a time because Solidity resolves
 * imports across the unit, and compiling each file alone would refuse any
 * cross-contract import the moment one appears. The import callback is
 * restricted to contracts/ — a compiler that will read any path the source
 * names is a compiler that can be pointed at a file the reader never saw.
 */
export function compileSources(solc, names) {
  const sources = {};
  for (const n of names) sources[n] = { content: readFileSync(join(CONTRACTS, n), 'utf8') };

  const input = { language: 'Solidity', sources, settings: SETTINGS };
  const findImport = (path) => {
    const p = join(CONTRACTS, path);
    if (!p.startsWith(CONTRACTS) || !existsSync(p)) {
      return { error: `refusing to read "${path}": imports must resolve inside ${CONTRACTS}` };
    }
    return { contents: readFileSync(p, 'utf8') };
  };
  return JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
}

async function main() {
  const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const solc = await loadSolc();
  const version = solc.version();
  const names = sourceFiles(only);

  console.log(`solc      ${version}`);
  console.log(`settings  optimizer on, ${SETTINGS.optimizer.runs} runs, evmVersion ${SETTINGS.evmVersion}`);
  console.log(`sources   ${names.join(', ')}`);
  console.log('');

  const out = compileSources(solc, names);

  let errors = 0;
  for (const e of out.errors || []) {
    const line = (e.formattedMessage || e.message || '').trimEnd();
    if (e.severity === 'error') { errors++; console.error(line); } else { console.log(line); }
  }
  if (errors) {
    console.error('');
    console.error(`${errors} error(s). Nothing was written to ${BUILD}.`);
    process.exit(1);
  }

  mkdirSync(BUILD, { recursive: true });
  const written = [];
  const seen = new Map();
  for (const file of names) {
    const contracts = out.contracts?.[file] || {};
    const source = readFileSync(join(CONTRACTS, file), 'utf8');
    const sourceSha = createHash('sha256').update(source).digest('hex');
    for (const [name, c] of Object.entries(contracts)) {
      if (seen.has(name)) {
        console.error(`two files define a contract called ${name}: ${seen.get(name)} and ${file}.`);
        console.error('Deployment addresses contracts by name, so this is ambiguous rather than merely untidy.');
        process.exit(1);
      }
      seen.set(name, file);
      const bytecode = '0x' + (c.evm?.bytecode?.object || '');
      // An abstract contract, an interface or a library with no creation code
      // compiles fine and cannot be deployed. Recording it anyway, with the
      // empty bytecode visible, is more useful than dropping it silently:
      // deploy.mjs refuses on the empty string and says which artifact it was.
      const artifact = {
        contract: name,
        source: file,
        sourceSha256: sourceSha,
        compiler: version,
        settings: SETTINGS,
        abi: c.abi || [],
        bytecode,
        bytecodeSha256: createHash('sha256').update(bytecode).digest('hex'),
        deployedBytecode: '0x' + (c.evm?.deployedBytecode?.object || ''),
        methodIdentifiers: c.evm?.methodIdentifiers || {},
        metadata: c.metadata || '',
      };
      const path = join(BUILD, `${name}.json`);
      writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n');
      written.push({ name, path, size: (bytecode.length - 2) / 2, sha: artifact.bytecodeSha256 });
    }
  }

  for (const w of written) {
    const size = w.size === 0 ? 'no creation code (interface or abstract)' : `${w.size} bytes`;
    console.log(`built     ${w.name.padEnd(12)} ${size}`);
    console.log(`          sha256 ${w.sha}`);
    // EIP-170 caps deployed code at 24 576 bytes. Creation code is the wrong
    // number to measure against it, but a creation payload already past the
    // cap cannot possibly fit, and finding that out from a reverted deploy
    // costs gas and an explanation.
    if (w.size > 24576) console.log('          WARNING: past the EIP-170 24 576-byte code limit — this will not deploy');
  }
  console.log('');
  console.log(`wrote ${written.length} artifact(s) to ${BUILD}`);
  console.log('next: node ops/deploy.mjs --dry-run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
