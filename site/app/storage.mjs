// The device data-space: this browser as a storage node.
//
// ARCHITECTURE §7 says a member who grants storage IS the network's capacity.
// The pictures are not on a server we own; they are sharded across the members'
// own devices, three ways, placed by arithmetic instead of by a coordinator. This
// file is that half of the client.
//
// The four things it does, and the reason each one is here:
//
//   PERSIST     `navigator.storage.persist()` before anything is written. Without
//               it the browser may evict the whole origin under pressure, and an
//               evicted shard is a replica the network still believes exists —
//               the node fails its next challenge, is paid nothing, and the
//               picture is one device closer to gone. Permission is ASKED FOR,
//               explicitly, and refusal is reported as "this device is not
//               holding shards" rather than papered over.
//   PLACE       through core/placement.mjs — the SAME module server/capacity.mjs
//               uses. Rendezvous hashing is a pure function of (live node set,
//               cid, shard index), so a browser node and a server node agree on
//               who should hold what with nothing passing between them. A second
//               implementation here, however careful, would be a second answer.
//   PROVE       answer a byte-range challenge out of bytes actually held, again
//               through core/placement.mjs. A node that cannot answer is not
//               paid, which is the whole of what makes a storage receipt mean
//               anything.
//   REPORT      what is stored, how much, and what it has served. A member is
//               lending their disk and their bandwidth; they are told what for.
//
// ── THE METERED-CONNECTION RULE ────────────────────────────────────────────
//
// core/params.mjs SERVE_ON_METERED_CONNECTION is false, and docs/ECONOMICS.md
// says why in one number: serving pays about 1.5e-6 EUR per megabyte, and a
// 5 EUR-per-gigabyte mobile plan costs 0.004883 EUR per megabyte. A member
// serving on that plan pays 3,255 times what they earn, and — this is the part
// that makes it a rule rather than a preference — they would have no way of
// knowing.
//
// The platform is not much help here. `navigator.connection.saveData` is the only
// standardised signal and it is the user's data-saver switch, not a statement
// about the tariff; `connection.type` exists in Chromium and nowhere else. So
// when the platform will not say, this file treats the connection as METERED and
// serves nothing until the member says otherwise. That default costs the network
// some capacity on browsers that do not implement NetworkInformation. The other
// default costs a member real money on a plan they are paying for, silently, and
// that trade is not close.
//
// ── REFUSAL CODES USED HERE ────────────────────────────────────────────────
//   CAPACITY_NOT_PLACED   a shard this node was not assigned. Holding it earns
//                         nothing, so it is refused rather than stored.
//   CAPACITY_PROOF_WRONG  a challenge over bytes this device does not hold.
//   BAD_REQUEST           a malformed argument.

import { PARAMS } from '../core/params.mjs';
import { placeShard, shardsOf, challengeFor, answerChallenge, CHALLENGE_BYTES } from '../core/placement.mjs';
import { SHARD_BYTES } from '../core/replay.mjs';

export { CHALLENGE_BYTES, SHARD_BYTES };

/**
 * The byte range one shard occupies inside a picture.
 *
 * The last shard is short and is never padded: the cid commits to the real byte
 * length, and padding would change the bytes a challenge hashes. Stated here
 * rather than derived at each call site because the server derives the same
 * range and an off-by-one between the two is a failed proof with no explanation.
 */
export function shardRangeOf(index, byteLength, shardBytes = SHARD_BYTES) {
  if (!Number.isInteger(index) || index < 0) throw new Error('BAD_REQUEST');
  if (!Number.isInteger(byteLength) || byteLength < 0) throw new Error('BAD_REQUEST');
  const start = index * shardBytes;
  if (start >= byteLength && byteLength > 0) throw new Error('BAD_REQUEST');
  const end = Math.min(start + shardBytes, byteLength);
  return { start, end, length: end - start };
}

/** Every shard index of a picture, and which of them are this node's. One call,
 * because asking those two questions separately is how they drift. */
