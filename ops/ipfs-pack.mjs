#!/usr/bin/env node
// Pack the whole network into one content-addressed file.
//
//   node ops/ipfs-pack.mjs                     # stage the site, pack dist/ptp-site.car
//   node ops/ipfs-pack.mjs --dir D --out F     # pack any folder as it stands
//   node ops/ipfs-pack.mjs --dir D --no-car    # compute the root CID only
//   node ops/ipfs-pack.mjs --dir D --check CID # rebuild and compare against a published CID
//
// The site is the app, the act log, the epoch chain and the media manifest.
// Packed into a CAR (Content ARchive) it is one file with one root CID: import
// it into any IPFS node and the network is served; pin it anywhere and it
// outlives every machine this project owns.
//
// THIS PUBLISHES NOTHING. It writes a local file and prints the address that
// file will have once somebody pins it. Pinning is a separate, deliberate step,
// because an IPFS publish is a ratchet — content under a CID that others pin
// cannot be recalled, ever, by anyone including its author.
//
// ── Why the CID is reproducible, and why that is the whole point ────────────
// The import parameters are pinned to kubo's own defaults: CIDv1, sha2-256,
// raw leaves, fixed 256 KiB chunks, balanced DAG of width 174, UnixFS
// directories with links sorted by name. Same bytes in, same CID out, on any
// machine, with any implementation that follows those defaults. A mirror
// operator can therefore rebuild the pack from the published site and KNOW it
// is the same site before fetching a byte from anyone — `--check` is that
// comparison, one command.
//
// A content address is arithmetic over bytes. It is not a claim that the bytes
// are correct, and this tool makes no such claim: correctness is replay's job
// (`core/replay.mjs`) and attribution is the epoch chain's. The CID only makes
// substitution detectable.
//
// ── Why the encoding is written out here rather than imported ───────────────
// House rule: zero new dependencies. The real reason is longer. This file is
// the piece that has to keep working when every machine of ours is gone, and a
// dependency tree is a set of other people's machines that have to still exist
// for the pack to be rebuildable. DAG-PB is four protobuf fields and UnixFS is
// eight; both are implemented below in full, from node:crypto and arithmetic,
// so the rebuild instruction in docs/MIRRORS.md needs nothing but Node.
//
// ── Known limit, stated rather than discovered later ────────────────────────
// Directory sharding (HAMT) is NOT implemented. kubo converts a directory to a
// HAMT once its encoded node exceeds 256 KiB, and such a directory would get a
// different CID here. Rather than mint a CID that kubo disagrees with, this
// tool refuses and says which directory did it. At this site's shape — a
// handful of files per directory — the threshold is three orders of magnitude
// away, which is why the simple case is the one implemented.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// kubo's defaults, restated as constants so a reader can check them against
// `ipfs add --help` rather than take the header comment on trust.
export const CHUNK_SIZE = 262144;      // 256 KiB, the fixed-size chunker
export const DAG_WIDTH = 174;          // max children per node, balanced layout
export const SHARD_THRESHOLD = 262144; // directory size at which kubo switches to a HAMT

const CODEC_RAW = 0x55;                // multicodec: raw bytes (a leaf)
const CODEC_DAGPB = 0x70;              // multicodec: dag-pb (a file or directory node)
const HASH_SHA2_256 = 0x12;            // multihash code

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');

// ── bytes ───────────────────────────────────────────────────────────────────

const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Unsigned LEB128, the varint every one of these formats is built from.
 *
 * Written with division rather than bit shifts on purpose: JavaScript's
 * bitwise operators truncate to 32 bits, and file sizes, cumulative DAG sizes
 * and CAR frame lengths all pass 4 GiB in ordinary use. Integers up to 2^53
 * encode correctly here; anything larger is refused rather than silently
 * mangled, because a mangled length in a CAR is a file nobody can read back.
 */
export function varint(value) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`varint: ${value} is not a safe non-negative integer`);
  }
  const out = [];
  let n = value;
  while (n >= 0x80) { out.push((n % 128) + 128); n = Math.floor(n / 128); }
  out.push(n);
  return Uint8Array.from(out);
}

/** sha2-256 over bytes, returned raw. The one hash this whole file uses. */
export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/**
 * RFC 4648 base32, lower case, no padding — multibase 'b', which is what an
 * IPFS CIDv1 prints as. Written by hand because node:buffer has no base32 and
 * a CID that cannot be printed is a CID nobody can paste into a gateway.
 *
 * The accumulator is masked after every emitted symbol; without that mask the
 * running value keeps its consumed high bits and overflows 32 bits somewhere
 * around the fifth byte, which produces a plausible-looking wrong address.
 */
