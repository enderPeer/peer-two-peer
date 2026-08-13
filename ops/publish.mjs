// Assemble the published site: the app, the rulebook, the address book, and a
// verified copy of the record.
//
// The app is a static file and the record is a public log, so the whole network
// is publishable as a directory. What this produces is meant to be served from
// anywhere — GitHub Pages, any static host, any IPFS gateway — and to keep
// answering with every machine of ours switched off.
//
// THE SITE MIRRORS THE REPOSITORY, and that is not tidiness — it is the only
// layout in which the client's relative paths resolve the same way everywhere.
//
//   /index.html          a redirect to app/, so the bare address is not a 404
//   /app/                the app, verbatim
//   /core/*.mjs          the rulebook the browser runs. The SAME files the host
//                        runs — Rule 2 is a property of the bytes, so they are
//                        copied, never rebuilt or bundled.
//   /host.json           the address book: where to knock. The client fetches
//                        './host.json' and falls back to '../host.json', so it
//                        finds this one from inside app/.
//   /status.json         who answered last time anybody asked, and when.
//   /data/acts.jsonl     the record, where the client's '../data/acts.jsonl'
//   /data/chain/         fallback looks for it. Read-only, and only published
//                        once it carries something.
//
// FLATTENING THE APP TO THE ROOT WAS TRIED AND IS WRONG. app/app.mjs imports
// '../core/replay.mjs'. Served at the root of a user site that is fine, but
// GitHub Pages publishes a project at /<repo>/ — so '../core/replay.mjs' from
// /peer-two-peer/app.mjs resolves to /core/replay.mjs, one level ABOVE the
// project, and the client dies at its first import. Mirroring the repository
// makes the specifier resolve identically against a git clone, a Pages project
// site, a user site, an IPFS pin and a plain static server, because in every one
// of them app/ and core/ are siblings. A layout that works only at a root is a
// layout that works only where nobody deploys.
//
// An empty address in host.json is a real answer and not a failure: it sends the
// app straight to the archive instead of waiting out a timeout on a corpse. That
// is why `--host` is optional here and why the liveness job is allowed to write
// an empty one.
//
// This script publishes NOTHING by itself. It writes a directory. Pushing that
// directory to a branch, a pin or a gateway is a separate, deliberate step.

import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a flag out of argv. `--host https://x` or `--host=https://x`. */
function flag(name, fallback = null) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The address book.
 *
 * `url` is where the app should knock. `mirrors` is every address this file has
 * ever named, so a reader who holds an old copy can still find a live one — the
 * liveness job appends rather than replaces. `at` is when this was written, so a
 * stale book is visibly stale rather than quietly wrong.
 */
function addressBook(host, previous) {
  const seen = new Set(previous?.mirrors ?? []);
  if (previous?.url) seen.add(previous.url);
  if (host) seen.add(host);
  return {
    url: host ?? '',
    mirrors: [...seen].sort(),
    at: new Date().toISOString(),
    note: host
      ? 'A host is answering at `url`. Acts may be sent there.'
      : 'No host is answering. The app reads ./archive and runs read-only; that is the intended behaviour, not an outage.',
  };
}

async function main() {
  const out = flag('out', join(ROOT, 'site'));
  const host = flag('host');
  const dataDir = flag('data', join(ROOT, 'data'));

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // 1. The app, in app/ — a sibling of core/, exactly as in the repository.
  await cp(join(ROOT, 'app'), join(out, 'app'), { recursive: true });

  // A bare address should open the app rather than a 404 or a directory index.
  // A meta refresh rather than a script: it works with scripting disabled, and
  // it is the one file here that is not a copy of something.
  await writeFile(
    join(out, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '<meta charset="utf-8">',
      '<title>Peer two Peer</title>',
      '<meta http-equiv="refresh" content="0; url=app/">',
      '<link rel="canonical" href="app/">',
      '<body style="background:#fff;color:#000;font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1.5rem">',
      '<h1 style="font-size:1.25rem">Peer two Peer</h1>',
      '<p>A picture network where every impression is priced in euros.</p>',
      '<p><a href="app/" style="color:#000">Open the app</a></p>',
      '</body>',
      '</html>',
      '',
    ].join('\n')
  );

  // 2. The rulebook, byte for byte. Copied rather than bundled: a bundler would
  //    produce a file whose sha256 is not the EDITION any block sealed, and the
  //    whole point of serving it is that a reader can check what they were handed.
  await cp(join(ROOT, 'core'), join(out, 'core'), { recursive: true });

  // 3. The record, if this machine holds one — and only if it holds an actual
  //    one. A freshly started host has an acts.jsonl of zero bytes, and copying
  //    that would publish an `archive/` directory the client falls back INTO,
  //    finding nothing, instead of falling through to the live host. The
  //    existence of the file is not the question; whether it carries a record is.
  //
  //    A site with no archive is still a working site. It just has nothing to
  //    show until a host answers or the archive job publishes a verified copy.
  let archived = 0;
  const logPath = join(dataDir, 'acts.jsonl');
  if (await exists(logPath)) {
    archived = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).length;
  }
  if (archived > 0) {
    await mkdir(join(out, 'data'), { recursive: true });
    await cp(logPath, join(out, 'data', 'acts.jsonl'));
    if (await exists(join(dataDir, 'chain'))) {
      await cp(join(dataDir, 'chain'), join(out, 'data', 'chain'), {
        recursive: true,
        // The producer key sits beside the chain it signs. It is never served,
        // never synced and never exported — and "never" has to be enforced here,
        // where the copying happens, rather than asserted in a comment elsewhere.
        filter: (src) => !src.endsWith('.key') && !src.endsWith('.pem'),
      });
    }
    if (await exists(join(dataDir, 'chain.json'))) {
      await cp(join(dataDir, 'chain.json'), join(out, 'data', 'chain.json'));
    }
  }

  // 4. The address book, preserving every address it has ever named.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(flag('book', join(out, 'host.json')), 'utf8'));
  } catch {
    /* a first publication has no previous book, which is not an error */
  }
  const book = addressBook(host, previous);
  await writeFile(join(out, 'host.json'), JSON.stringify(book, null, 2) + '\n');
  await writeFile(
    join(out, 'status.json'),
    JSON.stringify({ ...book, acts: archived, writtenBy: 'ops/publish.mjs' }, null, 2) + '\n'
  );

  // 5. Pages serves this verbatim; Jekyll would otherwise eat anything starting
  //    with an underscore and rewrite what it feels like.
  await writeFile(join(out, '.nojekyll'), '');

  console.log('site   ' + out);
  console.log('app    app/ — a sibling of core/, so ../core resolves at any base path');
  console.log('core   the rulebook, byte for byte — the browser runs what the host runs');
  console.log('record ' + (archived ? archived + ' acts, with the sealed chain' : 'none on this machine'));
  console.log('host   ' + (book.url || '(empty — the app will read ./archive read-only)'));
  console.log('');
  console.log('This published nothing. Push it to a branch, pin it, or serve it — deliberately.');
}

main().catch((e) => {
  console.error('publish failed: ' + e.message);
  process.exit(1);
});
