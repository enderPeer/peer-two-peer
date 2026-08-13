# `agents/` — the fleet

Six agents build this repository at the same time, on machines that never see
each other. Nothing about that is safe by default: two agents editing one file
is a lost edit, and a part that quietly widens an interface breaks a part
nobody told. So the split is written down instead of remembered, and this
directory is where it is written.

```
agents/
├─ manifest.json      the fleet: which parts exist, what the fleet itself owns,
│                     the contract every agent holds itself to
├─ parts/<name>.json  one per part: files owned, checks, invariants,
│                     dependencies, and the brief an agent works from
└─ run.mjs            the runner — node: builtins only, no dependencies
```

## The runner

```bash
node agents/run.mjs --list              # the fleet, and what each part owns
node agents/run.mjs --ownership         # no file with two owners, none with zero
node agents/run.mjs --plan core         # the brief an agent needs for one part
node agents/run.mjs core                # run one part's checks
node agents/run.mjs --gate              # run every part's checks, print the table
node agents/run.mjs --matrix            # the CI job list, as JSON
```

Flags: `--json` (machine output for `--list` and `--plan`), `--verbose` (full
file lists for `--ownership`), `--fail-fast` (stop at the first red check),
`--soft` (report ownership problems without failing).

Exit codes: `0` green, `1` a check or an ownership rule failed, `2` you asked
for something that does not exist.

The runner imports nothing. It has to run in a fresh checkout before anything
has been installed, because the first thing CI does is ask it whether the
repository is safe to build.

## `--ownership` is the load-bearing one

It walks the working tree, skips what `.gitignore` skips, and asks every
owner's globs which files they claim. Two outcomes are red:

- **COLLISION** — two owners claim one file. This is the lost-edit case, and
  it is why the check runs *before* the build matrix rather than after it.
- **UNOWNED** — no part holds an invariant for a file. A smaller problem, but
  the one that grows.

Both are fixed by one line in `agents/parts/*.json`, which is why the report
names the file and stops talking.

Globs that match nothing are printed but never fail: most of this repository is
still a promise. A glob that never matches is usually a typo, which is worth
knowing before it shows up as an UNOWNED file three days later.

## Adding a part

Write `agents/parts/<name>.json`, add `<name>` to `parts` in `manifest.json`,
and make sure its `owns` globs overlap nobody. CI picks it up on the next push:
the job matrix in `.github/workflows/agents.yml` is generated from
`node agents/run.mjs --matrix`, so a new part is a new job and nothing else has
to be touched.

Every part manifest declares:

| field | what it is |
|---|---|
| `owns` | the file globs this part, and only this part, may write |
| `dependsOn` | other parts whose interfaces it imports |
| `interfaces` | the exact surface it exposes — other parts import this and nothing else |
| `checks` | shell commands that must exit 0, each with the reason it exists |
| `invariants` | what it may never break, in prose, each naming the test that holds it |
| `brief` | mission, what to read first, house rules, done-when, and the traps |

An invariant without a test that holds it is a wish. The loader refuses a
manifest that states one.

## What the checks look like now

Red, mostly. The parts are being written as this is read, and a check that
names a test file nobody has written yet fails with `Could not find`. That is
the intended state of a fleet mid-build: `--gate` runs everything, prints the
table, names the first red, and exits 1 without crashing.

Full documentation of who the agents are and how a stranger adds their own —
fork, one secret, one repository variable, on GitHub's machines, free — is in
`docs/AGENTS.md`.