export function base32Encode(bytes) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

// ── protobuf, the two messages that matter ──────────────────────────────────

// A length-delimited field: tag, length, bytes.
function pbBytes(field, bytes) {
  return concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}

// A varint field: tag, value.
function pbUint(field, value) {
  return concat([varint(field * 8), varint(value)]);
}

/**
 * The UnixFS `Data` message for a file node: Type=File(2), the total size of
 * the file this subtree covers, and one `blocksizes` entry per child giving
 * the number of FILE bytes that child contributes.
 *
 * `blocksizes` is what lets a reader seek: it can pick the right child for an
 * offset without fetching any of them. It is the file's own byte count per
 * child, not the child's block size — the two differ for every interior node,
 * and confusing them yields a DAG that reads back as the wrong length.
 */
export function unixfsFileData(fileSize, blockSizes) {
  const parts = [pbUint(1, 2), pbUint(3, fileSize)];
  for (const b of blockSizes) parts.push(pbUint(4, b));
  return concat(parts);
}

/**
 * The UnixFS `Data` message for a directory: Type=Directory(1) and nothing
 * else. No filesize, no mode, no mtime — kubo writes none of them without
 * being asked, and writing them would change the CID away from what
 * `ipfs add -r` mints for the same bytes.
 */
export function unixfsDirectoryData() {
  return pbUint(1, 1);
}

/**
 * Encode a DAG-PB node: links first, then Data.
 *
 * That order is not a style choice. DAG-PB is a protobuf whose canonical form
 * fixes field order — Links (field 2) before Data (field 1), and inside each
 * link Hash (1), Name (2), Tsize (3). Emit them in numeric order instead and
 * every hash differs from the rest of the world's for identical content.
 *
 * `name` is written even when it is the empty string, because a file's child
 * links carry an explicitly-present empty name in both go-ipfs and js-ipfs;
 * omitting the two bytes changes the hash. Pass `null` to leave it out.
 */
export function dagPbNode(links, data) {
  const parts = [];
  for (const link of links) {
    const fields = [pbBytes(1, link.cid)];
    if (link.name != null) fields.push(pbBytes(2, utf8(link.name)));
    if (link.tsize != null) fields.push(pbUint(3, link.tsize));
    parts.push(pbBytes(2, concat(fields)));
  }
  if (data && data.length) parts.push(pbBytes(1, data));
  return concat(parts);
}

/** A CIDv1: version, codec, then a sha2-256 multihash of the block. */
export function cidV1(codec, digest) {
  return concat([varint(1), varint(codec), varint(HASH_SHA2_256), varint(digest.length), digest]);
}

/** A CID as text: multibase 'b' plus lower-case base32, the CIDv1 default. */
export function cidToString(cid) {
  return 'b' + base32Encode(cid);
}

// ── the block sink ──────────────────────────────────────────────────────────

// Blocks are collected as (cid → source) rather than (cid → bytes). Leaves
// stay on disk and are re-read at write time; only interior nodes, which are a
// few hundred bytes each, are held in memory. A site with a gigabyte of media
// therefore packs in a few megabytes of RSS, and the CAR is still written in
// one deterministic pass.
class BlockSink {
  constructor() { this.blocks = new Map(); }

  inline(cid, bytes) {
    const key = cidToString(cid);
    if (!this.blocks.has(key)) this.blocks.set(key, { cid, key, size: bytes.length, bytes });
    return cid;
  }

  fromFile(cid, disk, offset, length) {
    const key = cidToString(cid);
    if (!this.blocks.has(key)) this.blocks.set(key, { cid, key, size: length, ref: { disk, offset, length } });
    return cid;
  }
}

// Read exactly `length` bytes at `offset`. readSync is allowed to return short
// reads, so this loops; a short read that went unnoticed would hash a
// truncated chunk and mint an address for content that does not exist.
function readExact(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) throw new Error('unexpected end of file while chunking');
    got += n;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, length);
}

/**
 * Import one file: chunk it at 256 KiB, hash each chunk as a raw leaf, then
 * fold the leaves into a balanced DAG of width 174.
 *
 * A file of one chunk or less IS its leaf — no wrapping file node is created.
 * That is kubo's `--raw-leaves` behaviour (`reduceSingleLeafToSelf`), and it
 * is why a small file added here and the same file added by `ipfs add` share
 * an address. An empty file is one empty raw leaf, not zero leaves.
 *
 * Returns the root of the file's DAG together with `tsize`, the cumulative
 * number of stored bytes underneath it, which is what the parent link records.
 */
