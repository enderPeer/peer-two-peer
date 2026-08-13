# The name

Three names reach this network, and only one of them is a domain.

```bash
node ops/ipfs-pack.mjs        # -> the CID, and dist/ptp-site.car
node ops/domain/name.mjs      # -> the ptp1 label, the IPNS name, the DNSLink value
```

| | what it is | who can change it | who can take it |
|---|---|---|---|
| the **CID** | `bafybei…` — a hash of the site's bytes | nobody, ever | nobody |
| the **IPNS name** | `k51qzi…` — a pointer the producer key re-signs | the producer key | nobody, but it expires if nobody republishes |
| the **ptp1 label** | `ptp1…` — a hash of the genesis producer public key | nobody | nobody |
| a **domain** | `example.org` | you | a registrar, a court, a lapsed invoice |

The domain is the only row with an entry in the last column. That is the whole
reason the other three exist.

## Pointing a real domain at the network

1. **Publish the site.** `node ops/ipfs-pack.mjs` prints a root CID and writes
   `dist/ptp-site.car`. It publishes nothing by itself — pin the CAR on your own
   node, or hand it to a pinning service:

   ```bash
   ipfs dag import dist/ptp-site.car && ipfs pin add <cid>
   ```

   Until at least one node holds it, the CID is a correct address for content
   nobody is serving. That is not a broken address; it is an empty one, and the
   difference matters when you are debugging.

2. **Set the DNSLink record.** `ops/domain/dnslink.zone` is a ready-to-paste
   fragment with every line commented. The one line that does the work:

   ```
   _dnslink.example.org.  3600  IN  TXT  "dnslink=/ipfs/<cid>"
   ```

3. **Point the name at a gateway.** A browser speaks HTTP, not bitswap, so
   something has to translate. `www` gets a `CNAME` to a gateway that resolves
   DNSLink from the `Host` header. The apex cannot hold a `CNAME` — DNS forbids
   one beside the `SOA` — so use your provider's `ALIAS`/`ANAME` if it has one,
   or simply send people to `www`.

4. **Check it from a machine that is not yours.**

   ```bash
   dig +short TXT _dnslink.example.org @1.1.1.1
   curl -sI https://example.org/ | grep -i x-ipfs-path
   ```

   The second one is the real test: `x-ipfs-path` tells you the gateway
   resolved DNSLink rather than serving you its own landing page.

**The gateway is somebody else's machine.** It can go away, it can be slow, and
it can serve you bytes that are not the ones the CID names. That last one is
checkable and takes one command — see "verifying what a gateway handed you"
below. Nothing about a domain makes a gateway trustworthy; what makes the
network trustworthy is that you never have to trust one.

## Updating DNSLink when the CID changes

Every publication mints a new CID, because the CID *is* the bytes. So:

```bash
node ops/ipfs-pack.mjs                    # new CID printed, dist/site.cid written
ipfs dag import dist/ptp-site.car
ipfs pin add $(cat dist/site.cid)
node ops/domain/name.mjs                  # prints the exact TXT value to publish
# then edit the _dnslink TXT record at your registrar
```

Two things worth knowing before the first update:

- **Keep the old pin for a while.** DNS caches. For the length of the TTL —
  and longer, because some resolvers ignore it — readers will still be asking
  for the previous CID. Unpinning it the moment the record changes turns a
  cached lookup into a hang. An hour of TTL means at least an hour of overlap;
  a day is kinder.
- **A pin is a ratchet.** Content under a CID that other people have pinned
  cannot be recalled by anyone, including its author. Read the snapshot note in
  [`docs/DECENTRALIZATION.md`](../../docs/DECENTRALIZATION.md) before the first
  pin, not after.

If you would rather not edit DNS at every publication, publish the `/ipns/`
form once and republish the IPNS record instead:

```bash
ipfs key import ptp producer.key          # the genesis producer key, once
ipfs name publish --key=ptp /ipfs/$(cat dist/site.cid)
```

