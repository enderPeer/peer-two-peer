// The EUR/BTC rate: five sources, a quorum of three, a median, and a clamp.
//
// Prices in this network are euros and settlement is PTP, and core/pricing.mjs
// joins them with one rational whose numerator carries a EUR/BTC rate. That rate
// is the only number in the whole economy that comes from outside the log, so it
// is the only number an outsider can move — and moving it moves the scale of an
// epoch. It cannot flip the sign of any property in docs/ECONOMICS.md, because
// emission reads no oracle and every safety property there is a ratio of basis
// points, but a 50% low lie doubles fees measured in satoshis and therefore
// doubles the burn.
//
// So the rate is defended four ways, and every one of them is a parameter in
// core/params.mjs rather than a choice made here:
//
//   ORACLE_MIN_SOURCES = 5   this host refuses to start an oracle with fewer
//                            configured. Shipping three and calling it a median
//                            is how a two-source failure becomes a one-source
//                            oracle without anybody noticing.
//   ORACLE_QUORUM = 3        at least three must answer, or the read is stale.
//                            A median of two is a mean of two, and a mean of two
//                            is what a single liar wants.
//   ORACLE_MAX_MOVE_BPS      +/-10% per epoch against the previously sealed
//                            rate. Sustaining a 2x distortion costs eight epochs
//                            of public lying.
//   ORACLE_SEAL_PER_SOURCE_VALUES
//                            every source's own value is carried into the sealed
//                            rate, not only the median. Sealing the median makes
//                            a lie visible in aggregate; sealing the values makes
//                            it attributable to a named source.
//
// THE CLAMP HAS A COST AND IT IS NOT HIDDEN. A genuine bitcoin move of more than
// 10% in a day is mispriced until the rate catches up — three epochs for a 30%
// move — and every fee in that window is wrong by the difference. That is the
// cheaper side of the trade against an unclamped rate a manipulator can steer,
// and the error is public while it happens because both the clamped rate and the
// values it was clamped from are in the block.
//
// ── WHAT THIS FILE CANNOT CHECK ────────────────────────────────────────────
//
// That the sources are independent. Five endpoints that all resell one exchange
// feed are one source wearing five names, and nothing measurable from here tells
// them apart. The defence is in the configuration and in publishing the list, so
// that a reader who knows the market can say so. It is stated here rather than
// implied by the word "independent" appearing in a parameter name.

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BPS,
  NANO_EUR_PER_EUR,
  ORACLE_MAX_MOVE_BPS,
  ORACLE_MIN_SOURCES,
  ORACLE_QUORUM,
} from '../core/params.mjs';
import { canonicalBytes } from '../core/canonical.mjs';

function fail(code, detail) {
  const err = new Error(code);
  err.code = code;
  err.detail = detail || null;
  return err;
}

/**
 * The median of a list of bigints, truncating downward on an even count.
 *
 * Downward on purpose: it makes the sealed rate no higher than the sources
 * support, and a EUR/BTC rate that is too high makes a euro price cost fewer
 * satoshis and therefore fewer PTP. A rounding rule must never be able to raise
 * a fee, and this is the direction that guarantees it.
 *
 * core/pricing.mjs has the same function for the same reason. They are separate
 * because that one seals a Rate into an epoch and this one reads a network, and
 * a shared helper between a pure module and a networked one would drag the
 * network into the one rulebook.
 */