export function importFile(diskPath, size, sink) {
  const leaves = [];
  const fd = openSync(diskPath, 'r');
  try {
    if (size === 0) {
      const bytes = new Uint8Array(0);
      const cid = cidV1(CODEC_RAW, sha256(bytes));
      sink.inline(cid, bytes);
      leaves.push({ cid, tsize: 0, fileSize: 0 });
    }
    for (let off = 0; off < size; off += CHUNK_SIZE) {
      const n = Math.min(CHUNK_SIZE, size - off);
      const bytes = readExact(fd, off, n);
      const cid = cidV1(CODEC_RAW, sha256(bytes));
      sink.fromFile(cid, diskPath, off, n);
      leaves.push({ cid, tsize: n, fileSize: n });
    }
  } finally {
    closeSync(fd);
  }
  return balance(leaves, sink);
}

// One interior file node over a run of children.
function fileParent(children, sink) {
  let fileSize = 0;
  let tsize = 0;
  const blockSizes = [];
  for (const c of children) { fileSize += c.fileSize; tsize += c.tsize; blockSizes.push(c.fileSize); }
  const bytes = dagPbNode(
    children.map((c) => ({ name: '', cid: c.cid, tsize: c.tsize })),
    unixfsFileData(fileSize, blockSizes),
  );
  const cid = cidV1(CODEC_DAGPB, sha256(bytes));
  sink.inline(cid, bytes);
  return { cid, tsize: tsize + bytes.length, fileSize };
}

/**
 * The balanced layout: fill left to right, 174 children per node, and repeat
 * over the resulting nodes until one remains.
 *
 * This reproduces both go-ipfs's depth-growing builder and js-ipfs's
 * batch-and-recurse builder — they describe the same tree from opposite ends,
 * and the fixed width is what makes them agree. A run of one child at the end
 * of a level still gets its own parent; skipping that "pointless" wrapper
 * would shorten the tree and change the root address.
 */
export function balance(leaves, sink) {
  if (leaves.length === 0) throw new Error('balance: nothing to fold');
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += DAG_WIDTH) {
      next.push(fileParent(level.slice(i, i + DAG_WIDTH), sink));
    }
    level = next;
  }
  return level[0];
}

// Directory links are sorted by name as raw UTF-8 bytes. go-ipfs sorts byte
// wise and JavaScript's `<` compares UTF-16 code units; the two disagree above
// the BMP, so the byte comparison is the one to copy.
function byName(a, b) {
  return Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'));
}

/**
 * Import a directory node: every child file and subdirectory, links sorted by
 * name, wrapped in a UnixFS directory.
 *
 * Refuses rather than guesses when the encoded node passes kubo's sharding
 * threshold — see the header. A wrong CID that looks right is worse than an
 * error, because it is only discovered by the mirror operator who trusted it.
 */
export function importDirectory(node, sink, path = '') {
  const links = [];
  for (const [name, file] of node.files) {
    const r = importFile(file.disk, file.size, sink);
    links.push({ name, cid: r.cid, tsize: r.tsize });
  }
  for (const [name, sub] of node.dirs) {
    const r = importDirectory(sub, sink, path ? `${path}/${name}` : name);
    links.push({ name, cid: r.cid, tsize: r.tsize });
  }
  links.sort(byName);
  const bytes = dagPbNode(links, unixfsDirectoryData());
  if (bytes.length > SHARD_THRESHOLD) {
    throw new Error(
      `directory "${path || '/'}" encodes to ${bytes.length} bytes, past kubo's ${SHARD_THRESHOLD}-byte ` +
      'sharding threshold. This packer does not implement HAMT directories, and minting a CID kubo ' +
      'would disagree with is worse than refusing. Split the directory.',
    );
  }
  const cid = cidV1(CODEC_DAGPB, sha256(bytes));
  sink.inline(cid, bytes);
  let tsize = bytes.length;
  for (const l of links) tsize += l.tsize;
  return { cid, tsize };
}

/** Group a flat list of `{ path, disk, size }` into the directory tree it implies. */
export function buildTree(files) {
  const root = { dirs: new Map(), files: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: new Map() });
      node = node.dirs.get(parts[i]);
    }
    node.files.set(parts[parts.length - 1], f);
  }
  return root;
}