export function shardPlanFor(nodeId, post, nodes, params = PARAMS, shardBytes = SHARD_BYTES) {
  if (typeof nodeId !== 'string' || nodeId === '') throw new Error('BAD_REQUEST');
  if (!post || typeof post.cid !== 'string' || !Number.isInteger(post.bytes)) throw new Error('BAD_REQUEST');
  const all = shardsOf(post.cid, post.bytes, shardBytes);
  const live = [...new Set(nodes)].filter((id) => typeof id === 'string' && id !== '');
  const replication = Number(params.replication);
  const mine = [];
  const holders = new Map();
  for (const index of all) {
    const placed = placeShard(live, post.cid, index, replication);
    holders.set(index, placed);
    if (placed.includes(nodeId)) mine.push(index);
  }
  return { shards: all, mine, holders };
}

// ── backends ───────────────────────────────────────────────────────────────
//
// One key space — `${cid}/${index}` — over three implementations, because the
// browsers this app has to run on do not all offer the same one. OPFS is
// preferred: it is the only origin storage with real file semantics and it is
// the one persistence actually protects. IndexedDB is the fallback, and it is a
// real fallback rather than a pretence — it holds the same bytes under the same
// keys and answers the same challenges. Memory is for tests and for a browser
// that has neither, where the honest report is that this device is not a storage
// node.

const SHARD_DIR = 'ptp-shards';

function keyOf(cid, index) {
  return `${cid}/${index}`;
}

