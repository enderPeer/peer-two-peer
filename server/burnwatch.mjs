// Proof of burn: the only way in, and the only thing this host cannot compute.
//
// ARCHITECTURE rule 3 says reserve comes from bitcoin destroyed at a keyless
// output and from nowhere else. Every other number in this network is a pure
// function of the act log, so every other number can be recomputed by a stranger
// with none of our machines running. This one cannot: whether a bitcoin
// transaction exists is a fact about a different chain, and somebody has to go
// and look.
//
// That makes this the one place where the host is trusted, so the design is
// built to make the trust as small as possible and to make a lie attributable:
//
//   TWO INDEPENDENT EXPLORERS MUST AGREE. Not one. A single explorer is a single
//   point at which reserve can be conjured, and reserve conjured is weight
//   bought with money nobody destroyed. When the two disagree the claim is
//   refused rather than decided on a coin flip — a wrong number written into a
//   permanent public record is worse than no number.
//
//   THE TXID GOES IN THE LOG. `burnClaim` carries the transaction id, so every
//   reader can check the chain instead of believing this host. The host's
//   verification is a gate on what gets written; it is not the evidence.
//
//   THE OUTPUT HAS NO KEY BY CONSTRUCTION. The burn address is a P2WSH whose
//   witness script is a bare OP_RETURN. OP_RETURN fails immediately when
//   executed, so no witness satisfies it and no key exists that could — not the
//   sender's, not the operator's, not the network's. The address is derived
//   below rather than pasted, so nobody has to trust that a hard-coded string is
//   really unspendable.
//
// ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
//
// It does not decide whether a burn was already claimed. That is a fact about
// the act log, core/replay.mjs holds the index, and this file only asks a
// predicate the caller supplies so that the cheap check runs before the network
// one. It does not credit anything: it answers yes or no about bitcoin, and
// replay decides what the answer is worth.

import { createHash } from 'node:crypto';

/**
 * The keyless burn output, derived rather than pasted.
 *
 * A P2WSH scriptPubKey is OP_0 followed by a 32-byte push of the sha256 of the
 * witness script. The witness script here is one byte, OP_RETURN (0x6a), which
 * terminates script execution in failure the moment it runs. Spending the output
 * requires revealing a script that hashes to this value and then satisfying it;
 * the first is possible and the second is not, so the coins are destroyed in the
 * strongest sense available on bitcoin — provably, by arithmetic, rather than by
 * anybody's promise not to spend.
 *
 * Deriving it here means the claim "this address has no key" is checkable in
 * three lines by anyone reading this file, instead of being a property of a
 * string somebody typed.
 */
export const BURN_WITNESS_SCRIPT_HEX = '6a';
export const BURN_SCRIPT_HEX =
  '0020' + createHash('sha256').update(Buffer.from([0x6a])).digest('hex');

/**
 * How many confirmations count.
 *
 * An unconfirmed transaction can be replaced. Crediting reserve from one would
 * let a sender fee-bump the same coins elsewhere afterwards and keep the weight,
 * which is weight bought with money that was never destroyed. Three blocks is
 * the usual small-value bar and is roughly half an hour.
 */
export const MIN_CONFIRMATIONS = 3;

/**
 * How far apart two explorers' confirmation counts may be and still be agreeing.
 *
 * Exact equality is the wrong test and it took a moment to see why. Two honest
 * explorers a block apart are not disagreeing about the chain; they are
 * observing it at two instants, and blocks arrive every ten minutes. Demanding
 * an exact match would turn ordinary propagation into BURN_EXPLORERS_DISAGREE
 * and refuse real burns for the whole life of the network. What must match
 * exactly is what cannot drift: the output script and the amount. Depth is
 * checked as a bound — both must clear the minimum — and as a sanity window.
 */
export const CONFIRMATION_TOLERANCE = 3;

/**
 * How long an explorer has to answer, and how much it may say.
 *
 * Both bounds exist because the far end is somebody else's server, reachable by
 * anybody who can get a `burnClaim` past the signature check. Without the
 * deadline a stalled explorer holds the call open for as long as it likes;
 * without the byte cap a broken or hostile one can answer with a stream that
 * never ends and take this host's memory instead of its time. Fifteen seconds is
 * several times a healthy round trip to a public API, and a transaction's JSON
 * is a few kilobytes, so a megabyte is a ceiling and not a working size.
 */
export const EXPLORER_TIMEOUT_MS = 15000;
export const EXPLORER_MAX_BYTES = 1048576;

function fail(code, detail) {
  const err = new Error(code);
  err.code = code;
  err.detail = detail || null;
  return err;
}

/**
 * Fetch one URL and read its body under both bounds.
 *
 * `AbortSignal.timeout` covers the WHOLE exchange — connect, headers and body —
 * because it aborts the request itself rather than racing a promise beside it. A
 * promise that merely loses a race leaves the socket open and the read running,
 * so the caller returns while the work does not stop; the difference matters
 * here because the caller is a write path and the work is unbounded.
 *
 * The body is read in chunks and the running total checked against the cap, so
 * an endless answer is dropped as it arrives rather than after it has all been
 * held. A `content-length` that already exceeds the cap is refused before a byte
 * of body is read.
 *
 * server/oracle.mjs carries the same helper against the same hazard. They are
 * separate on purpose: the price feed's deadline and the burn watcher's are
 * different numbers for different reasons, and sharing the function would make
 * one file's policy quietly govern the other's.
 */
