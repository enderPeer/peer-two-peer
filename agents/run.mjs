#!/usr/bin/env node
// The fleet runner: one command that knows which agent owns which file, what
// each part has to prove before it is allowed to be called finished, and what
// an agent needs to be told before it can work on a part alone.
//
// Why this exists at all. Several agents build this repository at the same
// time, on machines that never see each other. Nothing about that is safe by
// default: two agents editing one file is a lost edit, and a part that quietly
// widens an interface breaks a part nobody told. So the split is written down
// instead of assumed — agents/manifest.json plus agents/parts/*.json — and
// this runner is the thing that reads it back and tells the truth about it:
//
//   --list        who the fleet is and what each part owns
//   --ownership   no file has two owners, and no file has none
//   --audit       every claim a manifest makes names something that exists
//   --plan <part> the brief an agent needs to work on one part
//   <part>        run that part's checks
//   --gate        run every part's checks and print the table
//
// The load-bearing one is --ownership. It is not a lint; it is the check that
// keeps parallel agents from colliding, and CI runs it before it runs anything
// else, because a matrix of six jobs editing one file is six wasted jobs.
//
// --audit is the second one, and it exists because of a specific failure. This
// manifest once named twenty-one test files that had never been written. Every
// one of them was a check the gate ran, failed on, and reported as a red part —
// so the fleet spent a whole round looking red for tests that did not exist,
// while the invariants those tests were supposed to hold were actually held by
// other files nobody had pointed at. A manifest that names a test that is not
// there is not a stricter manifest; it is a manifest nobody can read. --audit
// makes that state impossible to commit: every command a check runs, and every
// test an invariant claims to be held by, must resolve to a file that exists and
// to a test title that file actually contains.
//
// An invariant that genuinely has nothing holding it is not deleted and not
// disguised. It goes in the part's "open" list, which every command here prints
// in full. A gate that is green with three open gaps named is honest; a gate that
// is green because somebody removed the check is not.
//
// node: builtins only. No dependencies, ever — this file has to run in a fresh
// checkout before anything is installed.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MANIFEST = join(HERE, 'manifest.json');
const PARTS_DIR = join(HERE, 'parts');

// Directories we never walk into, whatever .gitignore says. .git is not source,
// and node_modules is somebody else's source.
const NEVER_WALK = new Set(['.git', 'node_modules']);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const after = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

// ── glob ────────────────────────────────────────────────────────────────────

/**
 * Turn one ownership glob into an anchored regular expression.
 *
 * Deliberately small: `**` crosses directories, `*` and `?` do not, `{a,b}`
 * alternates. Paths are compared with forward slashes on every platform, so a
 * manifest written on Linux means the same thing when an agent runs it on
 * Windows. Anything fancier would make ownership harder to read than the code
 * it governs, and ownership has to be readable to be trusted.
 */
export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + g.slice(i + 1, end).split(',').map(esc).join('|') + ')';
      i = end;
    } else {
      re += esc(c);
    }
  }
  return new RegExp('^' + re + '$');
}

/** Does any glob in the list match this repo-relative path? */
export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ── the fleet ───────────────────────────────────────────────────────────────

/**
 * Read manifest.json and every part manifest it names.
 *
 * Loading is strict on purpose: a part that names a file it does not have, or
 * a check with no command, is a manifest that lies, and a lying manifest is
 * worse than none — the whole point of this file is that agents can act on it
 * without asking a human. A bad manifest fails here, loudly, not later in a
 * matrix job whose logs nobody reads.
 */
