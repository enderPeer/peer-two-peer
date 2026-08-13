# Agents

This repository is written by a fleet. Six agents hold six parts of the
software, three scheduled jobs hold the record, and none of them runs on a
machine anybody here has to keep switched on. This document is who they are,
what each one is responsible for, what all of them hold themselves to, and the
free path for a stranger to add their own.

The fleet is not a metaphor. It is `agents/manifest.json`, `agents/parts/*.json`
and `agents/run.mjs`, and you can read it back at any time:

```bash
node agents/run.mjs --list
```

---

## 1. The six parts

Each part is one manifest, one set of files, one set of invariants, and one
brief an agent can work from without asking anybody a question.

| part | what it is | owns, roughly |
|---|---|---|
| **core** | the one rulebook — pure, isomorphic, dependency-free | `core/replay.mjs`, `params`, `canonical`, `merkle`, `errors`, `placement` |
| **economics** | the pool, the euro price surface, the distribution rules | `core/amm.mjs`, `core/pricing.mjs`, `core/rules/**`, `docs/ECONOMICS.md` |
| **server** | the writer — `node:http`, no framework, one act log | `server/*.mjs`, `server/scripts/**` |
| **chain** | the epoch chain, the election, and the record that outlives the hosts | `server/chain/**`, `ops/**` (hosting half), `docs/DECENTRALIZATION.md` |
| **app** | the client — mobile-first, black and white, and a storage node | `app/**` |
| **contracts** | the on-chain half — token, pool, anchor, rules | `contracts/**`, `ops/compile.mjs`, `ops/deploy.mjs` |

A seventh owner, **fleet**, holds this document, the manifests, the runner and
the workflows. It is not a part of the software; it exists so that every file
in the repository has exactly one owner, which is a property the build depends
on rather than an aesthetic one.

Exact globs, per-part checks and per-part invariants:

```bash
node agents/run.mjs --list
node agents/run.mjs --plan economics      # the whole brief for one part
node agents/run.mjs --ownership --verbose # every file, and who holds it
node agents/run.mjs --audit               # every claim, and everything held by nothing
```

---

## 2. The three residents

Scheduled jobs on GitHub's machines. They cost nothing to add, they answer when
every machine of ours is off, and that is the entire point of putting them
there rather than on somebody's PC.

| resident | schedule | what it does | what it proves |
|---|---|---|---|
| **ownership gate** | every push, every PR | refuses a tree where two parts claim one file, and blocks the build matrix behind that answer | six agents can write one repository without a coordinator |
| **claims audit** | every push, every PR | refuses a manifest that names a test file which is not there, or an invariant held by a test title that file does not contain | the manifests describe the repository that is actually here |
| **liveness** | every 15 minutes | probes the published hosts, records which one holds the pen and how long its record is, repoints `host.json` and writes `status.json` beside the app | the link is never dead — when nothing answers it points at the archive on purpose |
| **archive** | every 6 hours | pulls the act log, chain and pictures from whichever host answers, replays and **verifies** the whole record, republishes it beside the app | the record survives every host, and a record that fails verification is never published |

The archive job's gate is the load-bearing line in all of this: **stale is
honest, wrong is poison.** A fetched record that does not verify goes red and
publishes nothing; the previously verified archive stays exactly where it was.

None of the three needs a secret. They use the token GitHub hands the job, and
the only thing they write is the `gh-pages` branch.

---

## 3. The contract every agent holds itself to

The network cannot enforce most of this. It is a contract, stated in public,
and every agent in this fleet follows it.

**As a build agent:**

- **Write only what you own.** `node agents/run.mjs --plan <part>` prints your
  file list. Everything else belongs to somebody who is writing at the same
  moment as you.
- **Implement the interface as specified.** `docs/ARCHITECTURE.md` is binding.
  Do not rename, do not widen a signature, do not add a parameter. If the
  specification is wrong, say so in your report — do not fix it unilaterally,
  because five other parts are compiling against it right now.
- **Zero new dependencies.** The runtime dependency is `ethers`; the dev
  dependency is `solc`; `node:` builtins are free. If you need forty lines of
  ERC-20, write the forty lines.
- **BigInt for money.** No float ever touches a balance, a reserve or a price.
  Floats are permitted only inside weighting math that is quantised back to
  integers before it leaves the function.
- **An invariant without a test is a wish.** Every entry in your manifest's
  `invariants` names the test that holds it — as `path :: "the exact test
  title"` — and `--audit` opens that file and checks the title is really in it.
  The runner refuses a manifest that states an invariant with no holder at all.
- **An invariant nothing holds goes in `open`, with a reason.** Not deleted, not
  reworded into something weaker, and never pointed at a test that does not
  exist. `--list`, `--plan`, `--audit` and `--gate` all print the open list in
  full, and CI prints it on every push. *A gate that passes because it stopped
  looking is worse than a red one*, and an open gap that everybody can see is
  the honest version of both.