export function medianNano(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Turn a decimal EUR-per-BTC price into an integer nanoeuro rate.
 *
 * Sources answer with a JSON number, which is a double, and a double is not a
 * price — it is a nearby price. The conversion goes through the decimal string
 * rather than through `Math.round(x * 1e9)`, so 90000.005 becomes exactly
 * 90000005000000 rather than whatever the multiplication happened to land on.
 * Everything downstream of this line is a bigint.
 */
export function eurToNano(value) {
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw fail('ORACLE_STALE', { value: text });
  const [whole, frac = ''] = text.split('.');
  const nine = (frac + '000000000').slice(0, 9);
  const nano = BigInt(whole) * NANO_EUR_PER_EUR + BigInt(nine);
  if (nano <= 0n) throw fail('ORACLE_STALE', { value: text });
  return nano;
}

/**
 * How long a source has to answer, and how much it may say.
 *
 * Both bounds exist because the far end is somebody else's server. Without the
 * deadline a stalled endpoint holds the read open; without the byte cap a broken
 * or hostile one can answer with a stream that never ends and take this host's
 * memory instead of its time. A ticker document is a few kilobytes, so a quarter
 * of a megabyte is a ceiling and not a working size.
 *
 * `readOracle` also races each source against its own `timeoutMs`. That race is
 * kept because a source is an arbitrary function and need not use fetch at all;
 * what it cannot do is stop the work, which is what the abort signal here is for.
 *
 * server/burnwatch.mjs carries the same helper against the same hazard. They are
 * separate on purpose: the price feed's deadline and the burn watcher's are
 * different numbers for different reasons, and sharing the function would make
 * one file's policy quietly govern the other's.
 */
export const SOURCE_TIMEOUT_MS = 8000;
export const SOURCE_MAX_BYTES = 262144;

/**
 * Fetch one URL and read its body as text under both bounds.
 *
 * `AbortSignal.timeout` covers the whole exchange — connect, headers and body —
 * because it aborts the request itself rather than racing a promise beside it. A
 * promise that loses a race leaves the socket open and the read running. The
 * body is read in chunks with a running total, so an endless answer is dropped as
 * it arrives rather than after it has all been held.
 */
async function fetchTextBounded(fetchImpl, url, { timeoutMs, maxBytes }) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res || res.ok !== true) throw new Error(`${res ? res.status : 'no response'}`);

  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
  const declared = header === null ? NaN : Number(header);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`body ${declared} > ${maxBytes}`);

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
        throw new Error(`body over ${maxBytes}`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // A fetch implementation that exposes no stream — a stub, or a runtime without
  // one. The text is read whole and measured after, which bounds what this host
  // will USE but not what it briefly held.
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`body over ${maxBytes}`);
  return text;
}

/**
 * The digits a source published for `key`, taken out of the RAW TEXT.
 *
 * Read from the text rather than from a parsed value on purpose. `JSON.parse`
 * has one numeric type and it is a double, so an unquoted price of 90000.005
 * becomes the nearest double and is re-rendered by `String()` as whatever that
 * double's shortest round-trip form happens to be — the digits the source
 * actually published are gone before `eurToNano` is ever handed them. Four of the
 * five sources answer with a quoted string and never had the problem; this is
 * what makes the fifth read the same way.
 *
 * THE DISTINCTION THAT MADE THE DOUBLE ACCEPTABLE, AND THAT STILL MAKES IT WORTH
 * REMOVING. A rate is an OBSERVATION entering the system, not arithmetic on a
 * balance. Nothing downstream of `eurToNano` is ever a float — the rate is a
 * bigint from that line onward, every fee is one fused rational in integers, and
 * ARCHITECTURE's rule that money is BigInt is about quantities the log owns, not
 * about what a stranger's API said the market was. So a double here could only
 * ever move the observation by an ulp; it could not corrupt a balance. But an
 * ulp of a bitcoin price is still a number this host signs, seals into a block,
 * and attributes to a NAMED source as if it were what that source said — and a
 * value nobody published should not appear under somebody's name. Reading the
 * digits costs one regular expression and removes the whole question.
 *
 * THE LIMIT OF THIS HELPER, AND WHAT IT THEREFORE DOES NOT COVER. It matches the
 * FIRST occurrence of the key, so it is only correct on a document where the key
 * appears once — coingecko's names one coin and one currency and does. It is not
 * applied to blockchain.info, which also answers with a bare number: that
 * document repeats `last` once per currency, so a first-match regex there would
 * be a coin flip between markets rather than a fix. Reading it correctly needs a
 * scope for the enclosing currency object, and that is a change to a source this
 * round was not asked to touch; it is named here so the next reader knows the
 * hazard is one source wide and not zero.
 */