export function loadFleet() {
  if (!existsSync(MANIFEST)) throw new Error('no agents/manifest.json at ' + MANIFEST);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error('manifest.parts is empty');

  const parts = manifest.parts.map((name) => {
    const file = join(PARTS_DIR, name + '.json');
    if (!existsSync(file)) throw new Error('manifest names part "' + name + '" but ' + file + ' does not exist');
    const part = JSON.parse(readFileSync(file, 'utf8'));
    if (part.name !== name) throw new Error(file + ' declares name "' + part.name + '", expected "' + name + '"');
    for (const field of ['title', 'summary', 'owns', 'checks', 'invariants', 'brief']) {
      if (part[field] === undefined) throw new Error(file + ' is missing "' + field + '"');
    }
    if (!Array.isArray(part.owns) || !part.owns.length) throw new Error(file + ' owns nothing');
    for (const c of part.checks) {
      if (!c.name || !c.run) throw new Error(file + ' has a check with no name or no run command');
    }
    for (const inv of part.invariants) {
      if (!inv.statement || !inv.heldBy) throw new Error(file + ' has an invariant with no statement or no test holding it');
    }
    // An open gap is a claim the part makes and cannot yet check. It must say
    // what is not held and why, because "open" with no reason is indistinguishable
    // from a claim somebody quietly dropped.
    part.open = part.open || [];
    for (const gap of part.open) {
      if (!gap.statement || !gap.why) throw new Error(file + ' has an open gap with no statement or no reason');
    }
    part.file = relative(ROOT, file).replace(/\\/g, '/');
    part.dependsOn = part.dependsOn || [];
    return part;
  });

  // The fleet owns its own scaffolding. It is not a part of the software — it
  // has no invariants about money — but it is files in the repository, and
  // every file needs exactly one owner or --ownership means nothing.
  const fleet = manifest.fleet;
  if (!fleet || !Array.isArray(fleet.owns)) throw new Error('manifest.fleet.owns is missing');
  fleet.name = fleet.name || 'fleet';
  fleet.checks = fleet.checks || [];
  fleet.invariants = fleet.invariants || [];
  fleet.open = fleet.open || [];
  fleet.file = 'agents/manifest.json';

  for (const p of parts) {
    for (const d of p.dependsOn) {
      if (!manifest.parts.includes(d)) throw new Error(p.file + ' depends on unknown part "' + d + '"');
    }
  }

  return { manifest, parts, fleet, owners: [...parts, fleet] };
}

// ── the repository ──────────────────────────────────────────────────────────

/**
 * The ignore set: what is in the working tree but is not source.
 *
 * Read from .gitignore, in the small subset of its syntax this repository
 * actually uses, plus whatever manifest.json adds. Deriving it from .gitignore
 * rather than restating it means the ownership check and git agree about what
 * a file is, which is the only way "every file is owned" can be a true
 * statement rather than a maintained list.
 */
export function ignorePatterns(manifest) {
  const out = [...(manifest.ignore || [])];
  const gi = join(ROOT, '.gitignore');
  if (existsSync(gi)) {
    for (const raw of readFileSync(gi, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      let p = line.replace(/^\.\//, '');
      if (p.endsWith('/')) p += '**';
      if (!p.includes('/')) p = '**/' + p;
      out.push(p);
      if (p.endsWith('/**')) out.push(p.slice(0, -3));
    }
  }
  return out;
}

/** Every source file in the repository, repo-relative, forward slashes, sorted. */
export function listRepoFiles(ignore) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (NEVER_WALK.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(ROOT, abs).replace(/\\/g, '/');
      if (matchesAny(rel, ignore)) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(ROOT);
  return files.sort();
}

/**
 * Who owns what, and where that goes wrong.
 *
 * Two failures, and they are different failures. A COLLISION is two agents
 * editing one file — the lost-edit case, and the reason this runs before the
 * build matrix rather than after it. An UNOWNED file is a file nobody has
 * agreed to hold invariants for; it is a smaller problem, but it is the one
 * that grows, so it is also red. The fix for both is one line in a part
 * manifest, which is why the report names the file and nothing else.
 */
export function ownership(fleet) {
  const ignore = ignorePatterns(fleet.manifest);
  const files = listRepoFiles(ignore);
  const owners = new Map();          // path -> [owner name]
  const claimed = new Map();         // owner name -> [path]

  for (const o of fleet.owners) claimed.set(o.name, []);
  for (const f of files) {
    const hits = fleet.owners.filter((o) => matchesAny(f, o.owns)).map((o) => o.name);
    owners.set(f, hits);
    for (const h of hits) claimed.get(h).push(f);
  }

  const collisions = [...owners].filter(([, hits]) => hits.length > 1).map(([f, hits]) => ({ file: f, hits }));
  const unowned = [...owners].filter(([, hits]) => hits.length === 0).map(([f]) => f);

  // Globs that match nothing yet are not an error — most of this repository is
  // still being written — but they are worth printing, because a glob that
  // never matches is usually a typo that would have shown up as an UNOWNED
  // file much later.
  const empty = [];
  for (const o of fleet.owners) {
    for (const g of o.owns) {
      const re = globToRegExp(g);
      if (!files.some((f) => re.test(f))) empty.push({ owner: o.name, glob: g });
    }
  }

  return { files, owners, claimed, collisions, unowned, empty };
}

// ── auditing the claims ─────────────────────────────────────────────────────

// A path inside a command or a sentence: at least one directory, then a file
// with an extension this repository actually uses. Deliberately narrow, because
// the alternative — treating every dotted word as a path — would report prose.
//
// The extensions are ordered longest-first. Alternation in a regular expression
// takes the first branch that matches, not the longest, so `js` ahead of `json`
// reads `ops/addresses.json` as a file called `ops/addresses.js` and reports a
// missing file that is sitting right there.
const PATH_RE = /(?:^|[\s"'`(=])((?:\.?[A-Za-z0-9_@\-]+\/)+[A-Za-z0-9_.\-]+\.(?:mjs|cjs|jsonl|json|ya?ml|html|css|md|sol|js))/g;

/** Every repo-relative path a string mentions. */
export function pathsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(PATH_RE)) out.push(m[1]);
  return out;
}

/**
 * `heldBy` in the one form this repository writes it:
 *
 *     test/wall.test.mjs :: "a token millionaire ranks exactly where a pauper does"
 *
 * The quotes are required rather than optional, because a test title can contain
 * a dash, a colon and a comma, and an unquoted title cannot be told from the
 * prose that follows it. Anything that is not in that form is still checked for
 * the paths it names — a workflow file or a command is a legitimate holder of an
 * invariant, and it still has to exist.
 */
export function parseHeldBy(heldBy) {
  const m = /^\s*([^\s:]+)\s*::\s*"([^"]+)"/.exec(String(heldBy));
  if (!m) return { file: null, title: null, paths: pathsIn(heldBy) };
  return { file: m[1], title: m[2], paths: pathsIn(heldBy) };
}