export function memoryBackend() {
  const map = new Map();
  return {
    name: 'memory',
    durable: false,
    async put(key, bytes) {
      map.set(key, bytes.slice());
    },
    async get(key) {
      const v = map.get(key);
      return v ? v.slice() : null;
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
    async clear() {
      map.clear();
    },
  };
}

/** The Origin Private File System. One directory per cid, one file per shard, so
 * forgetting a settled picture is one directory removal rather than a scan. */
export async function opfsBackend() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(SHARD_DIR, { create: true });
  const split = (key) => {
    const at = key.lastIndexOf('/');
    return { cid: key.slice(0, at), name: key.slice(at + 1) };
  };
  return {
    name: 'opfs',
    durable: true,
    async put(key, bytes) {
      const { cid, name } = split(key);
      const sub = await dir.getDirectoryHandle(cid, { create: true });
      const file = await sub.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(bytes);
      await w.close();
    },
    async get(key) {
      const { cid, name } = split(key);
      try {
        const sub = await dir.getDirectoryHandle(cid);
        const file = await sub.getFileHandle(name);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    },
    async remove(key) {
      const { cid, name } = split(key);
      try {
        const sub = await dir.getDirectoryHandle(cid);
        await sub.removeEntry(name);
      } catch {
        /* already gone is the state we wanted */
      }
    },
    async removeAll(cid) {
      try {
        await dir.removeEntry(cid, { recursive: true });
      } catch {
        /* already gone */
      }
    },
    async keys() {
      const out = [];
      for await (const [cid, handle] of dir.entries()) {
        if (handle.kind !== 'directory') continue;
        for await (const [name, entry] of handle.entries()) {
          if (entry.kind === 'file') out.push(`${cid}/${name}`);
        }
      }
      return out;
    },
    async clear() {
      for await (const [cid] of dir.entries()) await this.removeAll(cid);
    },
  };
}

/** IndexedDB, for a browser with no OPFS — private windows on some platforms
 * have exactly that shape. */
export async function idbBackend(dbName = 'ptp-shards') {
  if (typeof indexedDB === 'undefined') return null;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('shards')) req.result.createObjectStore('shards');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  if (!db) return null;
  const run = (mode, fn) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction('shards', mode);
      const req = fn(tx.objectStore('shards'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  return {
    name: 'indexeddb',
    durable: true,
    async put(key, bytes) {
      await run('readwrite', (s) => s.put(bytes.slice().buffer, key));
    },
    async get(key) {
      const buf = await run('readonly', (s) => s.get(key));
      return buf ? new Uint8Array(buf) : null;
    },
    async remove(key) {
      await run('readwrite', (s) => s.delete(key));
    },
    async keys() {
      return (await run('readonly', (s) => s.getAllKeys())) || [];
    },
    async clear() {
      await run('readwrite', (s) => s.clear());
    },
  };
}

/** OPFS, then IndexedDB, then nothing — and "nothing" is reported rather than
 * simulated. A device that cannot hold a shard is not a storage node, and saying
 * so is the only honest degradation: a member who thinks they are earning and is
 * not has been lied to. */
export async function detectBackend() {
  const opfs = await opfsBackend().catch(() => null);
  if (opfs) return opfs;
  const idb = await idbBackend().catch(() => null);
  if (idb) return idb;
  return null;
}

// ── the connection ─────────────────────────────────────────────────────────

/**
 * What this device's connection is, as far as the platform will say.
 *
 * `metered` is deliberately three-valued. `true` and `false` come from the
 * platform; `null` means it would not say, and `null` is treated as metered
 * everywhere a decision is made. `override` is the member's own answer, which
 * outranks a guess in both directions — they know what they are paying for and
 * the browser does not.
 */
export function connectionState(override = null, nav = typeof navigator === 'undefined' ? null : navigator) {
  const c = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
  let metered = null;
  let why = 'This browser does not report what kind of connection it is on.';
  if (c) {
    if (c.saveData === true) {
      metered = true;
      why = 'Data saver is on, which is the one signal every browser agrees means "this data costs me".';
    } else if (typeof c.type === 'string' && c.type !== '') {
      metered = c.type === 'cellular' || c.type === 'wimax';
      why = metered
        ? `The connection reports itself as ${c.type}.`
        : `The connection reports itself as ${c.type}.`;
    }
  }
  if (override === true || override === false) {
    metered = override;
    why = override ? 'You said this connection is metered.' : 'You said this connection is unmetered.';
  }
  return { metered, why, saveData: Boolean(c && c.saveData), type: (c && c.type) || null };
}

// ── the data space ─────────────────────────────────────────────────────────

/**
 * This device as a node in the network's capacity.
 *
 * `nodeId` is the member's own address: placement ranks node ids, and a node id
 * that is not an account is a node nothing can be paid to.
 */
export function createDataSpace(options = {}) {
  const params = options.params || PARAMS;
  const shardBytes = options.shardBytes || SHARD_BYTES;
  let backend = options.backend || null;
  let nodeId = options.nodeId || null;
  let persisted = false;
  let asked = false;
  let meteredOverride = options.meteredOverride === undefined ? null : options.meteredOverride;
  let servedBytes = 0n;
  let servedCount = 0;
  const sizes = new Map(); // key -> byte length, so a report costs no reads

  async function open() {
    if (!backend) backend = await detectBackend();
    if (backend) {
      for (const key of await backend.keys().catch(() => [])) {
        if (!sizes.has(key)) {
          const bytes = await backend.get(key).catch(() => null);
          if (bytes) sizes.set(key, bytes.length);
        }
      }
    }
    return Boolean(backend);
  }

  /**
   * Ask the browser to make this origin's storage persistent, once, out loud.
   *
   * The request is a permission prompt on some platforms and a silent heuristic
   * on others, and both answers are reported the same way: a boolean and the
   * sentence that goes with it. Refusal is not an error — it is a device that
   * will not be a storage node, which is a normal thing for a device to be.
   */
  async function requestPersistence() {
    asked = true;
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) {
      persisted = false;
      return { persisted, why: 'This browser cannot make storage persistent, so shards here could be evicted at any time.' };
    }
    persisted = Boolean(await navigator.storage.persisted?.().catch(() => false));
    if (!persisted) persisted = Boolean(await navigator.storage.persist().catch(() => false));
    return {
      persisted,
      why: persisted
        ? 'Storage is persistent: the browser will not evict these shards to reclaim space.'
        : 'The browser refused persistent storage, so shards here can be evicted without warning. This device will not be counted on.',
    };
  }

  function connection() {
    return connectionState(meteredOverride);
  }

  /** The metered rule, in one place. Serving and storing are both gated by it —
   * bytes stored are bytes that will be served. */
  function mayServe() {
    if (params.serveOnMeteredConnection) return { ok: true, why: 'This edition permits serving on a metered connection.' };
    const c = connection();
    if (c.metered === false) return { ok: true, why: c.why };
    return {
      ok: false,
      why:
        (c.metered === true ? c.why : c.why + ' Until you say, this device serves nothing.') +
        ' Serving pays about 1.5e-6 EUR a megabyte; a 5 EUR-per-gigabyte plan costs 0.004883 EUR a megabyte, which is 3,255 times more than it earns.',
    };
  }

  function setMetered(value) {
    meteredOverride = value === null ? null : Boolean(value);
    return connection();
  }

  function setNodeId(id) {
    nodeId = id;
  }

  /** Which shards of this post belong to this device, under the live node set. */
  function plan(post, nodes) {
    if (!nodeId) throw new Error('BAD_REQUEST');
    return shardPlanFor(nodeId, post, nodes, params, shardBytes);
  }

  /**
   * Take one shard, if it is ours and if the connection permits.
   *
   * Placement is checked before a byte is written. A shard this node was not
   * assigned earns nothing (CAPACITY_NOT_PLACED) and holding it is pure cost, so
   * accepting it would be a device doing free work for a stranger's replication
   * factor.
   */
  async function accept(post, index, bytes, nodes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('BAD_REQUEST');
    const allowed = mayServe();
    if (!allowed.ok) return { stored: false, why: allowed.why };
    if (!(await open())) return { stored: false, why: 'This device has no storage the app can use, so it is not a storage node.' };
    const { mine } = plan(post, nodes);
    if (!mine.includes(index)) throw new Error('CAPACITY_NOT_PLACED');
    const range = shardRangeOf(index, post.bytes, shardBytes);
    if (bytes.length !== range.length) throw new Error('BAD_REQUEST');
    const key = keyOf(post.cid, index);
    await backend.put(key, bytes);
    sizes.set(key, bytes.length);
    return { stored: true, why: allowed.why, bytes: bytes.length };
  }

  async function held(cid, index) {
    if (!(await open())) return null;
    return backend.get(keyOf(cid, index));
  }

  /**
   * Answer this epoch's challenge for one shard.
   *
   * The window is derived from `sha256(cid, shardIndex, epochSeed)` — public,
   * recomputable by anybody including the node being challenged, which does not
   * matter at all: knowing WHICH bytes are wanted is worth nothing without having
   * them. `answerChallenge` refuses a short slice rather than hashing one, so a
   * truncated shard reports as a truncated shard instead of as a wrong answer.
   */
  async function prove(post, index, epochSeed) {
    const bytes = await held(post.cid, index);
    if (!bytes) throw new Error('CAPACITY_PROOF_WRONG');
    const challenge = challengeFor(post.cid, index, epochSeed, bytes.length);
    return { challenge: { pid: post.pid, shard: index }, answer: answerChallenge(bytes, challenge), window: challenge };
  }

  /** Hand a shard to a peer that asked for it, and count the bytes. Served bytes
   * are what the capacity share of engagement actually pays for. */
  async function serve(cid, index) {
    const allowed = mayServe();
    if (!allowed.ok) return null;
    const bytes = await held(cid, index);
    if (!bytes) return null;
    servedBytes += BigInt(bytes.length);
    servedCount += 1;
    return bytes;
  }

  /** A settled post's picture leaves this device with its payload. Deletion is an
   * instruction from the log, not a timer: `settle` landed, so the bytes go. */
  async function forget(cid) {
    if (!(await open())) return 0;
    let removed = 0;
    if (backend.removeAll) {
      const before = [...sizes.keys()].filter((k) => k.startsWith(cid + '/'));
      await backend.removeAll(cid);
      for (const k of before) {
        sizes.delete(k);
        removed += 1;
      }
      return removed;
    }
    for (const key of await backend.keys()) {
      if (!key.startsWith(cid + '/')) continue;
      await backend.remove(key);
      sizes.delete(key);
      removed += 1;
    }
    return removed;
  }

  /**
   * What is stored, how much, and what it has served — the whole of what the
   * wallet sheet shows a member about their own device. `quota` and `usage` come
   * from the browser's own estimate and are reported as the estimate they are.
   */
  async function report() {
    await open();
    let bytes = 0;
    for (const n of sizes.values()) bytes += n;
    const pictures = new Set([...sizes.keys()].map((k) => k.slice(0, k.lastIndexOf('/'))));
    let quota = null;
    let usage = null;
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate().catch(() => null);
      if (e) {
        quota = e.quota ?? null;
        usage = e.usage ?? null;
      }
    }
    const allowed = mayServe();
    return {
      backend: backend ? backend.name : null,
      isNode: Boolean(backend) && allowed.ok,
      persisted,
      asked,
      serving: allowed.ok,
      why: allowed.why,
      connection: connection(),
      shards: sizes.size,
      pictures: pictures.size,
      bytes,
      servedBytes,
      servedCount,
      quota,
      usage,
    };
  }

  return {
    open,
    requestPersistence,
    connection,
    setMetered,
    setNodeId,
    mayServe,
    plan,
    accept,
    held,
    prove,
    serve,
    forget,
    report,
    get nodeId() {
      return nodeId;
    },
  };
}