/** Walk a directory into a sorted, flat file list with site-relative slash paths. */
export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else if (st.isFile()) out.push({ path: relative(base, p).split(sep).join('/'), disk: p, size: st.size });
  }
  return out;
}

/**
 * Pack a directory into blocks and return the root CID. Does no I/O beyond
 * reading the files: the caller decides whether a CAR is written at all, which
 * is what makes `--no-car` and `--check` free.
 */
export function packDirectory(srcDir) {
  const files = walk(srcDir);
  if (files.length === 0) throw new Error(`nothing to pack in ${srcDir}`);
  const sink = new BlockSink();
  const root = importDirectory(buildTree(files), sink);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  return { root: root.cid, cid: cidToString(root.cid), files, totalBytes, blocks: sink.blocks };
}

// ── CAR v1 ──────────────────────────────────────────────────────────────────

// CBOR byte-string header, the only length case this file needs beyond tiny.
function cborBytesHeader(n) {
  if (n < 24) return Uint8Array.from([0x40 + n]);
  if (n < 256) return Uint8Array.from([0x58, n]);
  return Uint8Array.from([0x59, (n >> 8) & 0xff, n & 0xff]);
}

/**
 * The CARv1 header frame: a varint length followed by the DAG-CBOR encoding of
 * `{ roots: [<cid>], version: 1 }`.
 *
 * Written as literal CBOR because the map has two known keys and one known
 * shape. DAG-CBOR orders map keys by length then bytes, so "roots" precedes
 * "version"; a CID is tag 42 over a byte string with a leading 0x00 multibase
 * identity prefix. Those three rules are the entire format.
 */
export function carHeader(rootCid) {
  const body = concat([
    Uint8Array.from([0xa2]),                       // map, 2 pairs
    Uint8Array.from([0x65]), utf8('roots'),        // "roots"
    Uint8Array.from([0x81, 0xd8, 0x2a]),           // [ tag(42)
    cborBytesHeader(rootCid.length + 1),
    Uint8Array.from([0x00]), rootCid,              //   0x00 || cid ]
    Uint8Array.from([0x67]), utf8('version'),      // "version"
    Uint8Array.from([0x01]),                       // 1
  ]);
  return concat([varint(body.length), body]);
}

/**
 * Write the CAR: header, then every block as varint(len(cid)+len(bytes)),
 * the CID, the bytes.
 *
 * Blocks are emitted in CID order and deduplicated. Block order is not part of
 * the root CID — any order reads back identically — but sorting makes the .car
 * itself byte-identical run to run, which turns the archive into something a
 * release page can publish a sha256 for.
 */
export async function writeCar(outPath, rootCid, blocks) {
  mkdirSync(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);
  const write = async (chunk) => { if (!out.write(chunk)) await once(out, 'drain'); };
  await write(carHeader(rootCid));

  const ordered = [...blocks.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const fds = new Map();
  let payload = 0;
  try {
    for (const b of ordered) {
      let bytes = b.bytes;
      if (!bytes) {
        if (!fds.has(b.ref.disk)) fds.set(b.ref.disk, openSync(b.ref.disk, 'r'));
        bytes = readExact(fds.get(b.ref.disk), b.ref.offset, b.ref.length);
      }
      await write(varint(b.cid.length + bytes.length));
      await write(b.cid);
      await write(bytes);
      payload += bytes.length;
    }
  } finally {
    for (const fd of fds.values()) closeSync(fd);
  }
  out.end();
  await once(out, 'close');
  return { count: ordered.length, payload };
}

// ── staging: what "the site" is ─────────────────────────────────────────────

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const s = join(src, name);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, join(dst, name));
    else if (st.isFile()) copyFileSync(s, join(dst, name));
  }
}

function readJsonl(file) {
  const rows = [];
  const bad = [];
  const text = readFileSync(file, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    n++;
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { bad.push(n); }
  }
  return { rows, bad };
}

/**
 * The media manifest: every picture the log claims, by content address.
 *
 * This is a SHALLOW read of the act log — it reports what `post` acts assert,
 * not what replay concluded. It deliberately does not import `core/replay.mjs`:
 * the manifest's job is to tell a mirror which blobs exist and how big they
 * are, and a mirror that had to run the rulebook to learn that would be a
 * mirror that cannot start until the rulebook loads. Which posts have settled
 * and had their payload redacted is a replay question, and the manifest says
 * so rather than answering it wrongly.
 */