/**
 * Every claim in every manifest, checked against the repository as it is.
 *
 * Three kinds of lie are caught, and they are all the same lie told at different
 * distances from the code:
 *
 *   a check that runs a file that is not there — the gate goes red for a reason
 *     that has nothing to do with the software;
 *   an invariant held by a test file that is not there — the gate goes green and
 *     the invariant is held by nothing;
 *   an invariant held by a test title that file does not contain — the file was
 *     renamed or the test was deleted, and the manifest still points at the ghost.
 *
 * The third is the one that matters most, and it is why the title is compared
 * rather than only the filename: moving a test out of a file is exactly how a
 * manifest starts lying without anybody editing it.
 */
export function auditClaims(fleet) {
  const problems = [];
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      try { cache.set(rel, readFileSync(join(ROOT, rel), 'utf8')); } catch { cache.set(rel, null); }
    }
    return cache.get(rel);
  };
  const here = (rel) => existsSync(join(ROOT, rel));

  for (const owner of fleet.owners) {
    const where = owner.file;

    for (const c of owner.checks) {
      for (const p of pathsIn(c.run)) {
        if (!here(p)) problems.push({ where, kind: 'check', name: c.name, detail: `runs ${p}, which does not exist` });
      }
      if (c.needs && !c.needs.module) {
        problems.push({ where, kind: 'check', name: c.name, detail: '"needs" must name a module' });
      }
    }

    for (const inv of owner.invariants) {
      const { file, title, paths } = parseHeldBy(inv.heldBy);
      for (const p of paths) {
        if (!here(p)) problems.push({ where, kind: 'invariant', name: inv.statement, detail: `held by ${p}, which does not exist` });
      }
      if (!file) {
        if (!paths.length) problems.push({ where, kind: 'invariant', name: inv.statement, detail: 'heldBy names no file at all' });
        continue;
      }
      const text = read(file);
      if (text === null) continue; // already reported above
      if (!text.includes(title)) {
        problems.push({ where, kind: 'invariant', name: inv.statement, detail: `${file} contains no test called "${title}"` });
      }
    }

    // Open gaps are deliberately NOT checked for the paths they name. A gap is
    // most often a file that has not been written yet, and reporting "you named
    // a file that does not exist" against the list whose whole purpose is to name
    // what is missing would push people to describe the gap vaguely instead of
    // precisely. loadFleet already refuses a gap with no statement or no reason,
    // which is the only shape requirement worth having here.
  }
  return problems;
}

// ── running checks ──────────────────────────────────────────────────────────

