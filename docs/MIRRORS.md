# Mirrors: where this network lives when any one host disappears

The record is an append-only log, the numbers are a replayable formula, and the
app is a static file. So the whole thing can be copied without permission and
verified without trust. This page lists every place a copy can live, how to
reach one when another is down, and how to become a mirror yourself. No copy
below requires an account to read, and none of the decentralised ones requires
an account to publish.

**Read this first, because it is the difference between this page and the one
it is modelled on.** The predecessor's `MIRRORS.md` lists live addresses that
were audited on a stated date. This network has not been published yet, so the
addresses below are `<placeholders>` and are marked as such. A placeholder is
an honest empty slot. An invented CID or a repository URL that resolves to
nothing would be worse than no page at all — somebody would try it during an
outage, which is the one moment this file has to be true. Fill each row in when
it is real, and put the date you checked it beside the table.

**One writer at a time — but the writer is an elected office.** Of every copy
below, exactly one accepts new acts: the seated writer. The static copies
(Pages, IPFS, bundles) have no write door at all, and live mirrors refuse
writes while naming the current writer. That is the design, not a gap — two
simultaneous writers fork the log. What is *not* fixed is which machine holds
the pen: hosts elect it by longest sealed chain, then longest log, then
liveness, and any mirror is in the line of succession. Every copy can check the
record it holds without asking anyone: replay the log and you recompute every
balance, feed and pool reserve, then check the epoch chain's signed roots.
See [DECENTRALIZATION.md](DECENTRALIZATION.md).

**Is anybody home right now?** `status.json` sits beside the app and is
rewritten every fifteen minutes by a scheduled job on machines this project
does not own, so it keeps answering when everything of ours is off. It names
which hosts answered, which one holds the pen, and how long its record is. When
nothing answers it points the app at the published archive on purpose: a
working read-only network beats waiting on a dead address.

## The copies

| channel | address | what it is |
|---|---|---|
| Web (canonical) | `<https://…>` | app + published archive + chain |
| Git | `<https://github.com/…>` | source of everything |
| Radicle | `<rad:…>` | the repo on a peer-to-peer network — replicated by public seed nodes and by everyone who clones it |
| IPFS | `<bafybei…>` | the whole site (app, act log, chain, media manifest) under one content address |
| nsite (Nostr) | `<npub…>` | the site as signed Nostr events plus hash-addressed blobs |
| Software Heritage | `<https://archive.softwareheritage.org/browse/origin/?origin_url=…>` | permanent academic archive of the git history |
| Snapshot release | `<https://…/releases>` | one-file `git bundle` + IPFS `.car` + torrent (magnet in the release notes) |
| Derived name | `ptp1…` — `node ops/domain/name.mjs` | not an address: the name the network computes for itself from the genesis producer key |

Seven channels is not seven backups of the same thing. Each fails differently:
a company can delete a repository, a registrar can suspend a domain, a seed
node can go quiet, a torrent can lose its last seeder. What they have in common
is that none of them can quietly alter a copy — every identifier in that table
is either a hash of the content or bound to a keypair.

### Reaching each one

**IPFS** — from any gateway, once at least one node pins it:

```
https://<cid>.ipfs.dweb.link/          preferred: its own browser origin
https://<gateway>/ipfs/<cid>/
ipfs get <cid>                          no gateway involved at all
```

Prefer the subdomain form: it gives the app its own origin, so the shards of
other members' pictures it is holding are not in storage shared with every
other site on that gateway.

The CID is **deterministic**. Rebuild the pack from any copy of the site and
you must get the same address:

```bash
node ops/ipfs-pack.mjs --dir <your copy of the site> --no-car --check <cid>
```

`MATCH` means the bytes are the ones that address names — checked by
arithmetic, on your machine, before you trust a single gateway. It is not a
statement that the numbers inside are correct; that is replay's job, below.

**Radicle** — with Radicle installed, or with plain git and no Radicle at all:

```bash
rad clone <rad:…>
git clone https://seed.radicle.xyz/<rid>.git
```

**nsite** — the site published as signed Nostr events with sha256-addressed
blobs. The npub works on any nsite gateway, so the address survives any single
gateway's death, and anyone can re-upload the blobs to more Blossom servers and
the site heals — same hash, same address.

