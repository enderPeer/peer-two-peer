#!/usr/bin/env node
// Deploy the network's contracts, in the order their constructors imply.
//
//   node ops/deploy.mjs --dry-run           # resolve everything, sign nothing
//   node ops/deploy.mjs                     # deploy to a testnet or a local node
//   node ops/deploy.mjs --mainnet           # deploy where the money is real
//   node ops/deploy.mjs --no-wire           # skip the post-deployment setters
//
// Reads build/*.json written by ops/compile.mjs. Takes the deployer key from
// the environment, never from a file in the repository and never from an
// argument — arguments end up in shell history and in `ps`.
//
//     PTP_RPC_URL      the JSON-RPC endpoint
//     PTP_DEPLOY_KEY   the deployer's private key (0x-prefixed hex)
//
// ── The order is derived, not hardcoded, and here is why ────────────────────
// The four contracts refer to each other, and one of those references is
// circular by design: PtpToken takes its `distributor` in the constructor, and
// the distributor's intended shape is a contract that creates the token from
// inside its own constructor, so mint rights belong to code rather than to a
// person from the token's first second. A fixed list would deploy a token that
// the distributor then cannot mint from.
//
// So this reads the ABIs, works out which constructor needs which address,
// deploys whatever is resolvable, and after every deployment asks the new
// contract what it points at — which is how a token created inside another
// constructor is discovered rather than deployed twice. If nothing can
// progress it stops and names the exact argument it could not resolve and the
// environment variable that supplies it. It never guesses an address.
//
// ── What it refuses ─────────────────────────────────────────────────────────
// A mainnet without `--mainnet`. An artifact whose source hash no longer
// matches the .sol file beside it — that is the stale-build failure, and it is
// silent, permanent and expensive. An artifact with no creation bytecode. A
// constructor argument it cannot source. A default numeric constant, on a real
// run, without `--accept-defaults`.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const BUILD = process.env.PTP_BUILD_DIR || join(REPO, 'build');
const CONTRACTS = process.env.PTP_CONTRACTS_DIR || join(REPO, 'contracts');

/**
 * The contracts this network is made of, in the order to ATTEMPT them. The
 * real order comes out of the dependency pass below; this list only decides
 * which of two equally-ready contracts goes first, so a deployment log reads
 * the same way twice.
 */
export const CONTRACT_ORDER = ['PtpPool', 'PtpToken', 'PtpAnchor', 'PtpRules'];

// Which role each contract fills, so a constructor asking for "pool" can be
// answered without the resolver knowing anything about Solidity.
const ROLE_OF = { PtpPool: 'pool', PtpToken: 'token', PtpAnchor: 'anchor', PtpRules: 'rules' };
const NAME_OF = Object.fromEntries(Object.entries(ROLE_OF).map(([n, r]) => [r, n]));

/**
 * Chains where a mistake costs real money. Deployment refuses these without
 * `--mainnet`, and refuses chains it does not recognise at all for the same
 * reason: an unknown chain id is more likely to be a mainnet this list has not
 * heard of than a testnet, and the failure modes are not symmetric.
 */
export const MAINNETS = new Map([
  [1n, 'Ethereum'], [10n, 'OP Mainnet'], [30n, 'Rootstock'], [56n, 'BNB Chain'],
  [100n, 'Gnosis'], [137n, 'Polygon'], [250n, 'Fantom'], [324n, 'zkSync Era'],
  [1101n, 'Polygon zkEVM'], [5000n, 'Mantle'], [8453n, 'Base'], [42161n, 'Arbitrum One'],
  [43114n, 'Avalanche'], [59144n, 'Linea'], [81457n, 'Blast'], [534352n, 'Scroll'],
]);

/** Chains where a mistake costs nothing. Everything else needs the flag. */
export const TESTNETS = new Map([
  [11155111n, 'Sepolia'], [17000n, 'Holesky'], [560048n, 'Hoodi'],
  [84532n, 'Base Sepolia'], [11155420n, 'OP Sepolia'], [421614n, 'Arbitrum Sepolia'],
  [534351n, 'Scroll Sepolia'], [31n, 'Rootstock Testnet'], [80002n, 'Polygon Amoy'],
  [97n, 'BNB Testnet'], [31337n, 'local (hardhat/anvil)'], [1337n, 'local (ganache)'],
]);

