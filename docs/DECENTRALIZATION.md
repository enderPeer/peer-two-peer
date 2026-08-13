# Decentralisation: what is, what is not, and what is merely ahead

Three things move this network off the single machine it would otherwise be:

1. **The epoch chain** (`server/chain/`) — every closed epoch sealed into a
   signed, hash-linked block: the act range, the full economic state, the
   constant set, and the sha256 of the exact source editions that computed it.
2. **The IPFS pack** (`ops/ipfs-pack.mjs`) — the whole site (app, act log,
   epoch chain, media manifest) as one content-addressed archive anyone can
   pin, so the network stays readable *and verifiable* with every machine this
   project owns switched off.
3. **The writer election** (`server/chain/election.mjs`) — the writer is an
   office, not a machine: hosts elect it, liveness rotates it, any mirror can
   inherit it.

Honesty first, as everywhere in this repository: **writes still pass through
exactly one host at a time.** An elected, rotating office — but never
concurrent. That is not concealed by the word "chain"; it is the last row of
the table below.

**How to read this page.** Rows marked **ahead** are specified in
ARCHITECTURE.md and not yet standing up. They are marked rather than described
in the present tense, because a document that claims a property the code does
not have is the most expensive kind of wrong: somebody relies on it during an
outage. Every claim that *is* made here has a command beside it that checks it.

## The epoch chain

### What a block is

The epoch clock is the only clock here. Nothing advances until a `closeEpoch`
act lands in the log — replay never consults a clock, a network, or a random
source, so an epoch closes because an act arrived, never because time passed
while somebody was reading. At each close the writer seals:

```
{ v, net,                    — format and network id
  height, epoch, time,       — position; time is the closeEpoch act's own stamp
  prev,                      — hash of the previous block: the chain
  range: {start, end},       — the act indices this block covers
  acts[], actsRoot,          — structural hash per act + merkle root
  payloads[], payloadsRoot,  — payload commitment per act + merkle root
  tombstones[],              — pictures that settled in this epoch
  package, stateRoot,        — the epoch's full economic state, canonical
  oracle,                    — the EUR/BTC rate this epoch priced with
  constants,                 — fees, splits, the emission curve
  editions,                  — sha256 of core/replay.mjs and core/rules/<active>.mjs
  producer, sig }            — Ed25519: who published this, attributably
```

### What a block claims — and what it deliberately does not

A block claims exactly: *"at this close, the producer named here observed this
ordered act range, computed this state from it under these constants and these
formula editions, and signs that publication."*

It does **not** decide what is true. Replay decides; hashes only carry. A
verifier who disagrees with a block does not argue with its signature — they
replay the log and publish the discrepancy. The chain makes silent rewriting
**detectable** and publication **attributable**. That is all of it, and it is a
lot.

### Deletion does not break it

Deletion here is redaction: the payload bytes leave, the structure stays. A
chain that hashed whole acts would read every lawful deletion as tampering, so
each act is committed twice:

- the **structural hash** covers the act minus `cid` and `text` — invariant
  under every lawful deletion;
- the **payload hash** is sealed at close and simply *kept* afterwards: the
  retained commitment residue. It proves a picture existed and exactly which
  bytes it was, without the bytes.

A settled post therefore leaves on chain its author, cid, byte length,
dimensions, lifetime, view and viewer counts, likes, comments, gross euros, PTP
paid, and the block that sealed it. The picture is gone from every node, and
every earnings number for that epoch still reproduces — because deletion moves
no balance.

### No silent change

The block seals the fee splits, the emission curve, the rounding quantum, and
the sha256 of the two files that *are* the formulas. Edit a constant or edit
the rulebook and the next verification says so, per block, attributed as
edition drift. Numbers are committed under canonical JSON — sorted keys,
shortest round-trip decimals, non-finite values refused, inexact values rounded
to the published quantum (1e-9). Two verifiers either match bits or can
attribute the difference. There is no third outcome.

```bash
node server/chain/build.mjs      # seal every closed epoch (incremental, refuses forks)
node server/chain/verify.mjs     # replay everything; check every root and signature
```

The producer key lives beside the log it attests and is never served, never
synced, never exported — and never packed: `ops/ipfs-pack.mjs` skips anything
under `data/chain/` that looks like a key, because a snapshot carrying it would
hand every mirror the ability to sign blocks in the producer's name. It signs
epoch blocks and does only that. This codebase holds no wallet and no spendable
key.

## The IPFS pack

```bash
node ops/ipfs-pack.mjs
```