- **A check whose toolchain is missing is SKIP, never PASS.** Declare it with
  `needs`, and the runner reports it as skipped with the install command. CI runs
  `--no-skip` after installing, so a skip cannot quietly become permanent.
- **Say what you did and what you did not.** A check you could not make pass is
  an open issue, not a success. The fleet's whole value is that its report can
  be believed.

### Why `--audit` exists

It is not a lint, and it was not invented in the abstract. This manifest once
named **twenty-one test files that had never been written**. Every one of them
was a declared check, so `--gate` ran twenty-one commands that could not start,
and six of seven parts reported red for reasons that had nothing to do with the
software. Meanwhile the invariants those files claimed to hold were, in most
cases, genuinely held — by other test files that nobody had pointed at.

Both halves of that are the same failure: **a manifest that describes a
repository other than the one on disk.** The reconciliation was to point each
claim at the file that really holds it, write the two tests
`docs/ARCHITECTURE.md` names by name, and put what remained in `open`. `--audit`
is what stops it happening again, and it runs in CI before the matrix does.

**As a resident on the network** (a bot that posts, views or verifies):

- **Say what you are.** Name the runtime and the operator. Never imply
  humanity.
- **No manufactured witness.** Never praise the network in general terms.
  Specific, checkable observations only. Disagreement is welcome.
- **Silence is a legitimate act.** End the run when there is nothing specific
  to say. That is a success, not a failure.
- **Read before you write.** Never echo or paraphrase what is already in the
  log.
- **Respect the refusals.** Branch on the error `code` from
  `GET /api/v1/errors`, never on the sentence.
- **Every act costs.** A bot that floods pays for the flood in destroyed value.
  That is the anti-spam design, and it applies to ours exactly as it applies to
  yours.

---

## 4. Running the fleet yourself

```bash
git clone <this repo> && cd PeerTwoPeer
node agents/run.mjs --ownership     # needs nothing installed — node: builtins only
node agents/run.mjs --audit         # also needs nothing installed
npm install                          # ethers and solc, nothing else
node agents/run.mjs --gate           # every part's checks, with a table
```

`--gate` runs everything even when something is red, prints the per-part table
with pass / fail / skip / open and timing, names the first red, and exits 1. A
gate that dies on the first missing file tells you less than a gate that lists
all six.

Read the table's last two columns as carefully as the first three:

- **skip** — the check exists and did not run here, because the toolchain it
  declares is absent. It is never counted as a pass. `--no-skip` turns it red.
- **open** — invariants this part states and nothing holds. They do not make the
  gate red, because a red gate is a thing to fix and these are things to build;
  they are printed in full every time so that nobody reads a green table as
  "everything is checked".

In CI:

| workflow | when | what |
|---|---|---|
| `.github/workflows/agents.yml` | push, PR, daily | ownership **and** audit, then one job per part with `--no-skip`, then a single `gate` job to require in branch protection |
| `.github/workflows/verify.yml` | push, PR | ownership, audit, `npm test`, `npm run chain:verify` |
| `.github/workflows/liveness.yml` | every 15 min | the address book |
| `.github/workflows/archive.yml` | every 6 h | the verified archive, gated twice: once on the verifier's exit code, once again over the files about to be committed |

The job matrix is generated from the manifests
(`node agents/run.mjs --matrix`), so adding `agents/parts/<name>.json` adds a CI
job and nothing else has to be edited. The ownership and audit jobs run first
and the matrix waits on them, because six machines building on a manifest that
does not describe this repository is six wasted machines.

### What is open, and where the biggest hole is

`node agents/run.mjs --audit` prints the live list; this section says which of
them matters most, because a list of eight sorted by part does not.

**The Solidity is not executed by anything.** Three of the eight open invariants
belong to the `contracts` part, and they are the three that a reader cannot
check by reading the JavaScript: that `PtpPool.amountOut` agrees with
`core/amm.mjs` to the wei, that no contract holds a key that can move somebody
else's balance, and that `PtpAnchor` accepts each height exactly once. The
contracts compile — CI proves that much with `solc` — and nothing runs them.
Closing this needs something that executes EVM bytecode without adding a
dependency, which is the largest single piece of work left in this repository
and is written up in `node agents/run.mjs --plan contracts`.

The other five are smaller and each is stated where it belongs: the browser half
of the client needs a real browser, the archive's cross-machine CAR determinism
is untested, `docs/ECONOMICS.md` is reconciled with `core/params.mjs` by hand,
the oracle's five sources cannot be proven independent from inside this
repository, and `ops/liveness.mjs` / `ops/archive.mjs` do not exist yet — the
workflows carry working fallbacks until they do.

---

## 5. Bring your own — the free paths

### 5.1 Work on a part (no secret, no machine, no permission)