export function decimalFrom(text, key) {
  const at = new RegExp(`"${key}"\\s*:\\s*"?(\\d+(?:\\.\\d+)?)"?`).exec(String(text));
  if (!at) throw fail('ORACLE_STALE', { key, why: 'no decimal under that key in the answer' });
  return at[1];
}

/**
 * The five public sources this host reads, each named and each with its own
 * shape of answer.
 *
 * They are listed as data rather than hidden behind a fetch loop because the
 * list is the security argument: a reader who wants to judge whether five
 * independent parties really answered can only do that if they can see who was
 * asked. GET /api/v1/oracle publishes exactly these names alongside the values
 * they gave.
 */
export function publicSources(fetchImpl = globalThis.fetch, bounds = {}) {
  const { timeoutMs = SOURCE_TIMEOUT_MS, maxBytes = SOURCE_MAX_BYTES } = bounds;
  const text = (url) => fetchTextBounded(fetchImpl, url, { timeoutMs, maxBytes });
  const get = async (url) => JSON.parse(await text(url));
  return [
    // coingecko answers with a bare JSON number where the other four quote
    // theirs, so its digits are taken out of the raw text. See `decimalFrom`.
    { name: 'coingecko', async read() { return eurToNano(decimalFrom(await text('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur'), 'eur')); } },
    { name: 'coinbase', async read() { const j = await get('https://api.coinbase.com/v2/prices/BTC-EUR/spot'); return eurToNano(j.data.amount); } },
    { name: 'kraken', async read() { const j = await get('https://api.kraken.com/0/public/Ticker?pair=XBTEUR'); const k = Object.keys(j.result)[0]; return eurToNano(j.result[k].c[0]); } },
    { name: 'bitstamp', async read() { const j = await get('https://www.bitstamp.net/api/v2/ticker/btceur/'); return eurToNano(j.last); } },
    { name: 'blockchain.info', async read() { const j = await get('https://blockchain.info/ticker'); return eurToNano(j.EUR.last); } },
  ];
}

/**
 * Read the sources and produce the rate an epoch would seal.
 *
 * Returns
 *
 *   { eurPerBtcNano, at, epoch, sources: [{ name, eurPerBtcNano | null, error }],
 *     answered, quorum, median, clamped, prevEurPerBtcNano }
 *
 * and refuses with ORACLE_STALE when fewer than the quorum answered. The
 * per-source array carries every source that was ASKED, answered or not, because
 * a source that was silent is itself a fact about the read and dropping it would
 * make three-of-five look like three-of-three.
 *
 * `clamped` is true when the median moved further than the parameter allows and
 * the published rate is the bound rather than the observation. It is a field and
 * not a log line: a client showing prices during a clamped epoch should be able
 * to say so, and a reader auditing the block should not have to recompute the
 * median to discover that it was overridden.
 */