export function mediaManifest(acts) {
  const media = new Map();
  let settles = 0;
  for (const a of acts) {
    if (!a || typeof a !== 'object') continue;
    if (a.k === 'post' && typeof a.cid === 'string') {
      if (!media.has(a.cid)) {
        media.set(a.cid, {
          cid: a.cid,
          bytes: Number(a.bytes) || 0,
          mime: typeof a.mime === 'string' ? a.mime : '',
          w: Number(a.w) || 0,
          h: Number(a.h) || 0,
          by: typeof a.as === 'string' ? a.as : '',
          act: Number(a.i) || 0,
        });
      }
    } else if (a.k === 'settle') {
      settles++;
    }
  }
  const items = [...media.values()].sort((x, y) => (x.cid < y.cid ? -1 : x.cid > y.cid ? 1 : 0));
  return {
    count: items.length,
    totalBytes: items.reduce((s, m) => s + m.bytes, 0),
    settleActs: settles,
    note:
      'Every picture the act log claims, by content address. Shallow read of the log, not a replay: ' +
      'whether a post has settled and had its payload redacted is a question for core/replay.mjs, and ' +
      'the count of settle acts here is a hint, not an answer. The bytes themselves live on members\' ' +
      'devices, REPLICATION-way, rendezvous-placed — this file is the index, not the shards.',
    media: items,
  };
}

/**
 * Assemble the site into a staging directory: the app, the act log, the epoch
 * chain, the media manifest, and the address book if one has been published.
 *
 * Every part is optional and a missing part is reported rather than fatal — a
 * fresh checkout with no log yet should still be able to pack the app, and an
 * operator who packs a partial site deserves to be told which part is partial.
 *
 * The archive manifest carries NO wall-clock time. It stamps itself with the
 * last act's own timestamp instead, so two people staging the same log on
 * different days produce the same bytes and therefore the same CID. A
 * `Date.now()` in this file would quietly break the one property the whole
 * tool exists for.
 */
export function stageSite(stageDir, opts = {}) {
  const appDir = opts.appDir || process.env.PTP_APP_DIR || join(REPO, 'app');
  const dataDir = opts.dataDir || process.env.PTP_DATA_DIR || join(REPO, 'data');
  const notes = [];

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  if (existsSync(appDir)) copyTree(appDir, stageDir);
  else notes.push(`no app at ${appDir} — packing without the client`);

  const archive = join(stageDir, 'archive');
  mkdirSync(archive, { recursive: true });

  const actsSrc = join(dataDir, 'acts.jsonl');
  let actCount = 0;
  let actsSha = '';
  let stamp = 0;
  let manifestMedia = mediaManifest([]);
  if (existsSync(actsSrc)) {
    copyFileSync(actsSrc, join(archive, 'acts.jsonl'));
    const { rows, bad } = readJsonl(actsSrc);
    actCount = rows.length;
    actsSha = createHash('sha256').update(readFileSync(actsSrc)).digest('hex');
    for (const a of rows) if (Number.isFinite(a?.t)) stamp = Math.max(stamp, a.t);
    if (bad.length) notes.push(`${bad.length} unparsable line(s) in acts.jsonl (first at ${bad[0]}) — packed verbatim anyway`);
    manifestMedia = mediaManifest(rows);
  } else {
    notes.push(`no act log at ${actsSrc} — packing without the record`);
  }

  const chainSrc = join(dataDir, 'chain');
  let chainHead = null;
  if (existsSync(chainSrc)) {
    const dst = join(archive, 'chain');
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(chainSrc).sort()) {
      // The producer key lives beside the chain it signs and is never packed,
      // never served, never exported. A snapshot that carried it would hand
      // every mirror the ability to sign blocks in the producer's name.
      if (!/\.(jsonl|json)$/.test(name) || /key|\.pem$|secret|producer\.priv/i.test(name)) continue;
      copyFileSync(join(chainSrc, name), join(dst, name));
    }
    const headFile = join(dst, 'HEAD.json');
    if (existsSync(headFile)) {
      try {
        const h = JSON.parse(readFileSync(headFile, 'utf8'));
        chainHead = { height: h.height ?? null, hash: h.hash ?? null, producer: h.producer ?? null };
      } catch { notes.push('chain HEAD.json is not valid JSON — packed verbatim, head not summarised'); }
    }
  } else {
    notes.push(`no epoch chain at ${chainSrc} — packing without sealed blocks`);
  }

  mkdirSync(join(archive, 'media'), { recursive: true });
  writeFileSync(join(archive, 'media', 'manifest.json'), JSON.stringify(manifestMedia, null, 2) + '\n');

  const manifest = {
    acts: actCount,
    sha256: actsSha,
    at: stamp,
    chain: chainHead,
    media: { count: manifestMedia.count, bytes: manifestMedia.totalBytes },
    note:
      'A snapshot of the act log. Replay it with core/replay.mjs and you get the same balances, feeds ' +
      'and pool reserves the live host computes — that is what makes this a verifiable copy rather than ' +
      'a backup you have to trust. `at` is the newest act\'s own stamp, never a clock, so the same log ' +
      'stages to the same bytes on any day.',
  };
  writeFileSync(join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // The address book, if one has been published. It names who is answering
  // right now and falls through to this archive when nobody is.
  for (const candidate of [join(REPO, 'status.json'), join(dataDir, 'status.json')]) {
    if (existsSync(candidate)) { copyFileSync(candidate, join(stageDir, 'status.json')); break; }
  }

  return { notes, manifest };
}