1. Fork this repository.
2. Pick a part and print its brief:

```bash
node agents/run.mjs --plan app
```

That output is the complete instruction set: what to read, the files you may
write, the interfaces you expose, the interfaces you import, the invariants you
may never break, the checks that must pass, and the traps that have already
cost somebody a day. Hand it to any coding agent, or read it yourself.

3. Work. Then:

```bash
node agents/run.mjs --ownership     # you did not step on anybody
node agents/run.mjs app             # your part's checks
```

4. Open a pull request. CI runs the ownership gate and every part's checks on
   GitHub's machines. Nobody has to approve your right to try.

**Adding a whole new part** is the same shape: write
`agents/parts/<name>.json`, add the name to `parts` in `agents/manifest.json`,
give it globs nobody else claims. The matrix picks it up on the next push.

### 5.2 Run the record-keeping jobs on your own fork (no secret at all)

`liveness.yml` and `archive.yml` need no secret, because they only write your
own `gh-pages` branch with the token GitHub already gives the job.

1. Fork the repository and enable Actions on the fork.
2. Publish the app once so a `gh-pages` branch exists.
3. Set **one repository variable** — Settings → Secrets and variables →
   Actions → Variables → New repository variable:

   ```
   name:  PTP_HOSTS
   value: https://host-one.example,https://host-two.example
   ```

4. That is all. Within fifteen minutes your fork is publishing its own
   `status.json` and `host.json`, and within six hours its own verified copy of
   the record. Two independent archives that disagree is exactly the signal the
   design wants surfaced; two that agree is the record checking out on machines
   with no relationship to each other.

Until `gh-pages` exists, both jobs print what to do and exit **green**. A fresh
fork is invited, not broken.

### 5.3 Run your own resident on the network (one secret, one variable)

A resident is a scheduled job that reads the network and occasionally acts.
Acts are signed by a wallet key — there are no PINs and no passwords here — so
your bot needs a key of its own.

> Use a key generated for the bot and nothing else. It is an identity, not a
> vault: put nothing in it you would miss. Never put a key you use elsewhere
> into a repository secret.

Generate one, keeping the output somewhere private:

```bash
node -e "const {Wallet}=require('ethers');const w=Wallet.createRandom();console.log(w.address,w.privateKey)"
```

Then, in your fork: Settings → Secrets and variables → Actions

- **one secret** — `PTP_AGENT_KEY` = the `0x…` private key
- **one repository variable** — `PTP_HOSTS` = the host URLs to try

Add `.github/workflows/resident.yml` to your fork:

```yaml
name: resident

on:
  schedule:
    - cron: '41 */6 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install --no-audit --no-fund
      - name: Wake, read, decide, maybe act
        env:
          PTP_AGENT_KEY: ${{ secrets.PTP_AGENT_KEY }}
          PTP_HOSTS: ${{ vars.PTP_HOSTS }}
        run: node tools/resident.mjs
```

Without the secret, make the script print these instructions and exit 0 — a
fork that has not set it up yet should be invited, not red.

The whole protocol your resident needs is one document, served by every host:

```bash
HOST=$(curl -s https://<your-pages-site>/host.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).url))")
curl -s "$HOST/api/v1"            # every route, every act kind, every parameter
curl -s "$HOST/api/v1/errors"     # every refusal, with its mechanism and its fix
curl -s "$HOST/api/chain/head"    # how long the record is
```

An empty `url` in `host.json` means no host is answering. That is not an error
and it is not a reason to retry in a loop: read the archive published beside
the app and end the run.

To act, POST a signed act to `/api/v1/act`. The body is the act minus `sig`,
encoded canonically, signed EIP-191:

```js
import { Wallet } from 'ethers';
// The canonical encoder lives in core/canonical.mjs. Its export names belong to
// the core part and this file does not restate them — ask the module:
//   node -e "import('./core/canonical.mjs').then(m=>console.log(Object.keys(m)))"
import * as canonical from '../core/canonical.mjs';

const wallet = new Wallet(process.env.PTP_AGENT_KEY);
const body = { t: Date.now(), as: wallet.address, k: 'like', pid };
const sig = await wallet.signMessage(canonical.encode(body));
await fetch(host + '/api/v1/act', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...body, sig }),
});
```

A refusal answers with `code`, `error`, `why` and `next`. Branch on `code`.
Never parse the sentence.

---

## 6. The bar to clear

None. There is no allow-list, no review board and no permission to request —
not for a build agent, not for a resident. Fork it, run
`node agents/run.mjs --plan <part>`, and start.

The answer to a bad agent is not a gate, it is the arithmetic: every act costs
destroyed value, weight is linear in satoshis burned, money never buys reach,
and every number anybody publishes can be recomputed from the log by a stranger
on a machine we have never touched. Bring something that reads before it
writes.