Writes `dist/ptp-site.car` and prints its root CID. It **publishes nothing by
itself** — pinning is the deliberate, separate step:

```bash
ipfs dag import dist/ptp-site.car && ipfs pin add <cid>
# or hand the .car to any pinning service
```

Then the whole network is at `https://<cid>.ipfs.<gateway>/` — the app, the
log, the chain, the media manifest. Prefer that subdomain form over
`<gateway>/ipfs/<cid>/`: it gives the app its own browser origin, so the shards
of other members' pictures it is holding are not in storage shared with every
other site on that gateway.

**The pack is deterministic**, and that is the property the whole layer rests
on. The import parameters are pinned to kubo's own defaults — CIDv1, sha2-256,
raw leaves, 256 KiB chunks, balanced DAG of width 174, directory links sorted
by UTF-8 byte order — so the same site bytes produce the same CID and the same
CAR bytes on any machine. A mirror operator can rebuild the pack from the
published site and *know* it is the same site before fetching a byte from
anyone:

```bash
node ops/ipfs-pack.mjs --dir <their copy> --no-car --check <cid>
```

The DAG-PB and UnixFS encoding is implemented in that one file from
`node:crypto` and arithmetic, with no dependencies, for a reason that is not
tidiness: this is the piece that has to keep working when every machine of ours
is gone, and a dependency tree is a set of other people's machines that have to
still exist for a rebuild to be possible.

The staged archive carries **no wall-clock timestamp**. It stamps itself with
the newest act's own `t`, so two people packing the same log on different days
produce the same bytes. A `Date.now()` in that file would quietly destroy the
only property it exists for.

### What a snapshot carries — read before the first pin

The act log is public by design. But **an IPFS pin is a ratchet**: content
under a CID that others pin cannot be recalled, ever, by anyone including its
author. Two things in this network's log deserve a conscious decision before
the first pin rather than after.

- **`view` acts are a reading history.** Every billable impression is an act:
  who looked, at whose picture, when, and for how long. It is signed by the
  viewer's own wallet key, so it is not merely public, it is *attributable* —
  and under a content address it is permanent. A network that bills per
  impression cannot avoid recording impressions, and this page will not pretend
  the meter is anonymous. It is not.
- **`comment` text is plaintext** in the log, and a comment redacted after
  settlement is redacted from *future* packs only. The pin that already exists
  keeps what it had.

There are no PIN hashes and no server-held secrets — every act is signed by a
wallet key, so this network never had that particular exposure to publish. What
it has instead is the meter, and the meter is the honest cost of pricing
attention in euros rather than selling it.

## The writer is an office, not a machine

One writer at a time is still the law: two simultaneous writers fork the log.
What is not fixed is *who* holds the pen and what happens when it drops. Hosts
rank each other by the longest sealed chain, then the longest log, then
liveness — every ranking field verifiable from data the candidate already
serves, so it is an election two honest observers cannot disagree about.

Four rules hold it up. Each one is a bug that was found and closed in the
predecessor rather than a principle stated up front, and each is carried here
because the failure it prevents is a property of the shape, not of that
codebase:

1. **Silence is not a mandate.** A host that has heard from no peer does not
   write. Quarantine lifts on a successful probe round, never on a failed one.
   Otherwise a watchdog restart *inside* a partition hands the isolated side a
   second pen — the exact split the feature exists to prevent. A genuinely
   last-host-standing is promoted deliberately by its operator, and says so
   while it waits.
2. **An incumbent yields only to a strictly longer record.** A seated writer
   keeps the pen against an equal; a host still in boot quarantine yields to
   any live writer whose record is at least as long. Conflating those two
   thresholds made two identical hosts demote into each other's mirrors — a
   network nobody could write to.
3. **Never follow someone who follows you.** A peer that reports it mirrors
   anyone is not a writer, and a host that finds itself set to mirror *itself*
   drops the role and re-decides. Without this, a restored-from-backup primary
   and its mirror seated each other forever.
4. **Claims are checked, not believed.** A peer's advertised numbers only start
   a handover. Before yielding, the host fetches the record and verifies what
   was actually delivered — length, shared prefix, sealed chain — with a byte
   ceiling on every fetch. Anyone can claim a million acts; nobody can produce
   them on demand. Addresses arriving in a fetched roster are untrusted input
   aimed at a `fetch()`: stripped to bare origins, and never pointed at private
   or loopback ranges.

**Boot quarantine.** The two-writer split always begins the same way — a
watchdog restarting a stale primary that then takes writes it should not. A
federated host starts read-only and asks the federation before its first act.