/**
 * Numeric constructor constants this repository already fixes elsewhere.
 *
 * These are not invented here — each one is a number ARCHITECTURE.md states,
 * repeated so a deployment does not have to be typed from memory. They are
 * still printed as defaults on every run and still require --accept-defaults,
 * because a constant that is right in the document and wrong in the contract
 * is exactly the disagreement a deployment should stop on.
 */
export const DEFAULTS = new Map([
  ['genesissat', { value: 1000000n, why: 'ARCHITECTURE §2: genesis liquidity 0.01 BTC = 1 000 000 sat' }],
  ['genesisptp', { value: 10000n * 10n ** 18n, why: 'ARCHITECTURE §2: genesis liquidity 10 000 PTP' }],
  ['feebps', { value: 30n, why: 'ARCHITECTURE §2: the pool fee, 0.30 %' }],
  ['minimumliquidity', { value: 1000n, why: 'ARCHITECTURE §2: shares locked forever' }],
  ['maxsupply', { value: 18250000n * 10n ** 18n, why: 'PtpToken.sol: 1 825 000 / (1 − 0.9) = 18 250 000 PTP' }],
]);

// Setter names that may be called after deployment, and the role each wires.
// An allowlist rather than "anything that looks like a setter": this script
// signs transactions, and a contract's ABI is not a list of things it is safe
// to call.
const WIRE_SETTERS = new Map([
  ['setToken', 'token'], ['setPtp', 'token'], ['setPool', 'pool'],
  ['setAnchor', 'anchor'], ['setRules', 'rules'],
]);

// Zero-argument address getters worth asking a fresh contract about. This is
// how a token created inside another contract's constructor is found.
const ROLE_GETTERS = new Map([
  ['token', 'token'], ['ptp', 'token'], ['pool', 'pool'],
  ['anchor', 'anchor'], ['rules', 'rules'],
]);

const ZERO = '0x0000000000000000000000000000000000000000';
const flag = (n) => process.argv.includes(n);
function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; }

/** Load ethers, or exit with the command that installs it. */
export async function loadEthers() {
  try {
    return await import('ethers');
  } catch {
    console.error('ethers is not installed.');
    console.error('');
    console.error('It is this repository\'s only runtime dependency:');
    console.error('');
    console.error('    npm install');
    process.exit(1);
  }
}

/**
 * Read one compiled artifact and check it still describes the source beside
 * it. The stale-build failure is the one that actually happens: a build/ from
 * an earlier edit deploys silently, permanently, and leaves the host calling
 * functions the deployed contract does not have.
 */
export function loadArtifact(name) {
  const path = join(BUILD, `${name}.json`);
  if (!existsSync(path)) return null;
  const a = JSON.parse(readFileSync(path, 'utf8'));
  const src = join(CONTRACTS, a.source || `${name}.sol`);
  if (existsSync(src)) {
    const sha = createHash('sha256').update(readFileSync(src, 'utf8')).digest('hex');
    if (a.sourceSha256 && sha !== a.sourceSha256) {
      console.error(`${name}.json was built from a different ${a.source} than the one on disk.`);
      console.error(`  artifact source sha256 ${a.sourceSha256}`);
      console.error(`  file     source sha256 ${sha}`);
      console.error('Deploying a stale artifact is silent and irreversible. Run: node ops/compile.mjs');
      process.exit(1);
    }
  }
  a.name = name;
  return a;
}

// Constructor inputs, or [] for a contract without one.
function ctorInputs(abi) {
  const c = (abi || []).find((f) => f.type === 'constructor');
  return c ? c.inputs || [] : [];
}