const require_ = createRequire(join(ROOT, 'package.json'));

/**
 * Whether the toolchain a check declares is present in this checkout.
 *
 * One check in this repository needs a devDependency: `solc`, which compiles the
 * contracts. On a CI runner it is installed and the check runs for real; in a
 * fresh checkout with no node_modules it is absent, and the honest report is
 * SKIPPED with the reason, not PASS. A skipped check is never counted as a pass
 * anywhere, and `--no-skip` turns every skip into a failure — which is what CI
 * uses, after the install, so the skip can never become permanent by accident.
 */
function missingNeed(check) {
  if (!check.needs || !check.needs.module) return null;
  try {
    require_.resolve(check.needs.module);
    return null;
  } catch {
    return check.needs;
  }
}

const ms = (t) => (Number(t) / 1e6);
const secs = (t) => (ms(t) / 1000).toFixed(1) + 's';

/**
 * Run one check and report it, never throw.
 *
 * Everything is captured rather than inherited so a failure can print the tail
 * of its own output next to the table instead of scrolling it away, and so
 * --gate stays readable when six parts fail at once. A command that cannot be
 * spawned at all is a failed check, not a crashed runner: right now most of
 * this repository does not exist yet, and a gate that dies on the first
 * missing file tells you less than a gate that lists all six.
 */
export function runCheck(check, opts = {}) {
  const started = process.hrtime.bigint();

  const need = missingNeed(check);
  if (need && !opts.noSkip) {
    return {
      name: check.name,
      run: check.run,
      why: check.why || '',
      ok: false,
      skipped: true,
      status: null,
      reason: `${need.module} is not installed — ${need.install || 'npm install'}`,
      output: need.why || '',
      tookMs: 0,
    };
  }

  const res = spawnSync(check.run, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: Math.max(10_000, Number(check.timeoutMs || opts.timeoutMs || 300_000)),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PTP_AGENT_CHECK: check.name },
  });
  const took = process.hrtime.bigint() - started;
  const out = [res.stdout || '', res.stderr || ''].join('').trim();
  const spawnFailed = !!res.error;
  return {
    name: check.name,
    run: check.run,
    why: check.why || '',
    ok: !spawnFailed && res.status === 0,
    skipped: false,
    status: spawnFailed ? null : res.status,
    reason: spawnFailed ? String(res.error.message || res.error) : (res.signal ? 'killed by ' + res.signal : ''),
    output: out,
    tookMs: ms(took),
  };
}

/**
 * Run every check of one part, in declaration order.
 *
 * A part is green when nothing failed. A skip is neither a pass nor a failure:
 * it is counted in its own column and printed by name, so a reader of the table
 * can see exactly which claims this machine did not test.
 */
export function runPart(part, opts = {}) {
  const results = [];
  for (const c of part.checks) {
    const r = runCheck(c, opts);
    results.push(r);
    if (opts.failFast && !r.ok && !r.skipped) break;
  }
  return {
    part: part.name,
    results,
    ok: results.every((r) => r.ok || r.skipped) && results.length === part.checks.length,
    skipped: results.filter((r) => r.skipped).length,
    tookMs: results.reduce((a, r) => a + r.tookMs, 0),
  };
}

// ── printing ────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const rule = (n = 72) => '─'.repeat(n);