async function fetchTextBounded(fetchImpl, url, { timeoutMs, maxBytes, explorer }) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res || res.ok !== true) {
    throw fail('NOT_FOUND', { explorer, status: res ? res.status : null, url });
  }

  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  const declared = header === null ? NaN : Number(header);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw fail('PAYLOAD_TOO_LARGE', { explorer, bytes: declared, max: maxBytes, url });
  }

  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw fail('PAYLOAD_TOO_LARGE', { explorer, bytes: size, max: maxBytes, url });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // A fetch implementation that exposes no stream — a stub, or a runtime without
  // one. The text is read whole and measured after, which bounds what this host
  // will USE but not what it briefly held. Stated rather than hidden: the real
  // `fetch` this ships with does expose a stream, so the bounded path is the one
  // that runs in a deployment.
  const text = await res.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) throw fail('PAYLOAD_TOO_LARGE', { explorer, bytes, max: maxBytes, url });
  return text;
}

/**
 * An explorer, as this file needs one: a name and a function from txid to a
 * normalised transaction.
 *
 *   { name, async tx(txid) -> { confirmations, outputs: [{ sat, scriptHex }] } }
 *
 * Normalising at the edge is what makes the disagreement test meaningful. Two
 * APIs describing the same transaction in two shapes would otherwise "disagree"
 * about everything, and the check would be a formality that always fires.
 */

/** mempool.space, normalised. The bounds are arguments rather than constants in
 * the body so a deployment on a slow link, and a test, can state their own. */
export function mempoolSpace(fetchImpl, base = 'https://mempool.space/api', bounds = {}) {
  const { timeoutMs = EXPLORER_TIMEOUT_MS, maxBytes = EXPLORER_MAX_BYTES } = bounds;
  const name = 'mempool.space';
  return {
    name,
    async tx(txid) {
      const [txText, tipText] = await Promise.all([
        fetchTextBounded(fetchImpl, `${base}/tx/${txid}`, { timeoutMs, maxBytes, explorer: name }),
        fetchTextBounded(fetchImpl, `${base}/blocks/tip/height`, { timeoutMs, maxBytes, explorer: name }),
      ]);
      let tx;
      try {
        tx = JSON.parse(txText);
      } catch {
        throw fail('NOT_FOUND', { explorer: name, why: 'the answer was not JSON' });
      }
      const tip = Number(tipText);
      const height = tx && tx.status && tx.status.block_height;
      const confirmations = tx && tx.status && tx.status.confirmed ? tip - height + 1 : 0;
      return {
        confirmations,
        outputs: (tx.vout || []).map((o) => ({
          sat: BigInt(o.value),
          scriptHex: String(o.scriptpubkey || '').toLowerCase(),
        })),
      };
    },
  };
}

/** blockstream.info, normalised. Same shape of API, different operator, which
 * is the whole reason both are here. */
export function blockstreamInfo(fetchImpl, base = 'https://blockstream.info/api', bounds = {}) {
  const inner = mempoolSpace(fetchImpl, base, bounds);
  return { name: 'blockstream.info', tx: inner.tx };
}

/** The pair this host ships with, when a real fetch is available. */
export function defaultExplorers(fetchImpl = globalThis.fetch, bounds = {}) {
  if (typeof fetchImpl !== 'function') return [];
  return [mempoolSpace(fetchImpl, undefined, bounds), blockstreamInfo(fetchImpl, undefined, bounds)];
}

/**
 * Verify one burn claim against the explorers.
 *
 * Returns `{ ok: true, sat, confirmations, scriptHex, explorers }` or throws an
 * Error whose `code` is from the catalogue and whose `detail` carries the
 * numbers — the two amounts, the two depths, the script that was actually there.
 * A refusal that says only "they disagreed" leaves the caller unable to check it
 * themselves, which defeats the point of publishing the txid.
 *
 * `claimed(key)` is the caller's uniqueness predicate over `txid:vout`. It is
 * asked FIRST, before any network call: a burn counts once whoever presents it,
 * and re-asking two explorers about a transaction the log already carries is
 * work an attacker gets to make this host do for nothing.
 *
 * THIS FUNCTION GOES TO THE NETWORK, SO IT MUST NOT BE CALLED HOLDING A LOCK.
 * The bounds above cap how long that can take and how much can arrive, but a
 * bound is not zero: server/index.mjs runs this with its write queue released
 * and re-reads `claimed` under the queue afterwards, because the answer about
 * bitcoin cannot go stale while the answer about who already claimed the output
 * can. A caller that awaits this inside a write queue turns one slow third party
 * into a stop on every write the host would otherwise have accepted.
 */