// PTP_CTOR_PTPPOOL_BTC — the environment name for one constructor argument.
function envNameFor(contract, param) {
  const clean = String(param).replace(/_+$/, '').replace(/[^A-Za-z0-9]/g, '_');
  return `PTP_CTOR_${contract.toUpperCase()}_${clean.toUpperCase()}`;
}

/**
 * Work out what one constructor argument should be, from (in order): an
 * explicit environment variable, an already-known contract address, a
 * well-known external address, or a constant this repository already fixes.
 *
 * Returns `{ value, from }` or `{ missing, env, why }`. It never invents an
 * address — an address that is wrong by a nibble is a deployment that looks
 * finished and works for nobody, and there is no repair afterwards.
 */
export function resolveArg(contract, input, known, deployer) {
  const env = envNameFor(contract, input.name);
  const raw = process.env[env];
  const key = String(input.name || '').replace(/_+$/, '').toLowerCase();

  if (raw != null && raw !== '') {
    if (input.type === 'address') return { value: raw.trim(), from: `env ${env}` };
    if (/^u?int/.test(input.type)) return { value: BigInt(raw.replace(/[_\s]/g, '')), from: `env ${env}` };
    if (input.type === 'bool') return { value: raw === 'true' || raw === '1', from: `env ${env}` };
    return { value: raw, from: `env ${env}` };
  }

  if (input.type === 'address') {
    for (const [needle, role] of [['anchor', 'anchor'], ['rules', 'rules'], ['pool', 'pool'], ['token', 'token'], ['ptp', 'token']]) {
      if (key.includes(needle) && known[role]) return { value: known[role], from: `${role} deployed above` };
    }
    if (/^(btc|cbbtc|wbtc|btctoken)$/.test(key) && process.env.PTP_BTC_ADDR) {
      return { value: process.env.PTP_BTC_ADDR.trim(), from: 'env PTP_BTC_ADDR' };
    }
    // Roles that are a person, not a contract. Defaulting them to the deployer
    // is the common case and is announced loudly rather than assumed quietly.
    if (/^(rulekey|producer|steward|owner|admin|treasury)$/.test(key)) {
      return { value: deployer, from: 'the deployer (default for a key-held role)', loud: true };
    }
    return {
      missing: true,
      env,
      why: key.includes('distributor')
        ? 'the distributor is the only address that may ever mint PTP. PtpToken.sol says the intended ' +
          'shape is a CONTRACT that creates the token inside its own constructor, so mint rights belong ' +
          'to code and never to a person. An externally owned account here is a different, weaker ' +
          'deployment; if that is what you mean, say so explicitly.'
        : 'no deployed contract fills this role and no default exists for it.',
    };
  }

  if (/^u?int/.test(input.type) && DEFAULTS.has(key)) {
    const d = DEFAULTS.get(key);
    return { value: d.value, from: `default — ${d.why}`, isDefault: true };
  }

  // The genesis rule's version string and source hash are not guessable and
  // must not be: they identify the exact distribution module that will cut the
  // first epoch, and ARCHITECTURE §8 requires every past epoch to stay
  // recomputable with the module that actually computed it. A wrong hash here
  // is a chain that names a rulebook nobody can produce.
  if (/^(version|sourcehash|rulesversion|ruleshash)\d*$/.test(key)) {
    return {
      missing: true,
      env,
      why: 'this identifies the genesis distribution module. Take it from core/rules/v1.mjs — the ' +
        'exported VERSION for the string, and the sha256 of that file for the hash. Do not invent ' +
        'either: the epoch chain seals both, and a value that names no real module cannot be checked.',
    };
  }

  return { missing: true, env, why: `no value known for a ${input.type} named ${input.name}.` };
}

/**
 * Order the deployments by repeatedly taking whatever is fully resolvable.
 *
 * A plain topological sort would deadlock on the token/distributor cycle. This
 * does not sort: it makes as much progress as it can, lets the caller deploy
 * and then ask the new contract what addresses it created, and comes back for
 * another pass. Deadlock is reported with the unresolved arguments named,
 * which is the only useful thing to say about it.
 */