That moves the update from your registrar to your key, which is a real
improvement in one direction and a real cost in another: the key holder can now
change what the domain serves without touching DNS, and an IPNS record that
stops being republished expires, leaving the name quiet while the CID
underneath is still perfectly reachable.

## Reaching the network with no domain at all

None of this needs a domain, and the network was designed so that losing one
changes nothing.

**By CID — the address that cannot lie.**

```
https://<cid>.ipfs.dweb.link/          preferred: its own origin
https://<gateway>/ipfs/<cid>/
ipfs get <cid>                          no gateway at all
```

Prefer the subdomain form. It gives the app its own browser origin, so its
storage — the shards of other members' pictures it is holding, per
ARCHITECTURE §7 — is not shared with every other site on that gateway.

**By IPNS — the address that follows the network.**

```
https://<ipns-name>.ipns.dweb.link/
https://<gateway>/ipns/<ipns-name>/
```

**By ptp1 label — the name that identifies the network.**

```
ptp1<32 base32 characters>
```

This one resolves nowhere, and that is not a defect. It is how two people
establish they are talking about the *same* network without asking anyone: both
of them recompute it from the genesis producer public key, which every epoch
block already carries in its `producer` field.

```
label = "ptp1" + base32( sha256( "ptp:name:v1" || producer_pubkey )[0..20] )
```

Twenty bytes of a domain-separated sha256, RFC 4648 base32, lower case, no
padding. There is no checksum, deliberately: the check is recomputation from
the key. A label that verified against itself would let someone accept a name
without ever meeting the key it is supposedly a name for, which is the exact
shortcut this design refuses.

**With everything down.** A copy of the CAR is the whole network — app, act
log, epoch chain, media manifest. `docs/MIRRORS.md` lists where copies live and
how to serve one from a laptop.

### Verifying what a gateway handed you

A gateway can serve anything. You do not have to take its word:

```bash
ipfs get <cid> -o site                  # or download from any gateway
node ops/ipfs-pack.mjs --dir site --no-car --check <cid>
```

`MATCH` means the directory you are holding is byte-for-byte the site that CID
names. The pack is pinned to kubo's own defaults — CIDv1, raw leaves, 256 KiB
chunks, width-174 balanced DAG — so the rebuild is arithmetic and the answer
does not depend on who computed it.

That check says nothing about whether the *numbers* are right. It says the
bytes are the ones the address names. For the numbers, replay the log
(`core/replay.mjs`) and verify the epoch chain's signed roots
(`server/chain/verify.mjs`). Two different questions, two different tools, and
conflating them is how a content address gets mistaken for an authority.

## Why the name is not the network

A domain is a lease. Registrars suspend them, courts order them transferred,
invoices lapse, and a nameserver you do not run can answer differently for
different people on the same day. Any system whose reachability depends on one
is a system with a switch somewhere it does not control.

So the domain here is a convenience and nothing more. Underneath it:

- the **CID** is arithmetic over the bytes. It was not issued, cannot be
  revoked, and anyone can recompute it — from a laptop, offline, in one
  command. Nobody grants you the right to use it and nobody can take it away,
  because there is nothing to take: it is a number that is true.
- the **IPNS name** is a hash of a public key. Only the holder of that key can
  move it, and there is no registry to appeal to, seize, or bribe.
- the **ptp1 label** is a hash of the genesis producer's public key, and is
  what this network calls itself. It has no registrar because there is nothing
  to register.

The consequence to say out loud: **none of these can be taken from us, and none
of them can be taken from an impostor either.** Anyone may derive a ptp1 label
from a key they made up this morning; anyone may pin a modified copy of the
site under its own perfectly valid CID. The names carry no authority at all.
What tells the two apart is the record — replay the act log, check the epoch
chain's signatures against the producer key the label is derived from, and the
imitation fails arithmetic rather than losing an argument.

That is the trade this whole layer makes: give up the ability to stop
impostors by decree, in exchange for a network nobody can switch off. The names
are not the network. The record is, and the record is checkable by anyone
holding a copy.