export async function checkBurn(claim, options = {}) {
  const {
    explorers = [],
    minConfirmations = MIN_CONFIRMATIONS,
    tolerance = CONFIRMATION_TOLERANCE,
    scriptHex = BURN_SCRIPT_HEX,
    claimed = null,
  } = options;

  const txid = typeof claim.txid === 'string' ? claim.txid.toLowerCase() : '';
  const vout = Number(claim.vout);
  const sat = typeof claim.sat === 'bigint' ? claim.sat : BigInt(String(claim.sat));

  if (!/^[0-9a-f]{64}$/.test(txid)) throw fail('BAD_REQUEST', { txid: claim.txid });
  if (!Number.isSafeInteger(vout) || vout < 0) throw fail('BAD_REQUEST', { vout: claim.vout });
  if (sat <= 0n) throw fail('BAD_AMOUNT', { sat: sat.toString() });

  if (typeof claimed === 'function' && claimed(`${txid}:${vout}`)) {
    throw fail('BURN_ALREADY_CLAIMED', { txid, vout });
  }

  if (explorers.length < 2) {
    // Not "they disagreed" — there is nobody to disagree with. It is reported
    // under the same code because the consequence for the caller is identical
    // and the detail says which case it was.
    throw fail('BURN_EXPLORERS_DISAGREE', {
      configured: explorers.length,
      need: 2,
      why: 'this host has fewer than two independent explorers configured',
    });
  }

  const settled = await Promise.allSettled(explorers.map((e) => e.tx(txid)));
  const answers = [];
  const failures = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled' && r.value) answers.push({ name: explorers[i].name, ...r.value });
    else failures.push({ name: explorers[i].name, error: String((r.reason && r.reason.message) || r.reason) });
  }

  if (answers.length < 2) {
    throw fail('BURN_EXPLORERS_DISAGREE', { answered: answers.length, need: 2, failures });
  }

  const views = answers.map((a) => {
    const out = (a.outputs || [])[vout];
    return {
      explorer: a.name,
      confirmations: Number(a.confirmations) || 0,
      sat: out ? out.sat : null,
      scriptHex: out ? String(out.scriptHex).toLowerCase() : null,
    };
  });

  if (views.some((v) => v.sat === null)) {
    throw fail('BAD_REQUEST', { txid, vout, why: 'no output at that index', views: viewsForWire(views) });
  }

  // The two things that cannot honestly drift: the amount and the script. A
  // difference in either means the two explorers are describing different
  // transactions, and the host has no way to tell which one is the chain.
  const sats = new Set(views.map((v) => v.sat.toString()));
  const scripts = new Set(views.map((v) => v.scriptHex));
  if (sats.size > 1 || scripts.size > 1) {
    throw fail('BURN_EXPLORERS_DISAGREE', { txid, vout, views: viewsForWire(views) });
  }

  const depths = views.map((v) => v.confirmations);
  if (Math.max(...depths) - Math.min(...depths) > tolerance) {
    throw fail('BURN_EXPLORERS_DISAGREE', {
      txid,
      vout,
      confirmations: depths,
      tolerance,
      why: 'the two depths are further apart than propagation explains',
    });
  }

  const observedScript = views[0].scriptHex;
  if (observedScript !== scriptHex.toLowerCase()) {
    // A payment to a spendable address is a transfer, not a burn, and grants
    // nothing. Checked after agreement so the caller learns which script was
    // actually there rather than which of two it might have been.
    throw fail('BURN_NOT_KEYLESS', { txid, vout, script: observedScript, expected: scriptHex });
  }

  const observedSat = views[0].sat;
  if (observedSat !== sat) {
    throw fail('BAD_AMOUNT', { claimed: sat.toString(), observed: observedSat.toString(), txid, vout });
  }

  const confirmations = Math.min(...depths);
  if (confirmations < minConfirmations) {
    throw fail('BURN_UNCONFIRMED', { txid, vout, confirmations, need: minConfirmations });
  }

  return {
    ok: true,
    txid,
    vout,
    sat: observedSat,
    confirmations,
    scriptHex: observedScript,
    explorers: views.map((v) => v.explorer),
  };
}

/** Views with the bigints turned into strings, so a refusal detail survives
 * JSON without anybody having to remember to convert it. */
function viewsForWire(views) {
  return views.map((v) => ({ ...v, sat: v.sat === null ? null : v.sat.toString() }));
}

/**
 * What GET /api/v1/params publishes about the burn, so a sender never has to
 * find the address in a paragraph.
 */
export function burnFacts({ minConfirmations = MIN_CONFIRMATIONS, explorers = [] } = {}) {
  return {
    scriptHex: BURN_SCRIPT_HEX,
    witnessScriptHex: BURN_WITNESS_SCRIPT_HEX,
    kind: 'p2wsh(OP_RETURN)',
    keyless:
      'The witness script is a bare OP_RETURN, which fails the moment it executes. No witness satisfies it, so no key exists that could spend this output — including the operator\'s and including the network\'s.',
    minConfirmations,
    explorers: explorers.map((e) => e.name),
    explorersMustAgree: 2,
    tolerance: CONFIRMATION_TOLERANCE,
    next: 'Send to this output, wait for the confirmations, then POST /api/v1/act with k="burnClaim" naming the txid, the vout and the satoshis.',
  };
}