export function planPass(pending, known, deployer) {
  const ready = [];
  const blocked = [];
  for (const a of pending) {
    const inputs = ctorInputs(a.abi);
    const args = inputs.map((i) => ({ input: i, ...resolveArg(a.name, i, known, deployer) }));
    if (args.some((x) => x.missing)) blocked.push({ artifact: a, args });
    else ready.push({ artifact: a, args });
  }
  return { ready, blocked };
}

function fmt(v) {
  return typeof v === 'bigint' ? v.toString() : String(v);
}

async function main() {
  const dryRun = flag('--dry-run');
  const eth = await loadEthers();

  // ── the artifacts ────────────────────────────────────────────────────────
  const artifacts = [];
  for (const name of CONTRACT_ORDER) {
    const a = loadArtifact(name);
    if (!a) { console.log(`skip      ${name} — no ${name}.json in ${BUILD}`); continue; }
    if (!a.bytecode || a.bytecode === '0x') {
      console.error(`${name} has no creation bytecode — it is an interface, a library or abstract.`);
      process.exit(1);
    }
    artifacts.push(a);
  }
  if (artifacts.length === 0) {
    console.error(`nothing to deploy: no artifacts in ${BUILD}. Run: node ops/compile.mjs`);
    process.exit(1);
  }

  // ── the chain, and the refusal that guards it ────────────────────────────
  const rpc = process.env.PTP_RPC_URL || arg('--rpc');
  if (!rpc) { console.error('set PTP_RPC_URL to the JSON-RPC endpoint to deploy against.'); process.exit(1); }
  const provider = new eth.JsonRpcProvider(rpc);
  let net;
  try { net = await provider.getNetwork(); }
  catch (e) { console.error(`cannot reach ${rpc}: ${e.message}`); process.exit(1); }
  const chainId = net.chainId;
  const chainName = MAINNETS.get(chainId) || TESTNETS.get(chainId) || 'unrecognised chain';
  const isReal = MAINNETS.has(chainId) || !TESTNETS.has(chainId);

  console.log(`rpc       ${rpc}`);
  console.log(`chain     ${chainId} — ${chainName}`);

  if (isReal && !flag('--mainnet')) {
    console.error('');
    console.error(MAINNETS.has(chainId)
      ? `${chainName} is a mainnet. Deploying costs real money and cannot be undone.`
      : `chain ${chainId} is not in this script's list of testnets. An unrecognised chain id is more ` +
        'likely to be a mainnet nobody added here than a testnet, so it is treated as real.');
    console.error('');
    console.error('If that is what you mean, say so:  node ops/deploy.mjs --mainnet');
    console.error('Read the whole plan first:         node ops/deploy.mjs --dry-run');
    process.exit(1);
  }

  // ── the key ──────────────────────────────────────────────────────────────
  const pk = process.env.PTP_DEPLOY_KEY;
  if (!pk && !dryRun) {
    console.error('set PTP_DEPLOY_KEY to the deployer\'s private key.');
    console.error('Use a fresh account holding only gas. Nothing here ever prints it, and it must');
    console.error('never be passed as an argument — arguments survive in shell history and in `ps`.');
    process.exit(1);
  }
  const wallet = pk ? new eth.Wallet(pk, provider) : null;
  const deployer = wallet ? wallet.address : (process.env.PTP_DEPLOYER_ADDR || ZERO);
  console.log(`deployer  ${deployer}${wallet ? '' : '  (dry run, no key loaded)'}`);
  if (wallet) {
    const bal = await provider.getBalance(deployer);
    console.log(`balance   ${eth.formatEther(bal)}`);
    if (bal === 0n) { console.error('the deployer holds no gas. Fund it and try again.'); process.exit(1); }
  }
  console.log('');

  // ── the plan, executed one resolvable pass at a time ─────────────────────
  const known = {};
  const done = [];
  const wiring = [];
  let usedDefault = false;
  let pending = [...artifacts];

  while (pending.length > 0) {
    const { ready, blocked } = planPass(pending, known, deployer);
    if (ready.length === 0) {
      console.error('cannot make progress. Unresolved constructor arguments:');
      for (const b of blocked) {
        for (const a of b.args.filter((x) => x.missing)) {
          console.error(`  ${b.artifact.name}(${a.input.type} ${a.input.name})`);
          console.error(`    ${a.why}`);
          console.error(`    set ${a.env}`);
        }
      }
      process.exit(1);
    }

    // Deploy the first ready contract, then re-plan: a contract may create
    // others in its constructor, and the next pass should see them.
    const step = ready.sort(
      (x, y) => CONTRACT_ORDER.indexOf(x.artifact.name) - CONTRACT_ORDER.indexOf(y.artifact.name),
    )[0];
    pending = pending.filter((a) => a !== step.artifact);

    const shown = step.args.map((a) => `${a.input.type} ${a.input.name} = ${fmt(a.value)}`);
    console.log(`deploy    ${step.artifact.name}`);
    for (const a of step.args) {
      console.log(`          ${a.input.name} = ${fmt(a.value)}`);
      console.log(`            ${a.from}${a.loud ? '   <-- read this line twice' : ''}`);
      if (a.isDefault) usedDefault = true;
    }
    if (shown.length === 0) console.log('          (no constructor arguments)');

    if (usedDefault && !dryRun && !flag('--accept-defaults')) {
      console.error('');
      console.error('At least one constructor argument came from a default in this script rather than');
      console.error('from the environment. Defaults are this repository\'s own documented constants, but');
      console.error('a constant that is right in the document and wrong in the contract is exactly what');
      console.error('a deployment should stop on. Confirm with --accept-defaults, or set the variable.');
      process.exit(1);
    }

    if (dryRun) {
      // A dry run cannot learn a real address, so it uses a marker the eye
      // cannot mistake for one. Nothing downstream treats it as valid.
      known[ROLE_OF[step.artifact.name]] = `0x${'dd'.repeat(20)}`;
      done.push({ name: step.artifact.name, address: known[ROLE_OF[step.artifact.name]], args: step.args.map((a) => fmt(a.value)) });
      console.log('          (dry run — nothing signed)');
      console.log('');
      continue;
    }

    const factory = new eth.ContractFactory(step.artifact.abi, step.artifact.bytecode, wallet);
    const contract = await factory.deploy(...step.args.map((a) => a.value));
    const tx = contract.deploymentTransaction();
    const rcpt = await tx.wait();
    const address = await contract.getAddress();
    known[ROLE_OF[step.artifact.name]] = address;
    done.push({
      name: step.artifact.name,
      address,
      tx: tx.hash,
      block: rcpt.blockNumber,
      gasUsed: rcpt.gasUsed.toString(),
      bytecodeSha256: step.artifact.bytecodeSha256,
      args: step.args.map((a) => fmt(a.value)),
    });
    console.log(`          ${address}   block ${rcpt.blockNumber}   gas ${rcpt.gasUsed}`);

    // Ask the new contract what it points at. This is how a token created
    // inside a distributor's constructor is discovered instead of deployed a
    // second time — the second one would be a token nobody can mint.
    const live = new eth.Contract(step.artifact.abi, address, provider);
    for (const f of step.artifact.abi) {
      if (f.type !== 'function' || (f.inputs || []).length !== 0) continue;
      if ((f.outputs || []).length !== 1 || f.outputs[0].type !== 'address') continue;
      const role = ROLE_GETTERS.get(String(f.name).toLowerCase());
      if (!role || known[role]) continue;
      try {
        const found = await live[f.name]();
        if (found && found !== ZERO) {
          known[role] = found;
          console.log(`          ${f.name}() = ${found}   discovered, not deployed separately`);
          pending = pending.filter((a) => ROLE_OF[a.name] !== role);
          done.push({ name: NAME_OF[role] || role, address: found, createdBy: step.artifact.name });
        }
      } catch { /* a getter that reverts on a fresh contract tells us nothing */ }
    }
    console.log('');
  }

  // ── wiring: only setters on the allowlist, only where nothing is set yet ──
  if (!dryRun && !flag('--no-wire')) {
    for (const d of done) {
      const a = artifacts.find((x) => x.name === d.name);
      if (!a || d.createdBy) continue;
      const live = new eth.Contract(a.abi, d.address, wallet);
      for (const f of a.abi) {
        if (f.type !== 'function') continue;
        const role = WIRE_SETTERS.get(f.name);
        if (!role || !known[role] || (f.inputs || []).length !== 1 || f.inputs[0].type !== 'address') continue;
        const getter = f.name.slice(3, 4).toLowerCase() + f.name.slice(4);
        const has = a.abi.some((g) => g.type === 'function' && g.name === getter && (g.inputs || []).length === 0);
        if (!has) {
          // No getter means no way to tell "unset" from "already correct", and
          // a setter called twice can be a setter that overwrites something.
          wiring.push({ on: d.name, call: f.name, skipped: 'no matching getter to check the current value' });
          continue;
        }
        let current;
        try { current = await live[getter](); } catch { current = null; }
        if (current && current !== ZERO) {
          wiring.push({ on: d.name, call: f.name, skipped: `${getter}() is already ${current}` });
          continue;
        }
        try {
          const tx = await live[f.name](known[role]);
          const r = await tx.wait();
          wiring.push({ on: d.name, call: `${f.name}(${known[role]})`, tx: tx.hash, block: r.blockNumber });
        } catch (e) {
          wiring.push({ on: d.name, call: f.name, failed: e.shortMessage || e.message });
        }
      }
    }
  }

  // ── what happened ────────────────────────────────────────────────────────
  console.log('── wiring ──────────────────────────────────────────────────────────────');
  for (const d of done) {
    const a = artifacts.find((x) => x.name === d.name);
    const inputs = a ? ctorInputs(a.abi) : [];
    if (d.createdBy) { console.log(`  ${d.name} was created by ${d.createdBy}'s constructor`); continue; }
    if (inputs.length === 0) { console.log(`  ${d.name} points at nothing (no constructor arguments)`); continue; }
    console.log(`  ${d.name}(${inputs.map((i, n) => `${i.name}=${d.args[n]}`).join(', ')})`);
  }
  for (const w of wiring) {
    if (w.skipped) console.log(`  ${w.on}.${w.call} not called — ${w.skipped}`);
    else if (w.failed) console.log(`  ${w.on}.${w.call} FAILED — ${w.failed}`);
    else console.log(`  ${w.on}.${w.call}  tx ${w.tx} block ${w.block}`);
  }
  if (wiring.length === 0 && !dryRun) console.log('  no post-deployment setters existed to call — everything is constructor-wired');
  console.log('');

  const firstBlock = done.filter((d) => d.block).reduce((m, d) => (m === null ? d.block : Math.min(m, d.block)), null);

  console.log('── put these in the host\'s environment ─────────────────────────────────');
  console.log(`PTP_RPC_URL=${rpc}`);
  console.log(`PTP_CHAIN_ID=${chainId}`);
  for (const d of done) {
    const role = ROLE_OF[d.name] || d.name;
    console.log(`PTP_${String(role).toUpperCase()}_ADDR=${d.address}`);
  }
  if (firstBlock !== null) console.log(`PTP_DEPLOY_BLOCK=${firstBlock}`);
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — no transaction was signed and no address above is real.');
    return;
  }

  mkdirSync(BUILD, { recursive: true });
  const out = join(BUILD, `deployment.${chainId}.json`);
  writeFileSync(out, JSON.stringify({
    chainId: chainId.toString(), chain: chainName, rpc, deployer,
    contracts: done, wiring, firstBlock,
    note: 'Addresses and the exact bytecode hashes they were deployed from. Nothing here is a secret; ' +
          'the deployer key never touches this file.',
  }, null, 2) + '\n');
  console.log(`wrote ${out}`);
  console.log('');
  console.log('Deployment is irreversible. Read the addresses back from the chain before you rely on');
  console.log('them, and record the block number — a scan that starts too high hides everything below it.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
}