function printTable(rows, cols) {
  const w = cols.map((c) => Math.max(c.head.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((c, i) => (cols[i].right ? padL(c, w[i]) : pad(c, w[i]))).join('  ');
  console.log(line(cols.map((c) => c.head)));
  console.log(w.map((n) => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => String(c.get(r)))));
}

function tail(text, lines = 20) {
  const all = text.split(/\r?\n/);
  const cut = all.slice(-lines);
  return (all.length > lines ? '    … ' + (all.length - lines) + ' earlier lines\n' : '') +
    cut.map((l) => '    ' + l).join('\n');
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdList(fleet) {
  if (flag('--json')) {
    console.log(JSON.stringify({
      network: fleet.manifest.network,
      parts: fleet.parts.map((p) => ({
        name: p.name, title: p.title, owns: p.owns, dependsOn: p.dependsOn,
        checks: p.checks.length, invariants: p.invariants.length, open: p.open,
      })),
      fleet: { name: fleet.fleet.name, owns: fleet.fleet.owns },
    }, null, 2));
    return 0;
  }
  console.log(fleet.manifest.network + ' — the build fleet');
  console.log(fleet.manifest.why);
  console.log('');
  printTable(fleet.parts, [
    { head: 'part', get: (p) => p.name },
    { head: 'owns', get: (p) => p.owns.length + ' globs', right: true },
    { head: 'checks', get: (p) => p.checks.length, right: true },
    { head: 'invariants', get: (p) => p.invariants.length, right: true },
    { head: 'open', get: (p) => p.open.length, right: true },
    { head: 'depends on', get: (p) => (p.dependsOn.length ? p.dependsOn.join(', ') : '—') },
    { head: 'what it is', get: (p) => p.title },
  ]);
  console.log('');
  for (const p of fleet.parts) {
    console.log(p.name);
    for (const g of p.owns) console.log('    ' + g);
  }
  console.log(fleet.fleet.name + '  (the fleet\'s own scaffolding — not a part of the software)');
  for (const g of fleet.fleet.owns) console.log('    ' + g);
  const gaps = fleet.parts.reduce((a, p) => a + p.open.length, 0) + fleet.fleet.open.length;
  if (gaps) {
    console.log('');
    console.log(gaps + ' invariant' + (gaps === 1 ? ' is' : 's are') + ' stated and held by nothing — node agents/run.mjs --audit lists them.');
  }
  console.log('');
  console.log('node agents/run.mjs --plan <part>   the brief for one part');
  console.log('node agents/run.mjs <part>          run one part\'s checks');
  console.log('node agents/run.mjs --audit         every claim names something that exists');
  console.log('node agents/run.mjs --gate          run everything');
  return 0;
}

function cmdOwnership(fleet) {
  const o = ownership(fleet);
  const soft = flag('--soft');

  console.log('ownership — ' + o.files.length + ' source files, ' + fleet.owners.length + ' owners');
  console.log(rule());
  printTable(fleet.owners, [
    { head: 'owner', get: (x) => x.name },
    { head: 'files', get: (x) => o.claimed.get(x.name).length, right: true },
    { head: 'globs', get: (x) => x.owns.length, right: true },
  ]);

  if (flag('--verbose')) {
    console.log('');
    for (const owner of fleet.owners) {
      const files = o.claimed.get(owner.name);
      if (!files.length) continue;
      console.log(owner.name);
      for (const f of files) console.log('    ' + f);
    }
  }

  if (o.empty.length) {
    // Not an error: most of this repository is a promise rather than a file
    // yet. Printed short so it stays readable in a CI log, because the two
    // things below it are the ones that stop a build.
    const show = flag('--verbose') ? o.empty : o.empty.slice(0, 8);
    console.log('');
    console.log('globs that match nothing yet (' + o.empty.length + ') — expected while the repo is being');
    console.log('written, but a glob that never matches is usually a typo:');
    for (const e of show) console.log('    ' + pad(e.owner, 10) + e.glob);
    if (show.length < o.empty.length) console.log('    … ' + (o.empty.length - show.length) + ' more (--verbose for all)');
  }

  let bad = 0;
  if (o.collisions.length) {
    bad += o.collisions.length;
    console.log('');
    console.log('COLLISION — two owners claim the same file. Two agents editing one file is a lost edit.');
    for (const c of o.collisions) console.log('    ' + c.file + '   claimed by: ' + c.hits.join(', '));
    console.log('  Fix: narrow one of the globs in agents/parts/*.json so exactly one owner matches.');
  }
  if (o.unowned.length) {
    bad += o.unowned.length;
    console.log('');
    console.log('UNOWNED — no part holds any invariant for these files:');
    for (const f of o.unowned) console.log('    ' + f);
    console.log('  Fix: add the file to the "owns" list of the part it belongs to, or to');
    console.log('  "ignore" in agents/manifest.json if it is not source.');
  }

  console.log('');
  if (!bad) { console.log('OK — every source file has exactly one owner.'); return 0; }
  console.log(bad + ' ownership problem' + (bad === 1 ? '' : 's') + '.');
  if (soft) { console.log('(--soft: reporting only)'); return 0; }
  return 1;
}

function cmdPlan(fleet, name) {
  const part = fleet.parts.find((p) => p.name === name) || (fleet.fleet.name === name ? fleet.fleet : null);
  if (!part) { console.error('no such part: ' + name); return 2; }
  if (flag('--json')) { console.log(JSON.stringify(part, null, 2)); return 0; }

  const b = part.brief || {};
  console.log(rule());
  console.log('BRIEF — ' + fleet.manifest.network + ' / part "' + part.name + '"');
  console.log(rule());
  console.log('');
  console.log(part.title);
  console.log('');
  console.log(wrap(part.summary));
  if (b.mission) { console.log(''); console.log(wrap(b.mission)); }

  console.log('');
  console.log('READ FIRST, IN FULL');
  for (const r of (b.readFirst || fleet.manifest.readFirst || [])) console.log('  - ' + r);

  console.log('');
  console.log('YOU OWN EXACTLY THESE FILES AND NO OTHERS');
  for (const g of part.owns) console.log('  ' + g);
  console.log('  Any other file belongs to another agent working at the same time.');

  if (part.dependsOn && part.dependsOn.length) {
    console.log('');
    console.log('YOU DEPEND ON');
    for (const d of part.dependsOn) {
      const dep = fleet.parts.find((p) => p.name === d);
      console.log('  ' + d + ' — ' + (dep ? dep.title : '?'));
      for (const i of (dep && dep.interfaces) || []) console.log('      ' + i);
    }
    console.log('  Import these exactly as written. Do not widen a signature; if one is');
    console.log('  wrong, say so in your report rather than changing it on your own.');
  }
  if (part.interfaces && part.interfaces.length) {
    console.log('');
    console.log('THE SURFACE YOU EXPOSE — other parts import this and nothing else');
    for (const i of part.interfaces) console.log('  ' + i);
  }

  console.log('');
  console.log('INVARIANTS YOU MAY NEVER BREAK');
  for (const inv of part.invariants) {
    console.log('  * ' + wrap(inv.statement, 4).trim());
    console.log('      held by: ' + inv.heldBy);
  }

  if (part.open && part.open.length) {
    console.log('');
    console.log('OPEN — stated by this part and held by nothing yet. Not a licence to break');
    console.log('them; a list of what you would be the first person to check.');
    for (const gap of part.open) {
      console.log('  ? ' + wrap(gap.statement, 4).trim());
      console.log('      why not: ' + wrap(gap.why, 8).trim());
    }
  }

  console.log('');
  console.log('CHECKS THAT MUST PASS');
  for (const c of part.checks) {
    console.log('  $ ' + c.run);
    if (c.why) console.log('      ' + c.why);
    if (c.needs) console.log('      needs ' + c.needs.module + ' (' + (c.needs.install || 'npm install') + '); skipped, never passed, when it is absent');
  }

  const rules = (b.rules || []).concat(fleet.manifest.contract || []);
  if (rules.length) {
    console.log('');
    console.log('HOUSE RULES — correctness requirements, not style');
    for (const r of rules) console.log('  - ' + wrap(r, 4).trim());
  }
  if (b.doneWhen) {
    console.log('');
    console.log('DONE WHEN');
    for (const d of b.doneWhen) console.log('  - ' + d);
  }
  if (b.traps) {
    console.log('');
    console.log('KNOWN TRAPS — these have already cost somebody a day');
    for (const t of b.traps) console.log('  ! ' + wrap(t, 4).trim());
  }
  console.log('');
  console.log('REPORT HONESTLY. A failing check you could not fix is an open issue, not a success.');
  console.log(rule());
  return 0;
}

function wrap(text, indent = 0, width = 78) {
  const pre = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = pre;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim()) { lines.push(line); line = pre; }
    line += (line.trim() ? ' ' : '') + w;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}

function reportPart(run, part) {
  for (const r of run.results) {
    const verdict = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log('  ' + verdict + '  ' + pad(r.name, 34) + padL(r.tookMs.toFixed(0) + 'ms', 8));
    if (r.skipped) {
      console.log('        $ ' + r.run);
      console.log('        ' + r.reason);
      if (r.why) console.log('        this check holds: ' + r.why);
      console.log('        NOT a pass. Install it and run again, or use --no-skip to make this red.');
    } else if (!r.ok) {
      console.log('        $ ' + r.run);
      if (r.reason) console.log('        ' + r.reason);
      else console.log('        exit ' + r.status);
      if (r.why) console.log('        why this check exists: ' + r.why);
      if (r.output) console.log(tail(r.output));
    }
  }
  const notRun = part.checks.length - run.results.length;
  if (notRun > 0) console.log('  ' + notRun + ' further check' + (notRun === 1 ? '' : 's') + ' not run (--fail-fast)');
  reportOpen(part);
}

/** The claims a part makes and cannot check. Printed everywhere the part is,
 * because an open gap that is only visible in a file nobody opens is a gap that
 * gets forgotten, and a forgotten gap reads as a held invariant. */
function reportOpen(part) {
  if (!part.open || !part.open.length) return;
  console.log('  OPEN — ' + part.open.length + ' invariant' + (part.open.length === 1 ? '' : 's') + ' this part states and nothing holds:');
  for (const gap of part.open) {
    console.log('    * ' + wrap(gap.statement, 6).trim());
    console.log('        why not: ' + wrap(gap.why, 8).trim());
  }
}

function cmdRunPart(fleet, name) {
  const part = fleet.parts.find((p) => p.name === name) || (fleet.fleet.name === name ? fleet.fleet : null);
  if (!part) { console.error('no such part: ' + name + '  (try --list)'); return 2; }
  if (!part.checks.length) { console.log(part.name + ': no checks declared'); return 0; }
  console.log(part.name + ' — ' + part.title);
  console.log(rule());
  const run = runPart(part, { failFast: flag('--fail-fast'), noSkip: flag('--no-skip') });
  reportPart(run, part);
  console.log(rule());
  console.log(part.name + ': ' + (run.ok ? 'green' : 'RED') + ' in ' + (run.tookMs / 1000).toFixed(1) + 's' +
    (run.skipped ? '  (' + run.skipped + ' skipped)' : ''));
  return run.ok ? 0 : 1;
}

function cmdAudit(fleet) {
  const problems = auditClaims(fleet);
  const owners = fleet.owners;
  const claims = owners.reduce((a, o) => a + o.checks.length + o.invariants.length, 0);
  const gaps = owners.reduce((a, o) => a + o.open.length, 0);

  console.log('audit — ' + claims + ' claims across ' + owners.length + ' owners, ' + gaps + ' declared open');
  console.log(rule());
  printTable(owners, [
    { head: 'owner', get: (o) => o.name },
    { head: 'checks', get: (o) => o.checks.length, right: true },
    { head: 'invariants', get: (o) => o.invariants.length, right: true },
    { head: 'open', get: (o) => o.open.length, right: true },
    { head: 'problems', get: (o) => problems.filter((p) => p.where === o.file).length, right: true },
  ]);

  if (gaps) {
    console.log('');
    console.log('OPEN — stated by a part, held by nothing. Named here rather than deleted,');
    console.log('because a gate that passes by looking away is worse than one that is red:');
    for (const o of owners) {
      for (const gap of o.open) {
        console.log('    ' + pad(o.name, 10) + wrap(gap.statement, 15).trim());
        console.log('    ' + pad('', 10) + 'why not: ' + wrap(gap.why, 19).trim());
      }
    }
  }

  console.log('');
  if (!problems.length) {
    console.log('OK — every check runs a file that exists, and every invariant names a test that does.');
    return 0;
  }
  console.log('BROKEN CLAIMS — a manifest that names something that is not there cannot be acted on:');
  for (const p of problems) console.log('    ' + pad(p.where, 28) + p.kind + ': ' + p.detail + '\n' + ' '.repeat(32) + '(' + p.name + ')');
  console.log('');
  console.log(problems.length + ' broken claim' + (problems.length === 1 ? '' : 's') + '.');
  console.log('  Fix: point the claim at the file that really holds it, or move it to "open" with a reason.');
  return 1;
}

function cmdGate(fleet) {
  const failFast = flag('--fail-fast');
  const noSkip = flag('--no-skip');
  const owners = [fleet.fleet, ...fleet.parts];
  const runs = [];
  let firstRed = null;

  for (const part of owners) {
    if (!part.checks.length) continue;
    console.log('');
    console.log('── ' + part.name + ' ' + '─'.repeat(Math.max(1, 68 - part.name.length)));
    const run = runPart(part, { failFast, noSkip });
    runs.push({ run, part });
    reportPart(run, part);
    if (!run.ok && !firstRed) {
      const bad = run.results.find((r) => !r.ok && !r.skipped) || run.results.find((r) => !r.ok);
      firstRed = part.name + ' / ' + bad.name;
    }
    if (!run.ok && failFast) break;
  }

  console.log('');
  console.log(rule());
  printTable(runs, [
    { head: 'part', get: (x) => x.part.name },
    { head: 'checks', get: (x) => x.part.checks.length, right: true },
    { head: 'pass', get: (x) => x.run.results.filter((r) => r.ok).length, right: true },
    { head: 'fail', get: (x) => x.run.results.filter((r) => !r.ok && !r.skipped).length, right: true },
    { head: 'skip', get: (x) => x.run.skipped, right: true },
    { head: 'open', get: (x) => x.part.open.length, right: true },
    { head: 'time', get: (x) => (x.run.tookMs / 1000).toFixed(1) + 's', right: true },
    { head: '', get: (x) => (x.run.ok ? 'green' : 'RED') },
  ]);
  console.log(rule());

  const total = runs.reduce((a, x) => a + x.run.tookMs, 0);
  const skipped = runs.reduce((a, x) => a + x.run.skipped, 0);
  const open = runs.reduce((a, x) => a + x.part.open.length, 0);
  if (firstRed) {
    console.log('GATE RED. First red: ' + firstRed);
    console.log('Run  node agents/run.mjs ' + firstRed.split(' / ')[0] + '  to work on it alone,');
    console.log('or   node agents/run.mjs --plan ' + firstRed.split(' / ')[0] + '  for what that part is supposed to hold.');
    return 1;
  }

  console.log('gate green — ' + runs.length + ' parts in ' + (total / 1000).toFixed(1) + 's' +
    (skipped ? ', ' + skipped + ' check' + (skipped === 1 ? '' : 's') + ' skipped' : '') +
    (open ? ', ' + open + ' invariant' + (open === 1 ? '' : 's') + ' open' : ''));
  if (skipped) console.log('  The skipped checks need a toolchain this machine does not have. CI runs --no-skip after installing, so they are red there if they fail.');
  if (open) console.log('  The open invariants are stated above and held by nothing. Green means the checks passed, not that the software is finished.');
  return 0;
}

function cmdMatrix(fleet) {
  // Emitted for .github/workflows/agents.yml: one job per part, so adding a
  // part manifest adds a CI job and nothing else has to be touched.
  console.log(JSON.stringify({ part: fleet.parts.map((p) => p.name) }));
  return 0;
}

function usage() {
  console.log([
    'Peer two Peer — the build fleet',
    '',
    '  node agents/run.mjs --list [--json]      the fleet, and what each part owns',
    '  node agents/run.mjs --ownership [-v]     no file with two owners, no file with none',
    '  node agents/run.mjs --audit              every claim names a file and a test that exist',
    '  node agents/run.mjs --plan <part>        the brief an agent needs for that part',
    '  node agents/run.mjs <part> [--fail-fast] run one part\'s checks',
    '  node agents/run.mjs --gate [--fail-fast] run every part\'s checks, print the table',
    '  node agents/run.mjs --matrix             the CI job matrix, as JSON',
    '',
    '  --no-skip   a check whose toolchain is missing is a failure, not a skip.',
    '              CI passes it after installing, so a skip can never become permanent.',
    '',
    'Exit codes: 0 green, 1 a check, an ownership rule or a claim failed, 2 you',
    'asked for something that does not exist.',
  ].join('\n'));
  return 2;
}

function main() {
  let fleet;
  try {
    fleet = loadFleet();
  } catch (e) {
    console.error('the fleet manifest is broken: ' + (e && e.message ? e.message : e));
    console.error('Nothing else can be trusted until it parses. Fix agents/manifest.json or agents/parts/*.json.');
    return 2;
  }

  if (flag('--help') || flag('-h') || !argv.length) return usage();
  if (flag('--list')) return cmdList(fleet);
  if (flag('--ownership')) return cmdOwnership(fleet);
  if (flag('--audit')) return cmdAudit(fleet);
  if (flag('--matrix')) return cmdMatrix(fleet);
  if (flag('--plan')) {
    const name = after('--plan') || argv.find((a) => !a.startsWith('-'));
    if (!name) { console.error('--plan needs a part name'); return 2; }
    return cmdPlan(fleet, name);
  }
  if (flag('--gate')) return cmdGate(fleet);

  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) return usage();
  return cmdRunPart(fleet, name);
}

// Only run when invoked directly; the exported helpers above are imported by
// tests and by the ownership job, which should not trigger a build.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