export async function readOracle(options = {}) {
  const {
    sources = [],
    prevEurPerBtcNano = null,
    epoch = 0,
    minSources = Number(ORACLE_MIN_SOURCES),
    quorum = Number(ORACLE_QUORUM),
    maxMoveBps = ORACLE_MAX_MOVE_BPS,
    now = Date.now,
    timeoutMs = 8000,
  } = options;

  if (sources.length < minSources) {
    throw fail('ORACLE_STALE', {
      configured: sources.length,
      need: minSources,
      why: 'core/params.mjs requires at least this many independent sources before a median means anything',
    });
  }

  const results = await Promise.allSettled(
    sources.map((s) =>
      Promise.race([
        s.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.()),
      ]),
    ),
  );

  const sealed = [];
  const values = [];
  for (let i = 0; i < sources.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && typeof r.value === 'bigint' && r.value > 0n) {
      sealed.push({ name: sources[i].name, eurPerBtcNano: r.value, error: null });
      values.push(r.value);
    } else {
      const message = r.status === 'rejected' ? String((r.reason && r.reason.message) || r.reason) : 'not a rate';
      sealed.push({ name: sources[i].name, eurPerBtcNano: null, error: message });
    }
  }

  if (values.length < quorum) {
    throw fail('ORACLE_STALE', { answered: values.length, quorum, sources: forWire(sealed) });
  }

  const median = medianNano(values);
  let rate = median;
  let clamped = false;
  if (typeof prevEurPerBtcNano === 'bigint' && prevEurPerBtcNano > 0n) {
    const hi = (prevEurPerBtcNano * (BPS + maxMoveBps)) / BPS;
    const lo = (prevEurPerBtcNano * (BPS - maxMoveBps)) / BPS;
    if (rate > hi) {
      rate = hi;
      clamped = true;
    } else if (rate < lo) {
      rate = lo;
      clamped = true;
    }
  }

  return {
    eurPerBtcNano: rate,
    median,
    clamped,
    prevEurPerBtcNano: typeof prevEurPerBtcNano === 'bigint' ? prevEurPerBtcNano : null,
    at: now(),
    epoch,
    answered: values.length,
    quorum,
    minSources,
    maxMoveBps,
    sources: sealed,
  };
}

function forWire(sealed) {
  return sealed.map((s) => ({
    name: s.name,
    eurPerBtcNano: s.eurPerBtcNano === null ? null : s.eurPerBtcNano.toString(),
    error: s.error,
  }));
}

// ── the producer key ───────────────────────────────────────────────────────
//
// ARCHITECTURE §9 signs a block with an Ed25519 producer key, and §3 asks the
// same key to sign the published rate. It is not a wallet and it holds no money:
// it can attest what this host observed and it can do nothing else. A host that
// showed a different rate for a closed epoch contradicts its own signature, and
// that is the entire job.
//
// server/chain/keys.mjs is the chain part's file and will own this when it
// lands. Until then the key is loaded or created here, and the two must end up
// reading the same file rather than each keeping their own.

/** Load the producer key from `dir`, creating one on first run. */
export async function producerKey({ dir, file = 'producer.ed25519.pem' } = {}) {
  const path = resolve(join(dir, file));
  await mkdir(dirname(path), { recursive: true });
  let pem;
  try {
    pem = await readFile(path, 'utf8');
  } catch {
    const { privateKey } = generateKeyPairSync('ed25519');
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(path, pem, { mode: 0o600 });
  }
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv);
  return {
    path,
    publicKeyHex: pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    /** Sign a value's canonical bytes. The value is what is signed, not a
     * rendering of it, so a verifier re-encodes and does not have to receive a
     * byte string it cannot check against the fields it was shown. */
    sign(value) {
      return edSign(null, canonicalBytes(value), priv).toString('hex');
    },
    verify(value, sigHex) {
      try {
        return edVerify(null, canonicalBytes(value), pub, Buffer.from(sigHex, 'hex'));
      } catch {
        return false;
      }
    },
  };
}

/**
 * The signed document GET /api/v1/oracle answers with.
 *
 * The signature covers the whole reading — the rate, the instant, the epoch and
 * every source's own value — so a host cannot later claim it published a
 * different number for a closed epoch, and cannot quietly drop the source that
 * disagreed.
 */
export function sealOracle(reading, key) {
  const body = {
    eurPerBtcNano: reading.eurPerBtcNano.toString(),
    median: reading.median.toString(),
    clamped: reading.clamped,
    at: reading.at,
    epoch: reading.epoch,
    answered: reading.answered,
    quorum: reading.quorum,
    minSources: reading.minSources,
    sources: forWire(reading.sources),
  };
  return {
    ...body,
    producer: key ? key.publicKeyHex : null,
    sig: key ? key.sign(body) : null,
  };
}