// ── entry point ─────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes(name);

async function main() {
  const outPath = resolve(arg('--out') || process.env.PTP_CAR_OUT || join(REPO, 'dist', 'ptp-site.car'));
  const given = arg('--dir');
  let srcDir;
  let notes = [];

  if (given) {
    srcDir = resolve(given);
    if (!existsSync(srcDir)) { console.error(`no such directory: ${srcDir}`); process.exit(1); }
  } else {
    srcDir = resolve(process.env.PTP_SITE_DIR || join(REPO, 'dist', 'site'));
    const staged = stageSite(srcDir);
    notes = staged.notes;
    console.log(`staged  ${srcDir}`);
    console.log(`archive ${staged.manifest.acts} acts` +
      (staged.manifest.sha256 ? `, sha256 ${staged.manifest.sha256.slice(0, 16)}…` : '') +
      `, ${staged.manifest.media.count} media entries`);
  }

  const packed = packDirectory(srcDir);
  const mb = (packed.totalBytes / 1e6).toFixed(2);
  console.log(`packed  ${packed.files.length} files, ${mb} MB, ${packed.blocks.size} blocks`);

  if (!flag('--no-car')) {
    const written = await writeCar(outPath, packed.root, packed.blocks);
    console.log(`car     ${outPath}  (${written.count} blocks, ${(written.payload / 1e6).toFixed(2)} MB of payload)`);
    const cidFile = join(dirname(outPath), 'site.cid');
    writeFileSync(cidFile, packed.cid + '\n');
    console.log(`cid     ${cidFile}`);
  }

  console.log('');
  console.log(`root    ${packed.cid}`);
  console.log('');

  for (const n of notes) console.log(`note    ${n}`);
  if (notes.length) console.log('');

  const expected = arg('--check');
  if (expected) {
    if (expected.trim() === packed.cid) {
      console.log(`check   MATCH — this directory is byte-for-byte the site published at ${packed.cid}`);
    } else {
      console.log('check   MISMATCH');
      console.log(`        expected ${expected.trim()}`);
      console.log(`        computed ${packed.cid}`);
      console.log('        The two directories differ. Nothing here says which one is right —');
      console.log('        diff them, or verify the record itself with server/chain/verify.mjs.');
      process.exit(1);
    }
    return;
  }

  console.log('THIS PUBLISHED NOTHING. The only thing that happened is a local file.');
  console.log('Pinning is a separate, deliberate step, and it is a ratchet: content under a');
  console.log('CID that others pin cannot be recalled, by anyone, ever. Read the snapshot note');
  console.log('in docs/DECENTRALIZATION.md before the first pin.');
  console.log('');
  console.log('to host it, any one of these:');
  console.log(`  ipfs dag import "${outPath}" && ipfs pin add ${packed.cid}`);
  console.log('  upload the .car to any pinning service (Pinata, Filebase, web3.storage)');
  console.log('  hand the .car to anyone at all — it needs no server to be true');
  console.log('');
  console.log('then the network is at:');
  console.log(`  https://${packed.cid}.ipfs.<gateway>/     preferred: its own origin, so browser`);
  console.log('                                            storage is not shared with the gateway');
  console.log(`  https://<gateway>/ipfs/${packed.cid}/`);
  console.log('');
  console.log('to point the name at it:');
  console.log(`  node ops/domain/name.mjs --cid ${packed.cid}`);
  console.log('');
  console.log('anyone can check this address without trusting this machine:');
  console.log(`  node ops/ipfs-pack.mjs --dir <their copy> --no-car --check ${packed.cid}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