**Two signed histories freeze the host.** If a returning host and the winner
both sealed blocks the other does not have, nothing is adopted and nothing is
written: the host says so and waits for a person. Code does not choose between
two attributable records.

## What is and is not decentralised

| | state |
|---|---|
| the app | **decentralised.** Static files: any static host, any IPFS gateway, any laptop. `node ops/ipfs-pack.mjs` |
| the record | **decentralised.** Act log + chain + media manifest under one CID; integrity by hash, not by trust. Anyone can hold it, anyone can check it |
| the numbers | **decentralised.** Replay plus the chain's signed roots — checkable with every machine of ours off. `node server/chain/verify.mjs` |
| reads | **decentralised.** Mirrors, the published archive, IPFS. No single machine required |
| the name | **decentralised.** The CID is arithmetic, the IPNS name and the ptp1 label are hashes of a public key. A domain is a convenience with a registrar attached, and appears in exactly one row of MIRRORS.md |
| the pictures | **decentralised by design, ahead in practice.** Shards on members' devices, `REPLICATION`-way, rendezvous-placed (ARCHITECTURE §7). The placement rule is one shared file; the proof-and-payment loop is the newest part of this system and the least exercised |
| the money | **on-chain, not decentralised in the strong sense.** PTP is an ERC-20 with no owner and no mint beyond its distributor, and the pool has no admin — but the chain it sits on is somebody else's, and a bridged BTC asset has an issuer. `contracts/` and `ops/deploy.mjs` say which |
| the EUR/BTC oracle | **not decentralised.** A median of at least three public sources, signed by the epoch producer and sealed into the block. A host that showed a different rate for a closed epoch contradicts its own signature — which makes it *attributable*, not trustless |
| **writes** | **one writer at a time.** An elected, rotating office; a dead writer's pen passes to the best-placed mirror. Not concurrent, and a partition elects one writer per side until it heals |

### Ahead, named rather than smuggled

- **Fork healing by deterministic rebase.** The predecessor healed a partition
  by rebasing the losing tail onto the longer log (`merge.mjs`). This
  repository's layout (ARCHITECTURE §12) has `build`, `verify`, `election` and
  `keys` and no merge. Until that exists, a partition that wrote on both sides
  is resolved by a person choosing, and the losing tail is saved rather than
  applied.
- **Content-addressed act ids.** Acts are indexed by position (`i`), so
  references are position-based and a merge has to rewrite them. Ids derived
  from content would make acts location-independent from birth and shrink a
  merge to set union under canonical order. Not implemented.
- **HAMT directory sharding in the packer.** `ops/ipfs-pack.mjs` implements
  plain UnixFS directories. Past 256 KiB of encoded directory node, kubo shards
  into a HAMT and would mint a different CID — so the packer refuses and names
  the directory rather than publishing an address kubo disagrees with. At this
  site's shape the threshold is three orders of magnitude away.
- **The capacity market.** CAP, the storage receipt, is minted for proven
  MB·days and burned by posts that consume them. The challenge-response proof
  is real; whether its economics survive a determined free-rider is not
  something a document can settle, and this one does not claim it.

## Known limits, stated rather than hidden

- **A partition elects one writer per side until it heals.** That is the price
  of staying available, and it is CAP, not a bug. What is a gap is the healing
  (see above).
- **The producer key is a file on the writer.** Compromise of that machine is
  compromise of the signature going forward — not of the record, since replay
  still catches a rewrite, but of attribution.
- **`closeEpoch` is an act like any other.** The chain seals whatever the log
  says. Boundary policy is a calibration obligation, not a chain feature.
- **The rule key can change how the pot is divided.** It cannot mint, cannot
  move a balance, cannot touch the pool, cannot alter a sealed block, and takes
  effect for future epochs only — a closed epoch is never re-cut. It is still a
  privileged address, and it is the only one in `core/`.
- **The oracle is a single signature over a median.** Three sources agreeing is
  not the same as three sources being right.
- **Weight is linear in satoshis destroyed**, which is what makes puppets
  pointless — twenty accounts sharing a stake weigh exactly what one account
  holding it weighs. It does not make burning cheap for the honest, and it does
  not stop somebody rich from weighing a lot. It stops them from weighing more
  than they paid.
- **Determinism of the pack is asserted and checkable, not assumed.** It was
  verified against the reference UnixFS importer — same root CID, same block
  set, over a tree containing an empty file, a multi-chunk file and a file deep
  enough to need two DAG levels. Anyone can redo that comparison; nobody has to
  take this paragraph's word for it.