**Software Heritage** — anyone can trigger an archive of a public git origin,
no account, at <https://archive.softwareheritage.org/save/>. Do that once the
repository is public; it costs nothing and it outlives the host.

**Snapshot** — download the bundle from the release, then:

```bash
git clone peer-two-peer.bundle peer-two-peer
```

That is the entire project — code, app, archive, history — from one file,
offline.

## Becoming a mirror

Any one of these makes the network harder to lose. Pick by effort.

- **One command, one-off** — pin the site on IPFS:

  ```bash
  ipfs dag import ptp-site.car && ipfs pin add <cid>
  ```

  The `.car` is in the release, or rebuild it yourself with
  `node ops/ipfs-pack.mjs`. While your node runs, you are a host.

- **One command, ongoing** — seed the repository on Radicle:
  `rad seed <rad:…>` (cloning already seeds by default).

- **Any torrent client** — keep the release torrent seeding. The download URL
  from the release doubles as a webseed, so the torrent stays alive even with
  no human seeds for as long as that host lives.

- **A device that is already on** — run the client and grant it storage. The
  app asks for persistent storage and keeps shards of other members' pictures
  in the Origin Private File System (ARCHITECTURE §7). A member who grants 5 GB
  is a storage node, gets paid out of the capacity pot for proven MB·days, and
  did not have to run a server to do it. This is the mirror tier most people
  will actually use.

- **A machine that stays on** — run a live mirror of the act log:

  ```bash
  git clone <repo> && cd peer-two-peer
  npm install                  # ethers, and nothing else
  npm start
  ```

  A mirror serves readers when the writer is down and holds a complete,
  verified copy of the log and the chain. It is also in the line of succession:
  if the writer dies, the election seats the best-placed mirror. Running a
  mirror IS hosting the network.

## If everything above is down

Any surviving copy — a git clone, the bundle, a pinned CAR, one mirror's
`data/` directory — contains the complete network. Recovery, in order:

**1. Get the code and the record.** Any channel above; a `.car` alone is
enough, because it contains both.

```bash
ipfs dag import ptp-site.car        # or: unpack any copy you have
ipfs get <cid> -o site
```

**2. Check that what you are holding is what it claims to be.** Two separate
questions, two commands, and they answer different things.

```bash
# Are these the bytes that CID names? (arithmetic, no host, no network)
node ops/ipfs-pack.mjs --dir site --no-car --check <cid>

# Are the numbers in the record right? (replay + every signed root)
node server/chain/verify.mjs --acts site/archive/acts.jsonl \
                             --chain site/archive/chain/blocks.jsonl
```

The first says nobody swapped the file. The second says the balances, pool
reserves and epoch distributions in it reproduce from the act log under the
rulebook the blocks name. Neither one asks any host for permission, and a
record that fails the second is a record to publish the discrepancy about, not
to quietly repair.

**3. Serve it to readers.** Any static server will do; the app is files.

```bash
python3 -m http.server 8080 --directory site
# or
npx --yes serve site
```

Readers now have the whole network, read-only: every picture's metadata, every
balance, every sealed block. That is already most of what a network is.

**4. Bring a writer back for participants.** Start a host over the recovered
log, and let the election seat it:

```bash
npm start
node server/chain/verify.mjs     # verify before you write, always
```

A host that starts in a partition does not seat itself: silence is not a
mandate. If it is genuinely the last machine standing, promote it deliberately
rather than letting a watchdog do it — see [DECENTRALIZATION.md](DECENTRALIZATION.md).

## About the identifiers in this file

Every one of them is reproducible or keypair-bound, which is why this page can
be written before the addresses exist without being a promise:

- the **IPFS CID** can be rebuilt and checked by anyone from the site bytes —
  one command, no network;
- the **Radicle RID** and the **nsite npub** belong to their keys, so updates
  published under those names are signed;
- the **ptp1 label** is a hash of the genesis producer public key, derivable by
  anyone holding a single epoch block (`node ops/domain/name.mjs`);
- the **Software Heritage** archive can be re-triggered by anyone, no account.

The domain is the exception. It is a lease, it appears in exactly one row, and
everything else here exists so that losing it costs nothing.
