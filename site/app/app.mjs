// The client. It is the same rulebook the writer runs, with a screen attached.
//
// ARCHITECTURE rule 2: the server, the browser and the chain builder run the
// SAME file. This module imports core/replay.mjs and core/pricing.mjs unmodified
// and validates every act with `actError` BEFORE offering the control that would
// send it, so a refusal reads the identical sentence in both places — it comes
// from the same line of code and the same catalogue. Nothing here re-derives a
// rule, and nothing here holds an economic number that core/params.mjs exports.
//
// ── HOW THE SCREEN GETS ITS NUMBERS ────────────────────────────────────────
//
// It replays the log. Rule 1 says every number is a pure function of the act
// log, so the client fetches the acts, runs `replay`, and renders the world it
// gets — balances, feeds, earnings, the pool, the sealed rate, all of it. There
// is no second source and no server-computed view to disagree with. When no host
// answers, the same function runs over the published archive and the app says it
// is read-only rather than waiting out a dead address.
//
// ── THE METER IS THE PRODUCT ───────────────────────────────────────────────
//
// This network bills per impression. ARCHITECTURE §11: a network that bills per
// impression and hides the running total is a trap. So the price of every action
// is on the control that takes it, before it is taken, and the session total is
// written to every mirror of it in one pass — including the spoken one — every
// time it moves.
//
// The billable view is this file's own responsibility and the one place where
// the client can quietly cost somebody money. The rule is in core/params.mjs and
// the machine that enforces it is `createViewMeter` below: viewport share, a
// continuous dwell, a fling gate, the per-pair cooldown and the per-epoch cap. A
// fast scroll bills nothing, and there is a test that fires a fling at it and
// asserts zero.
//
// ── STRUCTURE ──────────────────────────────────────────────────────────────
//
// Everything above `boot()` is pure and exported, so it can be tested without a
// browser: the view machine, the session ledger, the money parsers, the swap
// preview and the feed ranking. `boot()` is the only part that touches the DOM,
// and it runs only when there is a document to touch.

import { PARAMS, BPS, WAD, NANO_EUR_PER_EUR } from '../core/params.mjs';
import { parseCanonical } from '../core/canonical.mjs';
import {
  actError,
  applyAct,
  emptyWorld,
  replay,
  EDITION,
  MAX_COMMENT_CHARS,
  MAX_PAYLOAD_BYTES,
  BYTES_PER_MB,
  SHARD_BYTES,
} from '../core/replay.mjs';
import {
  actionPriceNanoEur,
  formatEur,
  priceOf,
  ptpWeiToNanoEur,
  nanoEurToSubSat,
} from '../core/pricing.mjs';
import { quote } from '../core/amm.mjs';
import { refuse } from '../core/errors.mjs';
import { VERSION as RULES_VERSION } from '../core/rules/v1.mjs';
import { createWallet, idbKeyStore, LOCAL_KEY_WARNING, toHex } from './wallet.mjs';
import { createDataSpace, shardRangeOf } from './storage.mjs';

// ── constants this file states, and why they are not in params ─────────────
//
// core/params.mjs owns every number that decides who gets paid. These three
// decide when a browser is allowed to believe its own eyes, which is a property
// of scrolling and not of the economy: they can only ever make the client bill
// LESS often than the rule permits, never more, so no economic property depends
// on their value.

/**
 * A scroll faster than one and a half viewport heights a second is a fling, and
 * a fling bills nothing.
 *
 * Measured in viewport heights rather than pixels so a phone and a desktop mean
 * the same thing by it. The geometry alone almost stops a fling from billing —
 * holding 60% of a picture for 1500 ms while travelling means moving less than a
 * third of a screen in that time — but almost is not a guarantee: an
 * IntersectionObserver coalesces callbacks under load, and a frame budget blown
 * by a decode can hide the moment the picture left. The velocity gate is the
 * part that does not depend on the browser having kept up.
 */
export const FLING_VIEWPORTS_PER_SEC = 1.5;

/**
 * A gap longer than this between two ticks means the client stopped watching —
 * a background tab, a locked phone, a debugger. Every running dwell is restarted
 * rather than credited with the time nobody was looking.
 *
 * Without it, a tab left open on a picture and returned to an hour later bills
 * instantly, which is the exact opposite of what the dwell rule is for.
 */
export const MAX_TICK_GAP_MS = 500;

/** How many cards are drawn before the end sentinel asks for more. The whole log
 * is already in memory; this is about how much DOM exists at once, which is what
 * a 60 fps scroll actually costs. */
export const PAGE_SIZE = 12;

// ── money in and out of the interface ──────────────────────────────────────
//
// Everything below is BigInt. A euro typed into a field becomes an integer
// nanoeuro before anything is computed with it, and a wei balance becomes a
// string only at the moment it is written into a node. No Number() ever touches
// a balance — a wei quantity past 2^53 read as a double is a different quantity,
// and the screen is the last place that mistake is still cheap to catch.

/**
 * A euro amount as the user typed it, as an integer nanoeuro.
 *
 * Accepts a comma or a point as the separator and ignores the spaces and the
 * sign that `formatEur` puts in, so the string this app printed can be typed
 * straight back into it. More than nine fractional digits is refused rather than
 * rounded: the unit of account is the nanoeuro, and silently dropping a digit
 * from a price is how a poster ends up charging a tenth of what they meant to.
 */
export function parseEurToNano(text) {
  const s = String(text)
    .trim()
    .replace(/[\s  €]/g, '')
    .replace(',', '.');
  if (s === '' || s === '.' || !/^\d*(\.\d*)?$/.test(s)) throw new Error('BAD_AMOUNT');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 9) throw new Error('BAD_AMOUNT');
  return BigInt(whole || '0') * NANO_EUR_PER_EUR + BigInt(frac.padEnd(9, '0') || '0');
}

/** A decimal amount as the user typed it, in the smallest unit of a token with
 * this many decimals. Satoshi is 0 decimals, PTP wei is 18. */
export function parseUnits(text, decimals) {
  const s = String(text).trim().replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '' || s === '.' || !/^\d*(\.\d*)?$/.test(s)) throw new Error('BAD_AMOUNT');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error('BAD_AMOUNT');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * A smallest-unit quantity as a decimal string, for a node carrying class "num".
 *
 * Integer arithmetic throughout: the whole part and the fraction are separate
 * BigInt divisions, and the fraction is trimmed as a string. `maxFrac` shortens
 * the display and never the value — a balance is never rounded into a variable,
 * only into a node.
 */
export function formatUnits(value, decimals, maxFrac = decimals) {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  let frac = (v % unit).toString(10).padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const groups = whole.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}${groups}${frac ? '.' + frac : ''}`;
}

/** A whole count as a decimal string. Numbers here are counts, never money. */
export function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function shortAddress(addr) {
  return typeof addr === 'string' && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : String(addr || '');
}

/**
 * How long is left, in words, from one instant to another.
 *
 * The text is for people and is allowed to be relative; the absolute instant
 * always travels beside it in `data-ends` or `data-at`, written in the same
 * operation, so the two channels cannot drift (see the hook contract, "dates and
 * timestamps").
 */
export function relativeTime(target, now) {
  const ms = target - now;
  const past = ms < 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const hour = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let unit;
  if (abs < 60000) unit = 'less than a minute';
  else if (min < 60) unit = `${min} minute${min === 1 ? '' : 's'}`;
  else if (hour < 48) unit = `${hour} hour${hour === 1 ? '' : 's'}`;
  else unit = `${day} days`;
  return past ? `${unit} ago` : `${unit} left`;
}

export function clockTime(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── the billable view ──────────────────────────────────────────────────────

/**
 * The machine that decides whether looking at a picture cost anything.
 *
 * ARCHITECTURE §4 defines a billable impression as all four of: the post
 * occupied the viewport share, for the dwell, with the cooldown elapsed since
 * the last billable view of the same (viewer, post) pair, and the pair below its
 * per-epoch cap. Three of those four are in core/params.mjs and are read from
 * there. The fourth — that a fling is not a look — is this file's, above.
 *
 * The machine is fed events and asked for time; it reads no clock of its own, so
 * a test can drive it with synthetic intersections and stamps and get exactly
 * what a phone would get. `tick` is where everything is decided, because a dwell
 * that is only checked when a callback happens to fire is a dwell that measures
 * the browser's scheduling rather than the user's attention.
 *
 * WHAT THE VIEWPORT SHARE MEANS HERE, because the two obvious readings disagree
 * on a phone. ARCHITECTURE §4 says "the post occupied ≥ 60% of the viewport";
 * the ordinary impression rule is "60% of the post was on screen". On a 390×844
 * phone a full-bleed 4:5 picture covers 57.7% of the viewport when it is
 * COMPLETELY visible, so the first reading alone would make almost every view in
 * the network unbillable and the whole calibrated day in docs/ECONOMICS.md
 * unreachable. So the share is measured against whichever is smaller, the
 * picture or the viewport:
 *
 *   vp = intersection area / min(picture area, viewport area)
 *
 * — "sixty percent of as much of it as could possibly be shown was shown". It
 * never exceeds either reading, and for a picture taller than the screen it IS
 * the viewport reading. The ambiguity is real and it is recorded here rather
 * than resolved silently.
 *
 * The pair ledger is seeded from the world, so the cooldown and the cap the
 * client enforces are the ones replay already recorded. It is a copy and it is
 * not the authority: every view act still goes through `actError` before it is
 * signed, so a stale copy costs an unnecessary refusal and never an unbilled
 * charge or an unexpected one.
 */
export function createViewMeter(options = {}) {
  const params = options.params || PARAMS;
  const minPct = Number(params.viewMinViewportPct);
  const dwellMs = Number(params.viewDwellMs);
  const cooldownMs = Number(params.viewCooldownSec) * 1000;
  const cap = params.maxViewsPerPairPerEpoch;
  let flingPxPerSec = (options.viewportPx || 800) * FLING_VIEWPORTS_PER_SEC;

  const runs = new Map(); // pid -> { pct, since, spent }
  const pairs = new Map(); // pid -> { at, n, epoch } — the client's copy of world.views
  let epoch = 0;
  let scrollAt = 0;
  let scrollY = 0;
  let quietUntil = 0;
  let lastTick = 0;

  function setViewport(px) {
    if (px > 0) flingPxPerSec = px * FLING_VIEWPORTS_PER_SEC;
  }

  /** Read the pair ledger for this viewer out of a replayed world. */
  function seed(world, address) {
    pairs.clear();
    epoch = world.epoch.n;
    if (!address) return;
    const prefix = `${address}|`;
    for (const key of Object.keys(world.views)) {
      if (!key.startsWith(prefix)) continue;
      pairs.set(key.slice(prefix.length), world.views[key]);
    }
  }

  /** Why this pair cannot be billed right now, or null. The same two limits
   * core/replay.mjs applies, read from the same parameters. */
  function blocked(pid, at) {
    const st = pairs.get(pid);
    if (!st) return null;
    if (at - st.at < cooldownMs) return 'VIEW_TOO_SOON';
    const n = st.epoch === epoch ? st.n : 0;
    if (BigInt(n) >= cap) return 'VIEW_PAIR_CAP';
    return null;
  }

  /** Record a view that was actually accepted, so the next one is judged against
   * it without waiting for a round trip. */
  function note(pid, at) {
    const st = pairs.get(pid);
    const n = st && st.epoch === epoch ? st.n : 0;
    pairs.set(pid, { at, n: n + 1, epoch, viewed: true, liked: Boolean(st && st.liked) });
  }

  function intersect(pid, pct) {
    const run = runs.get(pid) || { pct: 0, since: null, spent: false };
    run.pct = pct;
    if (pct < minPct) {
      // Leaving the threshold ends the dwell AND clears the spent flag, so the
      // next genuine arrival is a fresh impression rather than a suppressed one.
      run.since = null;
      run.spent = false;
    }
    runs.set(pid, run);
  }

  function forget(pid) {
    runs.delete(pid);
  }

  /** A scroll sample. Velocity is computed here rather than taken on trust,
   * because the only honest source for "how fast is this moving" is two
   * positions and the time between them. */
  function scroll(y, at) {
    if (scrollAt !== 0 && at > scrollAt) {
      const v = (Math.abs(y - scrollY) * 1000) / (at - scrollAt);
      if (v >= flingPxPerSec) quietUntil = at + dwellMs;
    }
    scrollY = y;
    scrollAt = at;
  }

  /** The tab stopped being watched. Every dwell restarts. */
  function blur(at) {
    for (const run of runs.values()) run.since = null;
    quietUntil = at;
  }

  /**
   * Advance to `at` and return the views that became billable, if any.
   *
   * A completed dwell is marked spent whether or not it was billable, so one
   * continuous look produces at most one attempt. A look blocked by the cooldown
   * therefore does not retry every frame for fifteen minutes; the user has to
   * look away and back, which is the conservative direction — it bills less
   * often than the rule allows and never more.
   */
  function tick(at) {
    const out = [];
    const gap = lastTick === 0 ? 0 : at - lastTick;
    lastTick = at;
    const flinging = at < quietUntil;
    const discontinuous = gap > MAX_TICK_GAP_MS;
    for (const [pid, run] of runs) {
      if (run.pct < minPct) continue;
      if (flinging || discontinuous) {
        run.since = null;
        continue;
      }
      if (run.since === null) {
        run.since = at;
        continue;
      }
      if (run.spent) continue;
      const dwelt = at - run.since;
      if (dwelt < dwellMs) continue;
      run.spent = true;
      if (blocked(pid, at)) continue;
      out.push({ pid, dwellMs: dwelt, vp: Math.max(0, Math.min(100, Math.round(run.pct))) });
      note(pid, at);
    }
    return out;
  }

  /** How far through the billable dwell this picture is, 0…1, for the hairline
   * that warns the user an impression is being counted. A float, and it moves no
   * money. */
  function progress(pid, at) {
    const run = runs.get(pid);
    if (!run || run.since === null || run.pct < minPct || run.spent) return 0;
    if (at < quietUntil) return 0;
    return Math.max(0, Math.min(1, (at - run.since) / dwellMs));
  }

  return {
    seed,
    setViewport,
    intersect,
    forget,
    scroll,
    blur,
    tick,
    progress,
    blocked,
    note,
    setEpoch(n) {
      epoch = n;
    },
    get pairs() {
      return pairs;
    },
  };
}

// ── the session ledger ─────────────────────────────────────────────────────

/**
 * What this session has cost, itemised, in integer nanoeuros.
 *
 * It counts what was BILLED — an act the writer accepted — and not what was
 * quoted, because a quote that was refused cost nothing and a meter that
 * disagrees with the balance is worse than no meter. It resets when the app
 * does, which is what "session" means on the header.
 */
export function createSession() {
  let total = 0n;
  const rows = [];
  return {
    add(what, nanoEur) {
      if (typeof nanoEur !== 'bigint') throw new Error('BAD_AMOUNT');
      total += nanoEur;
      const last = rows[rows.length - 1];
      if (last && last.what === what) {
        last.nanoEur += nanoEur;
        last.n += 1;
      } else {
        rows.push({ what, nanoEur, n: 1 });
      }
      return total;
    },
    get total() {
      return total;
    },
    get rows() {
      return rows.slice();
    },
  };
}

// ── prices, before anything is spent ───────────────────────────────────────

/** What one engagement with this post costs, in nanoeuros and in wei, at the
 * epoch's sealed rate. Both numbers come from core/pricing.mjs; this only names
 * them together so a caller cannot show one and charge the other. */
export function engagementPrice(post, kind, world) {
  const nanoEur = actionPriceNanoEur(post.viewPriceNano, kind, world.constants);
  return { kind, ...priceOf(nanoEur, world.epoch.oracle) };
}

/**
 * Every line of what publishing costs, before it is sent.
 *
 * The rent formula is core/replay.mjs's: bytes × replication × days at the
 * tariff, rounded UP, over a decimal megabyte. It is restated here because the
 * composer has to show the number before an act exists to be validated, and a
 * receipt that disagreed with the charge would be a lie told politely. The
 * ceiling division is the same one, in the same direction, for the same reason:
 * every charge rounds up so the dust lands where no account can claim it.
 */
export function publishReceipt({ bytes, days, world, held = 0n }) {
  const params = world.constants;
  const rate = world.epoch.oracle;
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const feeNano = params.publishBaseFeeNanoEur;
  const rentNano = ceilDiv(
    BigInt(bytes) * BigInt(days) * params.replication * params.storageRentNanoEurPerMbDay,
    BYTES_PER_MB,
  );
  const capUnits = ceilDiv(BigInt(bytes) * BigInt(days) * params.replication * params.capCoinPerMbDay, BYTES_PER_MB);
  const fee = priceOf(feeNano, rate);
  const rent = priceOf(rentNano, rate);
  return {
    feeNano,
    rentNano,
    totalNano: feeNano + rentNano,
    fee,
    rent,
    totalWei: fee.wei + rent.wei,
    dust: fee.dust || rent.dust,
    capUnits,
    capHeld: held,
    capShort: held < capUnits ? capUnits - held : 0n,
    mb: Number(bytes) / Number(BYTES_PER_MB),
    replication: params.replication,
  };
}

/**
 * A swap, priced exactly as the pool would fill it, with the worst fill the user
 * has agreed to accept.
 *
 * ARCHITECTURE §2: every swap carries `minOut`, and a fill at a price the screen
 * never showed is refused rather than executed. So the screen has to show it, and
 * `minOut` is computed from the quote the user is looking at — not from a fresh
 * one at submit time, which would be the same defect wearing a helpful face.
 */
export function swapPreview(pool, side, amountIn, slippageBps, params = PARAMS) {
  const q = quote(pool, side, amountIn, params.swapFeeBps);
  const minOut = (q.out * (BPS - BigInt(slippageBps))) / BPS;
  const poolFee = (amountIn * params.swapFeeBps) / BPS;
  // Sat per whole PTP, in both directions, so the two sides of the market are
  // quoted in one unit and a user can compare them.
  const satPerPtp = side === 'btc' ? (q.out === 0n ? 0n : (amountIn * WAD) / q.out) : (q.out * WAD) / amountIn;
  return { out: q.out, minOut, impactBps: q.priceImpactBps, poolFee, satPerPtp, newPool: q.newPool };
}

// ── the feed ───────────────────────────────────────────────────────────────

/**
 * How a picture is ranked, and — more importantly — what is not allowed in here.
 *
 * ARCHITECTURE rule 5: money never buys reach. No balance enters this score. Not
 * the author's PTP, not their satoshis, not their CAP, not the post's credit, not
 * what it earned, not what it cost to look at. A poster who prices at the ceiling
 * and a poster who prices at the floor rank identically for identical attention,
 * which is the entire point of having the rule written down.
 *
 * What is allowed is attention itself and recency. Breadth beats depth here —
 * this is exactly where docs/ECONOMICS.md says the per-pair damping and the
 * repeat decay belong, because in the feed they shape attention and move no
 * money, and in the distribution weight they would pay a farm for splitting.
 * Floats are fine for the same reason: nothing this function returns is ever
 * added to a balance.
 */
export function rankScore(post, now, seenByMe = 0) {
  const ageHours = Math.max(0, (now - post.created) / 3600000);
  const freshness = 1 / (1 + ageHours / 6);
  const breadth = Math.log1p(post.uniqueViewers) + 0.5 * Math.log1p(post.likes) + 0.75 * Math.log1p(post.comments);
  // The viewer's own repeats damp their own feed and nobody else's.
  const damping = 1 / (1 + 0.35 * seenByMe);
  return freshness * (1 + breadth) * damping;
}

/** The live posts, best first. A settled post has had its picture deleted from
 * every device, so it is not in the feed; it is still reachable by its own id. */
export function feedOrder(world, now, { author = null, seen = null } = {}) {
  const out = [];
  for (const pid of Object.keys(world.posts)) {
    const post = world.posts[pid];
    if (post.state !== 'live' || now >= post.expires) continue;
    if (author && post.author !== author) continue;
    const mine = seen && seen.get(pid) ? seen.get(pid).n || 0 : 0;
    out.push({ pid, post, score: rankScore(post, now, mine) });
  }
  out.sort((a, b) => (b.score === a.score ? (a.pid < b.pid ? 1 : -1) : b.score - a.score));
  return out;
}

// ── the act, before it is signed ───────────────────────────────────────────

/**
 * Stamp an act the way the writer would, then ask the rulebook what is wrong
 * with it.
 *
 * The stamp is clamped to the last act in the log, and that is not a fudge: the
 * writer assigns the real `t` on acceptance, and a client whose clock is a few
 * seconds behind the last accepted act would otherwise refuse its own act with
 * TIMESTAMP_IMPLAUSIBLE — a refusal about a wristwatch, shown to a user who did
 * nothing wrong. Every other field is exactly what will be sent.
 */
export function prepareAct(world, address, act, now) {
  return { ...act, as: address, t: Math.max(now, world.log.lastAt) };
}

/** null when the act would be accepted, or the refusal with all four fields.
 * This is the whole of "the button is offered when actError returns null". */
export function checkAct(world, address, act, now) {
  if (!address) return refuse('BAD_ADDRESS', { as: null });
  return actError(world, prepareAct(world, address, act, now));
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SCREEN
// Everything below touches the DOM. It obeys the hook contract at the bottom of
// index.html literally: ids and classes from that list and nothing else, the
// `hidden` attribute for views, showModal() for sheets, a pre-filled toast clone
// for every refusal, and --ar on every frame before a src.
// ═══════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);
const ACTS_PATH = '/api/v1/acts';
const ACT_PATH = '/api/v1/act';
const MEDIA_PATH = '/api/v1/media';

export async function boot() {
  const state = {
    base: null,
    readOnly: true,
    world: emptyWorld(PARAMS),
    acts: [],
    page: PAGE_SIZE,
    view: 'feed',
    pid: null,
    author: null,
    file: null,
    stale: false,
  };

  const session = createSession();
  const meter = createViewMeter({ params: PARAMS, viewportPx: window.innerHeight });
  const wallet = createWallet({ store: idbKeyStore() });
  const space = createDataSpace({ params: PARAMS });
  const frames = new Map(); // element -> pid
  const cards = new Map(); // pid -> element
  let ticking = false;
  let waiting = null; // a service worker that has installed and is waiting to take over

  // ── refusals ─────────────────────────────────────────────────────────────
  // Build, fill, and only then insert. The insertion is the mutation a live
  // region observes; filling a region that is not yet in the accessibility tree
  // and revealing it afterwards is the silent path, and it is the defect the
  // shell's four empty slots exist to make impossible.

  function toastFor(refusal) {
    const frag = $('tpl-toast').content.cloneNode(true);
    const toast = frag.querySelector('.toast');
    toast.querySelector('.toast__code').textContent = refusal.code;
    toast.querySelector('.toast__msg').textContent = refusal.msg;
    toast.querySelector('.toast__next').textContent = refusal.next;
    return toast;
  }

  function showRefusal(refusal, slotId) {
    const node = toastFor(refusal);
    if (slotId && $(slotId)) $(slotId).replaceChildren(node);
    else $('toasts').append(node);
    return null;
  }

  function clearSlot(slotId) {
    const slot = $(slotId);
    if (slot) slot.replaceChildren();
  }

  function asRefusal(err) {
    const code = err && typeof err.message === 'string' ? err.message.split(':')[0] : 'BAD_REQUEST';
    return refuse(code, null);
  }

  // ── busy ─────────────────────────────────────────────────────────────────
  // Presence is the state, so data-busy is set to the empty string and REMOVED
  // when the act resolves. `disabled` goes on and comes off with it, so a second
  // press cannot resend an act that spends money.

  function setBusy(el, busy) {
    if (!el) return;
    if (busy) {
      el.setAttribute('data-busy', '');
      el.disabled = true;
    } else {
      el.removeAttribute('data-busy');
      el.disabled = false;
    }
  }

  /** A control that would be refused stays reachable and says why when pressed.
   * `disabled` would hide the explanation from the person who needs it. */
  function markRefusal(el, refusal) {
    if (!el) return;
    if (refusal) {
      el.setAttribute('aria-disabled', 'true');
      el.dataset.refusal = refusal.code;
    } else {
      el.removeAttribute('aria-disabled');
      delete el.dataset.refusal;
    }
  }

  // ── the meter ────────────────────────────────────────────────────────────

  let painted = null;

  function paintSession() {
    const text = formatEur(session.total);
    // Every mirror in one pass, queried by class. A per-id update is how one
    // surface goes quietly stale, and a stale meter is the same trap as no meter.
    for (const node of document.querySelectorAll('.session-total')) node.textContent = text;
    if (painted !== null && painted !== text) {
      const value = $('meter-value');
      // The blink is for a change. The class comes off, a layout read flushes it,
      // and it goes back on — a CSS animation does not restart while its class is
      // still on the element, so a second change would not blink.
      value.classList.remove('is-ticked');
      void value.offsetWidth;
      value.classList.add('is-ticked');
    }
    painted = text;
    paintSpend();
  }

  function paintSpend() {
    const list = $('spend-list');
    const rows = session.rows;
    list.replaceChildren();
    for (const row of rows) {
      const frag = $('tpl-spend-row').content.cloneNode(true);
      const li = frag.querySelector('.spend-row');
      li.querySelector('.spend-row__what').textContent = row.n > 1 ? `${row.what} ×${row.n}` : row.what;
      li.querySelector('.spend-row__amount').textContent = formatEur(row.nanoEur);
      list.append(li);
    }
    $('spend-empty').hidden = rows.length > 0;
  }

  // ── the banner ───────────────────────────────────────────────────────────
  // Reveal first, write second: role="status" announces a mutation it observes
  // while it is in the tree, and [hidden] keeps it out of the tree entirely.

  function banner(text) {
    const el = $('app-banner');
    if (!text) {
      el.hidden = true;
      $('app-banner-text').textContent = '';
      return;
    }
    el.hidden = false;
    $('app-banner-text').textContent = text;
  }

  // ── dates ────────────────────────────────────────────────────────────────
  // The attribute, the text and the state are written in one operation, always.
  // "loading" never survives a write.

  function setEnds(el, at, settled) {
    if (!el) return;
    el.dataset.ends = new Date(at).toISOString();
    el.textContent = settled ? 'settled' : relativeTime(at, Date.now());
    el.dataset.state = settled ? 'settled' : 'live';
  }

  function setAt(el, at) {
    if (!el) return;
    el.dataset.at = new Date(at).toISOString();
    el.textContent = clockTime(at);
    el.dataset.state = 'posted';
  }

  // ── the record ───────────────────────────────────────────────────────────

  /**
   * The address book, published beside the app and rewritten every fifteen
   * minutes by a job on machines nobody here owns. When it names no host it is
   * saying so on purpose: the app reads the published archive and runs read-only
   * rather than waiting out a timeout on a dead address.
   */
  async function addressBook() {
    for (const path of ['./host.json', '../host.json']) {
      try {
        const r = await fetch(path, { cache: 'no-cache' });
        if (!r.ok) continue;
        const book = await r.json();
        const urls = [book.url, ...(Array.isArray(book.urls) ? book.urls : []), ...(Array.isArray(book.candidates) ? book.candidates : [])];
        for (const url of urls) {
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url.replace(/\/+$/, '');
        }
        return null;
      } catch {
        /* the next path, then the archive */
      }
    }
    return null;
  }

  function parseActs(text, contentType) {
    const body = String(text).trim();
    if (!body) return [];
    if ((contentType || '').includes('json') && !body.includes('\n{')) {
      const parsed = parseCanonical(body);
      if (Array.isArray(parsed)) return parsed;
      for (const key of ['acts', 'rows', 'items', 'log']) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
      return [];
    }
    const out = [];
    for (const line of body.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        // parseCanonical, never JSON.parse — the browser is a reader of the
        // same canonical log the host writes, and a reader that does not decode
        // the sigil can only read something that LOOKS like one. See
        // core/canonical.mjs.
        out.push(parseCanonical(s));
      } catch {
        // A corrupt line is skipped and counted, never fatal: one bad line must
        // not stop every reader of the log at the same place.
      }
    }
    return out;
  }

  async function loadActs() {
    const attempts = [];
    if (state.base) attempts.push(state.base + ACTS_PATH);
    attempts.push('./archive/acts.jsonl', '../data/acts.jsonl');
    for (const url of attempts) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json, text/plain' } });
        if (!r.ok) continue;
        if (r.headers.get('x-ptp-stale') === '1') state.stale = true;
        const text = await r.text();
        return { acts: parseActs(text, r.headers.get('content-type')), from: url };
      } catch {
        /* try the next */
      }
    }
    return { acts: [], from: null };
  }

  /**
   * The keyless output reserve is destroyed at, from the host's own
   * self-describing contract.
   *
   * It is not in core/params.mjs and it should not be: the address is a
   * deployment's, not the economy's. When no host will name one the form says so
   * rather than showing an em dash — an address the app invented would be an
   * instruction to destroy bitcoin at a place nobody chose.
   */
  async function loadBurnAddress() {
    const node = $('burn-address');
    if (!state.base) {
      node.textContent = 'No host is answering, so no burn address can be shown.';
      return;
    }
    try {
      const r = await fetch(state.base + '/api/v1', { headers: { accept: 'application/json' } });
      const body = await r.json();
      for (const key of ['burnAddress', 'burn', 'keylessAddress', 'burnTo']) {
        const value = body && (body[key] || (body.chain && body.chain[key]) || (body.params && body.params[key]));
        if (typeof value === 'string' && value.length > 0) {
          node.textContent = value;
          return;
        }
      }
      node.textContent = 'This host publishes no burn address at /api/v1. Nothing can be claimed until it does.';
    } catch {
      node.textContent = 'The host could not be asked for the burn address.';
    }
  }

  async function refresh() {
    $('feed').setAttribute('aria-busy', 'true');
    state.stale = false;
    state.base = await addressBook();
    await loadBurnAddress();
    const { acts, from } = await loadActs();
    state.acts = acts;
    state.world = replay(acts, PARAMS);
    state.readOnly = !state.base;
    meter.seed(state.world, wallet.address);
    space.setNodeId(wallet.address);
    if (!from) banner('No host answered and no archive is stored beside this app, so there is nothing to read yet.');
    else if (state.readOnly) banner('No host is answering. This is the published archive, read-only — nothing can be sent.');
    else if (state.stale) banner('The writer could not be reached; these numbers came from this device’s cache.');
    else banner(null);
    render();
    $('feed').setAttribute('aria-busy', 'false');
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Validate, sign, send, and fold the answer back into the local world.
   *
   * `actError` runs FIRST, over the same world the writer will validate against,
   * so a refusal is shown before a wallet is ever asked to sign — and it is the
   * writer's own sentence, from the same catalogue, because it came from the same
   * function.
   */
  async function send(act, { slot, button, what, nanoEur } = {}) {
    if (slot) clearSlot(slot);
    if (state.readOnly) {
      return showRefusal(refuse('NOT_THE_WRITER', { readOnly: true }), slot);
    }
    if (!wallet.address) {
      return showRefusal(refuse('BAD_ADDRESS', { as: null }), slot);
    }
    const stamped = prepareAct(state.world, wallet.address, act, Date.now());
    const problem = actError(state.world, stamped);
    if (problem) return showRefusal(problem, slot);

    setBusy(button, true);
    try {
      const signed = await wallet.signAct(stamped);
      const res = await fetch(state.base + ACT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || (body && body.ok === false)) {
        return showRefusal(
          body && body.code ? body : refuse('BAD_REQUEST', { status: res.status }),
          slot,
        );
      }
      // The writer's answer is authoritative about the two fields it assigns —
      // the index and the stamp. When it answers with the whole accepted act,
      // that act is what lands in the local world; when it answers with only an
      // acknowledgement, the body that was sent is. A missing index is REMOVED
      // rather than carried as undefined, because the envelope check reads the
      // key's presence and `i: undefined` is a malformed act, not an absent one.
      let accepted;
      if (body && body.act) {
        accepted = body.act;
      } else {
        accepted = { ...signed };
        if (body && Number.isSafeInteger(body.i)) accepted.i = body.i;
        if (body && Number.isSafeInteger(body.t)) accepted.t = body.t;
      }
      const applied = applyAct(state.world, accepted);
      if (applied.ok) {
        state.acts.push(accepted);
      } else {
        // The writer accepted something this world does not reproduce, which
        // means this world is behind. Refetch rather than render a fiction.
        await refresh();
      }
      if (what && typeof nanoEur === 'bigint') {
        session.add(what, nanoEur);
        paintSession();
      }
      meter.seed(state.world, wallet.address);
      render();
      return accepted;
    } catch (err) {
      return showRefusal(asRefusal(err), slot);
    } finally {
      setBusy(button, false);
    }
  }

  // ── views and sheets ─────────────────────────────────────────────────────

  function showView(name) {
    state.view = name;
    $('view-feed').hidden = name !== 'feed';
    $('view-post').hidden = name !== 'post';
    for (const [id, active] of [['nav-feed', true], ['nav-compose', false], ['nav-wallet', false]]) {
      if (active) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
    // Focus follows the view, or a keyboard lands nowhere and a screen reader
    // keeps reading the view that just left.
    $('main').focus();
  }

  function openSheet(id) {
    const dialog = $(id);
    if (dialog && !dialog.open) dialog.showModal();
  }

  // ── the feed ─────────────────────────────────────────────────────────────

  function mediaUrl(post) {
    if (!state.base) return null;
    // sw.js refuses to cache a picture without its expiry, refuses one already
    // expired, and evicts on expiry. The parameter is not decoration.
    return `${state.base}/media/${post.cid}?exp=${post.expires}`;
  }

  function authorLabel(addr) {
    const account = state.world.accounts[addr];
    return account && account.handle ? '@' + account.handle : shortAddress(addr);
  }

  function paintCard(pid, post, index, total) {
    let card = cards.get(pid);
    if (!card) {
      const frag = $('tpl-card').content.cloneNode(true);
      card = frag.querySelector('.card');
      card.dataset.pid = pid;
      const author = card.querySelector('.card__author');
      author.id = `author-${pid}`;
      card.setAttribute('aria-labelledby', author.id);
      const frame = card.querySelector('.card__frame');
      // --ar from the act, before a byte is fetched. This is the whole of the
      // no-layout-shift promise and it costs one custom property.
      frame.style.setProperty('--ar', `${post.w} / ${post.h}`);
      const img = card.querySelector('.card__img');
      img.width = post.w;
      img.height = post.h;
      img.alt = `Picture published by ${authorLabel(post.author)}`;
      const url = mediaUrl(post);
      if (post.redacted) frame.dataset.redacted = '1';
      else if (url) img.src = url;
      frames.set(frame, pid);
      cards.set(pid, card);
      observer.observe(frame);
    }
    card.setAttribute('aria-setsize', String(total));
    card.setAttribute('aria-posinset', String(index + 1));
    // A card first drawn while no host answered has no picture. When one starts
    // answering the frame is already the right shape and only the bytes are
    // missing, so the src is filled in on the next paint rather than on a reload.
    const img0 = card.querySelector('.card__img');
    if (!post.redacted && !img0.getAttribute('src')) {
      const url0 = mediaUrl(post);
      if (url0) img0.src = url0;
    }
    card.querySelector('.card__author').textContent = authorLabel(post.author);
    card.querySelector('.card__addr').textContent = shortAddress(post.author);
    const priced = priceOf(post.viewPriceNano, state.world.epoch.oracle);
    const price = card.querySelector('.card__price');
    price.textContent = formatEur(post.viewPriceNano);
    price.dataset.dust = priced.dust ? '1' : '0';
    card.querySelector('.card__like-count').textContent = formatCount(post.likes);
    card.querySelector('.card__comment-count').textContent = formatCount(post.comments);
    card.querySelector('.card__views').textContent = formatCount(post.views);
    setEnds(card.querySelector('.card__expiry'), post.expires, post.state === 'settled');
    card.querySelector('.card__earned').textContent = formatEur(ptpWeiToNanoEur(post.creditWei, state.world.epoch.oracle));
    const pair = meter.pairs.get(pid);
    const paid = pair && pair.n ? pair.n : 0;
    card.querySelector('.card__paid').textContent = paid ? `you have paid ${formatCount(paid)} view${paid === 1 ? '' : 's'}` : '';
    const like = card.querySelector('.card__like');
    const liked = Boolean(pair && pair.liked);
    like.setAttribute('aria-pressed', liked ? 'true' : 'false');
    markRefusal(like, checkAct(state.world, wallet.address, { k: 'like', pid }, Date.now()));
    return card;
  }

  function render() {
    const now = Date.now();
    const ordered = feedOrder(state.world, now, { author: state.author, seen: meter.pairs });
    const shown = ordered.slice(0, state.page);
    const feed = $('feed');
    const next = [];
    for (const [index, entry] of shown.entries()) {
      next.push(paintCard(entry.pid, entry.post, index, ordered.length));
    }
    for (const [pid, el] of cards) {
      if (!shown.some((e) => e.pid === pid)) {
        const frame = el.querySelector('.card__frame');
        observer.unobserve(frame);
        frames.delete(frame);
        meter.forget(pid);
        cards.delete(pid);
        el.remove();
      }
    }
    // Only rewrite the list when it actually changed. Re-inserting the same
    // nodes in the same order costs a layout and can drop focus, and this runs
    // after every accepted act.
    const same = feed.children.length === next.length && next.every((el, i) => feed.children[i] === el);
    if (!same) feed.replaceChildren(...next);
    $('feed-skeleton').hidden = true;
    $('feed-empty').hidden = ordered.length > 0;
    $('feed-end').hidden = ordered.length === 0 || shown.length < ordered.length;
    $('feed-end').textContent = state.author
      ? `That is everything live from ${authorLabel(state.author)}.`
      : 'That is the whole live record.';
    if (state.view === 'post' && state.pid) paintPost(state.pid);
    paintWallet();
    paintComposer();
  }

  // ── post detail ──────────────────────────────────────────────────────────

  function paintPost(pid) {
    const post = state.world.posts[pid];
    if (!post) return;
    const now = Date.now();
    const settled = post.state === 'settled';
    $('post-author').textContent = authorLabel(post.author);
    $('post-state').textContent = settled ? 'settled' : 'live';
    const frame = $('post-frame');
    frame.style.setProperty('--ar', `${post.w} / ${post.h}`);
    const img = $('post-img');
    img.width = post.w;
    img.height = post.h;
    img.alt = `Picture published by ${authorLabel(post.author)}`;
    if (settled) {
      frame.dataset.redacted = '1';
      img.removeAttribute('src');
    } else {
      const url = mediaUrl(post);
      if (url && img.src !== url) img.src = url;
    }
    $('post-price').textContent = formatEur(post.viewPriceNano);
    $('post-cid').textContent = post.cid;
    setEnds($('post-expiry'), post.expires, settled);
    $('post-likes').textContent = formatCount(post.likes);
    $('post-comments').textContent = formatCount(post.comments);
    $('post-views').textContent = formatCount(post.views);
    $('post-unique').textContent = formatCount(post.uniqueViewers);
    $('post-gross').textContent = formatEur(post.grossNano);
    $('post-credit').textContent = formatEur(ptpWeiToNanoEur(post.creditWei, state.world.epoch.oracle));
    $('post-paid').textContent = formatEur(ptpWeiToNanoEur(post.paidWei, state.world.epoch.oracle));
    $('post-lease').textContent = settled ? 'settled' : relativeTime(post.expires, now);

    const pair = meter.pairs.get(pid);
    $('post-like').setAttribute('aria-pressed', pair && pair.liked ? 'true' : 'false');
    markRefusal($('post-like'), checkAct(state.world, wallet.address, { k: 'like', pid }, now));

    const days = Math.max(1, Number($('post-extend-days').value) || 1);
    const rent = publishReceipt({ bytes: post.bytes, days, world: state.world });
    $('post-extend-cost').textContent = `${formatEur(rent.rentNano)} for ${days} day${days === 1 ? '' : 's'} · ${formatUnits(rent.rent.wei, 18, 6)} PTP`;
    markRefusal($('post-extend'), checkAct(state.world, wallet.address, { k: 'extend', pid, days }, now));

    const settleRefusal = checkAct(state.world, wallet.address, { k: 'settle', pid }, now);
    $('post-settle').hidden = settled || (settleRefusal && settleRefusal.code === 'SETTLE_BEFORE_GRACE');
    markRefusal($('post-settle'), settleRefusal);
    $('post-lease-controls').hidden = settled && $('post-settle').hidden;

    const tomb = $('post-tombstone');
    if (settled && post.tombstone) {
      const t = post.tombstone;
      tomb.hidden = false;
      tomb.textContent =
        `The picture is gone from every device. What survives: ${formatCount(t.views)} views from ` +
        `${formatCount(t.uniqueViewers)} people, ${formatCount(t.likes)} likes, ${formatCount(t.comments)} comments, ` +
        `${formatEur(t.grossNano)} gross, ${formatUnits(t.paidWei, 18, 6)} PTP paid to the author, ` +
        `sealed in epoch ${t.epoch}. cid ${t.cid}, ${formatCount(t.bytes)} bytes.`;
      forgetPicture(post.cid);
    } else {
      tomb.hidden = true;
      tomb.textContent = '';
    }

    const price = engagementPrice(post, 'comment', state.world);
    $('comment-cost').textContent = formatEur(price.nanoEur);
    markRefusal(
      $('comment-submit'),
      checkAct(state.world, wallet.address, { k: 'comment', pid, text: $('comment-text').value || 'x' }, now),
    );
    paintComments(pid);
  }

  function paintComments(pid) {
    const list = $('comment-list');
    const rows = [];
    for (const cid of Object.keys(state.world.comments)) {
      const c = state.world.comments[cid];
      if (c.pid === pid) rows.push({ cid, ...c });
    }
    rows.sort((a, b) => a.at - b.at);
    list.replaceChildren();
    for (const row of rows) {
      const frag = $('tpl-comment').content.cloneNode(true);
      const article = frag.querySelector('.comment');
      article.dataset.cid = row.cid;
      article.querySelector('.comment__author').textContent = authorLabel(row.author);
      article.querySelector('.comment__addr').textContent = shortAddress(row.author);
      setAt(article.querySelector('.comment__at'), row.at);
      article.querySelector('.comment__text').textContent = row.text;
      list.append(frag);
    }
    $('comment-empty').hidden = rows.length > 0;
    $('comment-skeleton').hidden = true;
  }

  function showPost(pid) {
    if (!state.world.posts[pid]) return;
    state.pid = pid;
    // The detail view's hero picture is billable on the same terms as a card:
    // it is a picture on a screen, and where it is on the screen is the only
    // thing the rule cares about. Registering the frame here is what puts it
    // under the same machine rather than under a second one.
    frames.set($('post-frame'), pid);
    observer.observe($('post-frame'));
    showView('post');
    paintPost(pid);
    startTicking();
  }

  function leavePost() {
    const frame = $('post-frame');
    observer.unobserve(frame);
    frames.delete(frame);
    if (state.pid) meter.intersect(state.pid, 0);
    state.pid = null;
  }

  // ── the wallet ───────────────────────────────────────────────────────────

  function paintWallet() {
    const addr = wallet.address;
    const account = addr ? state.world.accounts[addr] : null;
    $('wallet-addr').textContent = addr || 'not connected';
    $('wallet-handle').textContent = account && account.handle ? '@' + account.handle : 'no handle';
    $('wallet-chip-label').textContent = account && account.handle ? '@' + account.handle : addr ? shortAddress(addr) : 'connect';
    $('wallet-chip').dataset.state = addr ? 'connected' : 'anon';
    $('wallet-connect').hidden = Boolean(addr);
    const ptp = account ? account.ptp : 0n;
    $('wallet-ptp').textContent = formatUnits(ptp, 18, 6);
    $('wallet-eur').textContent = formatEur(ptpWeiToNanoEur(ptp, state.world.epoch.oracle));
    $('wallet-cap').textContent = formatUnits(account ? account.cap : 0n, 6, 2);
    $('wallet-sat').textContent = formatUnits(account ? account.sat : 0n, 0);

    const provider = state.world.capacity.providers[addr];
    $('cap-pledged').textContent = `${formatCount(provider ? provider.mb : 0)} MB`;
    $('cap-proven').textContent = `${formatUnits(provider ? provider.proven : 0n, 6, 2)} MB·days`;
    $('cap-pot').textContent = `${formatUnits(state.world.capacity.potPtp, 18, 6)} PTP`;
    $('cap-claimable').textContent = claimableText(addr);
    markRefusal($('cap-claim'), checkAct(state.world, addr, { k: 'capClaim' }, Date.now()));

    paintCapacityNotice();

    $('edition-replay').textContent = EDITION === 'unavailable' ? 'unavailable in a browser' : EDITION.slice(0, 16) + '…';
    $('edition-rules').textContent = `${state.world.rules.version} (shipped ${RULES_VERSION})`;
    $('edition-epoch').textContent = formatCount(state.world.epoch.n);
    $('edition-oracle').textContent = `${formatEur(state.world.epoch.oracle.eurPerBtcNano)} / BTC`;
    paintSwap();
  }

  /**
   * The one thing a member has to be asked, because the browser will not answer
   * it: is this connection metered?
   *
   * Only Chromium implements NetworkInformation, so on Firefox and Safari the
   * platform says nothing and storage.mjs defaults to "metered", which means the
   * device serves nothing at all. Left there, the capacity half of this app would
   * be quietly dead on two of the three engines. The member is asked instead —
   * they are the only one who knows what their data costs — and the number that
   * makes the question worth asking is printed beside it.
   */
  function paintCapacityNotice() {
    const serving = space.mayServe();
    let notice = $('metered-notice');
    if (serving.ok) {
      if (notice) notice.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'metered-notice';
      notice.className = 'notice stack';
      $('cap-stats').after(notice);
      const say = document.createElement('button');
      say.type = 'button';
      say.className = 'btn btn--wide';
      say.textContent = 'this connection is not metered — serve shards';
      say.addEventListener('click', () => {
        space.setMetered(false);
        paintWallet();
      });
      notice.append(document.createElement('p'), say);
    }
    notice.firstChild.textContent = serving.why;
  }

  /**
   * What a claim would actually pay, asked of the rulebook rather than worked out
   * again.
   *
   * `capClaim`'s draw is a per-post escrow calculation with a subtlety the obvious
   * formula gets wrong, so a second implementation here would be a second answer
   * — and the one on screen would be the wrong one. Instead the act is applied to
   * a COPY of the world and the balance difference is read off. The copy is
   * thrown away, so nothing about the real world changes, and the number is by
   * construction the number the writer would produce.
   *
   * It is computed only while the wallet is open, because cloning a replayed
   * world is not free.
   */
  function claimableText(addr) {
    if (!addr || !state.world.capacity.providers[addr]) return '0 PTP';
    if (!$('sheet-wallet').open) return '—';
    let copy;
    try {
      copy = structuredClone(state.world);
    } catch {
      return '—';
    }
    // structuredClone drops the prototype-less shape of the maps but not their
    // contents, and `constants` is a frozen plain object, so the clone replays
    // identically. Only the copy is touched.
    copy.constants = state.world.constants;
    const before = copy.accounts[addr] ? copy.accounts[addr].ptp : 0n;
    const result = applyAct(copy, prepareAct(copy, addr, { k: 'capClaim' }, Date.now()));
    if (!result.ok) return `nothing to claim · ${result.code}`;
    return `${formatUnits(copy.accounts[addr].ptp - before, 18, 6)} PTP`;
  }

  function sellSide() {
    const checked = document.querySelector('#buy-form input[name="sell"]:checked');
    return checked ? checked.value : 'btc';
  }

  function paintSwap() {
    const side = sellSide();
    $('buy-amount-unit').textContent = side === 'btc' ? 'satoshi' : 'PTP';
    const slippage = Number($('buy-slippage').value) || 50;
    let amount = 0n;
    try {
      amount = parseUnits($('buy-amount').value || '0', side === 'btc' ? 0 : 18);
    } catch {
      amount = 0n;
    }
    const line = $('buy-slippage-line');
    if (amount <= 0n) {
      for (const id of ['buy-quote', 'buy-rate', 'buy-impact', 'buy-minout', 'buy-fee']) $(id).textContent = '—';
      line.dataset.impact = 'low';
      markRefusal($('buy-submit'), null);
      return;
    }
    let preview;
    try {
      preview = swapPreview(state.world.pool, side, amount, slippage, state.world.constants);
    } catch (err) {
      for (const id of ['buy-quote', 'buy-rate', 'buy-impact', 'buy-minout', 'buy-fee']) $(id).textContent = '—';
      markRefusal($('buy-submit'), asRefusal(err));
      return;
    }
    const outDecimals = side === 'btc' ? 18 : 0;
    $('buy-quote').textContent = `${formatUnits(preview.out, outDecimals, 6)} ${side === 'btc' ? 'PTP' : 'sat'}`;
    $('buy-rate').textContent = `${formatUnits(preview.satPerPtp, 0)} sat / PTP`;
    $('buy-impact').textContent = `${formatUnits(preview.impactBps, 2, 2)} %`;
    $('buy-minout').textContent = `${formatUnits(preview.minOut, outDecimals, 6)} ${side === 'btc' ? 'PTP' : 'sat'}`;
    $('buy-fee').textContent = `${formatUnits(preview.poolFee, side === 'btc' ? 0 : 18, 6)} ${side === 'btc' ? 'sat' : 'PTP'}`;
    // 100 bps of price impact is where a trade stops being a fill and starts
    // being a move. The stylesheet turns the line heavier at "high".
    line.dataset.impact = preview.impactBps >= 100n ? 'high' : 'low';
    markRefusal(
      $('buy-submit'),
      checkAct(state.world, wallet.address, { k: 'swap', sell: side, amt: amount.toString(), minOut: preview.minOut.toString() }, Date.now()),
    );
  }

  // ── the composer ─────────────────────────────────────────────────────────

  function paintComposer() {
    const file = state.file;
    $('composer-frame').hidden = !file;
    $('composer-file-meta').hidden = !file;
    if (!file) {
      for (const id of ['composer-fee', 'composer-rent', 'composer-cap', 'composer-cap-held', 'composer-total', 'composer-total-ptp']) {
        $(id).textContent = '—';
      }
      return;
    }
    $('composer-wh').textContent = `${file.w} × ${file.h}`;
    $('composer-bytes').textContent = `${formatCount(file.bytes)} bytes`;
    $('composer-mime').textContent = file.mime;
    $('composer-mb').textContent = (file.bytes / Number(BYTES_PER_MB)).toFixed(3);

    const days = Math.max(1, Number($('composer-days').value) || 1);
    const account = wallet.address ? state.world.accounts[wallet.address] : null;
    const receipt = publishReceipt({ bytes: file.bytes, days, world: state.world, held: account ? account.cap : 0n });
    $('composer-fee').textContent = formatEur(receipt.feeNano);
    $('composer-rent-basis').textContent = `${receipt.mb.toFixed(3)} MB × ${receipt.replication} copies × ${days} day${days === 1 ? '' : 's'}`;
    $('composer-rent').textContent = formatEur(receipt.rentNano);
    $('composer-cap').textContent = formatUnits(receipt.capUnits, 6, 2);
    $('composer-cap-held').textContent = formatUnits(receipt.capHeld, 6, 2);
    $('composer-total').textContent = formatEur(receipt.totalNano);
    $('composer-total-ptp').textContent = `${formatUnits(receipt.totalWei, 18, 6)} PTP${receipt.dust ? ' · dust' : ''}`;
    $('composer-cap-warning').hidden = receipt.capShort === 0n;

    let priceNano;
    try {
      priceNano = parseEurToNano($('composer-price').value || '');
    } catch {
      priceNano = PARAMS.viewPriceDefaultNanoEur;
    }
    const clamped = priceNano < PARAMS.viewPriceMinNanoEur || priceNano > PARAMS.viewPriceMaxNanoEur;
    $('composer-price-out').textContent = clamped
      ? `outside the band ${formatEur(PARAMS.viewPriceMinNanoEur)} – ${formatEur(PARAMS.viewPriceMaxNanoEur)}`
      : `${formatEur(priceNano)} a view · ${formatEur(actionPriceNanoEur(priceNano, 'like', PARAMS))} a like · ${formatEur(actionPriceNanoEur(priceNano, 'comment', PARAMS))} a comment · ${formatUnits(nanoEurToSubSat(priceNano, state.world.epoch.oracle.eurPerBtcNano), 8, 8)} sat`;

    markRefusal(
      $('composer-submit'),
      checkAct(
        state.world,
        wallet.address,
        {
          k: 'post',
          cid: file.cid,
          bytes: file.bytes,
          mime: file.mime,
          w: file.w,
          h: file.h,
          viewPriceNano: (clamped ? PARAMS.viewPriceDefaultNanoEur : priceNano).toString(),
          days,
        },
        Date.now(),
      ),
    );
  }

  async function readFile(input) {
    const file = input.files && input.files[0];
    if (!file) {
      state.file = null;
      paintComposer();
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.length > MAX_PAYLOAD_BYTES) {
      state.file = null;
      paintComposer();
      return showRefusal(refuse('PAYLOAD_TOO_LARGE', { bytes: buffer.length, max: MAX_PAYLOAD_BYTES }), 'composer-error');
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    let w = 0;
    let h = 0;
    try {
      const bitmap = await createImageBitmap(file);
      w = bitmap.width;
      h = bitmap.height;
      bitmap.close();
    } catch {
      state.file = null;
      paintComposer();
      return showRefusal(refuse('MIME_REFUSED', { mime: file.type }), 'composer-error');
    }
    state.file = { blob: file, bytes: buffer.length, buffer, cid: toHex(digest), mime: file.type, w, h };
    const frame = $('composer-frame');
    frame.style.setProperty('--ar', `${w} / ${h}`);
    $('composer-preview').src = URL.createObjectURL(file);
    paintComposer();
    return null;
  }

  // ── this device as a storage node ────────────────────────────────────────

  function liveNodes() {
    return Object.keys(state.world.capacity.providers).filter((id) => state.world.capacity.providers[id].mb > 0);
  }

  const forgotten = new Set();

  async function forgetPicture(cid) {
    if (forgotten.has(cid)) return;
    forgotten.add(cid);
    await space.forget(cid).catch(() => {});
    const reg = await navigator.serviceWorker?.getRegistration();
    // The picture leaves this device with its payload rather than waiting for its
    // expiry: settlement is the instruction, and the service worker holds the
    // other copy of it.
    reg?.active?.postMessage({ type: 'FORGET', cid });
  }

  /** Take the shards of a freshly published picture that placement gives this
   * device. Nothing is stored on a metered connection, and nothing is stored
   * that this node was not assigned. */
  async function keepOwnShards(post, buffer) {
    if (!wallet.address) return;
    const nodes = liveNodes();
    if (!nodes.includes(wallet.address)) return;
    const plan = space.plan(post, nodes);
    for (const index of plan.mine) {
      const range = shardRangeOf(index, post.bytes, SHARD_BYTES);
      await space.accept(post, index, buffer.subarray(range.start, range.end), nodes).catch(() => {});
    }
  }

  // ── the wiring ───────────────────────────────────────────────────────────

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pid = frames.get(entry.target);
        if (!pid) continue;
        if (!entry.isIntersecting) meter.intersect(pid, 0);
      }
      if (entries.some((e) => e.isIntersecting)) startTicking();
    },
    { threshold: [0, 0.01, 0.5, 1] },
  );

  /**
   * The share of the screen this picture occupies, as the machine defines it:
   * the visible area over whichever is smaller, the picture or the viewport.
   */
  function viewportShare(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const visible = w * h;
    const denominator = Math.min(r.width * r.height, vw * vh);
    return denominator > 0 ? (visible / denominator) * 100 : 0;
  }

  function startTicking() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(frameTick);
  }

  function frameTick() {
    const now = Date.now();
    let active = false;
    for (const [frame, pid] of frames) {
      if (!frame.isConnected) continue;
      const pct = viewportShare(frame);
      meter.intersect(pid, pct);
      if (pct > 0) active = true;
      // The hairline that fills while the billable dwell runs. It is the user's
      // only warning that an impression is being counted, so it is written every
      // frame the dwell is alive rather than at the end of it.
      const bar = frame.querySelector('.frame__dwell');
      if (bar) bar.style.setProperty('--dwell', String(meter.progress(pid, now)));
    }
    for (const billable of meter.tick(now)) bill(billable);
    ticking = active;
    if (active) requestAnimationFrame(frameTick);
  }

  // The highest view sequence this client has SENT, which is not the same as the
  // highest the world has accepted while an act is in flight. Two pictures can
  // both finish their dwell in one frame — each is measured against its own area,
  // so two of them at 60% is not a contradiction — and both would otherwise claim
  // the same sequence and the second would come back VIEW_SEQ_REPLAY.
  let seqSent = -1;

  /** One billable impression, sent. The account's own view sequence is what makes
   * a captured view act worthless to whoever captured it. */
  async function bill({ pid, dwellMs, vp }) {
    const post = state.world.posts[pid];
    if (!post) return;
    const account = wallet.address ? state.world.accounts[wallet.address] : null;
    if (!account) return;
    const price = engagementPrice(post, 'view', state.world);
    const seq = Math.max(account.viewSeq, seqSent) + 1;
    seqSent = seq;
    await send({ k: 'view', pid, dwellMs, seq, vp }, { what: 'view', nanoEur: price.nanoEur });
  }

  // ── events ───────────────────────────────────────────────────────────────

  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const card = el.closest('[data-pid]');
    const pid = card ? card.dataset.pid : state.pid;

    if (el.getAttribute('aria-disabled') === 'true' && el.dataset.refusal) {
      event.preventDefault();
      showRefusal(refuse(el.dataset.refusal, null), slotFor(el));
      return;
    }

    switch (act) {
      case 'open-wallet':
        paintWallet();
        openSheet('sheet-wallet');
        break;
      case 'open-composer':
        paintComposer();
        openSheet('sheet-composer');
        break;
      case 'open-post':
        if (pid) showPost(pid);
        break;
      case 'open-author': {
        event.preventDefault();
        const post = pid ? state.world.posts[pid] : null;
        state.author = post ? post.author : null;
        state.page = PAGE_SIZE;
        showView('feed');
        render();
        break;
      }
      case 'close-sheet':
        el.closest('dialog')?.close();
        break;
      case 'go-feed':
        state.author = null;
        leavePost();
        showView('feed');
        render();
        break;
      case 'back':
        leavePost();
        showView('feed');
        break;
      case 'connect':
        await connect(el);
        break;
      case 'retry':
        // The banner's one button serves both states it can be in: an update
        // waiting to be taken, and a record that could not be read.
        if (waiting) {
          waiting.postMessage({ type: 'SKIP_WAITING' });
          location.reload();
          return;
        }
        await refresh();
        break;
      case 'like':
        if (pid) {
          const post = state.world.posts[pid];
          const price = engagementPrice(post, 'like', state.world);
          await send({ k: 'like', pid }, { button: el, what: 'like', nanoEur: price.nanoEur });
        }
        break;
      case 'focus-comment':
        $('comment-text').focus();
        break;
      case 'extend': {
        const days = Math.max(1, Number($('post-extend-days').value) || 1);
        const post = state.world.posts[state.pid];
        if (post) {
          const receipt = publishReceipt({ bytes: post.bytes, days, world: state.world });
          await send({ k: 'extend', pid: state.pid, days }, { button: el, what: 'lease', nanoEur: receipt.rentNano });
        }
        break;
      }
      case 'settle':
        await send({ k: 'settle', pid: state.pid }, { button: el });
        break;
      case 'cap-claim':
        await send({ k: 'capClaim' }, { button: el });
        break;
      case 'close-toast':
        el.closest('.toast')?.remove();
        break;
      default:
        break;
    }
  });

  /** Which inline slot a control's refusal belongs beside, or none — in which
   * case it floats. */
  function slotFor(el) {
    if (el.closest('#composer-form')) return 'composer-error';
    if (el.closest('#buy-form')) return 'buy-error';
    if (el.closest('#burn-form')) return 'burn-error';
    if (el.closest('#register-form')) return 'register-error';
    return null;
  }

  async function connect(button) {
    setBusy(button, true);
    try {
      if (wallet.state().hasProvider) {
        await wallet.connectInjected();
      } else if (!(await wallet.loadLocal())) {
        offerLocalKey();
        return;
      }
      afterConnect();
    } catch (err) {
      showRefusal(asRefusal(err));
    } finally {
      setBusy(button, false);
    }
  }

  function afterConnect() {
    space.setNodeId(wallet.address);
    meter.seed(state.world, wallet.address);
    render();
    if (wallet.address && !state.world.accounts[wallet.address]) openSheet('sheet-register');
  }

  /**
   * The local-key offer, with the warning it must never be separated from.
   *
   * The sentences are in wallet.mjs so that the same words appear wherever the
   * choice is made. Nothing is generated until the member presses the second
   * button; the first press only shows them what they are agreeing to.
   */
  function offerLocalKey() {
    const host = $('wallet-connect').parentNode;
    let notice = $('local-key-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'local-key-notice';
      notice.className = 'notice stack';
      host.insertBefore(notice, $('wallet-connect').nextSibling);
    }
    notice.replaceChildren();
    const head = document.createElement('p');
    head.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = 'No wallet is installed in this browser.';
    head.append(strong, document.createTextNode(' This app can make a key for you and keep it here.'));
    notice.append(head);
    for (const line of LOCAL_KEY_WARNING) {
      const p = document.createElement('p');
      p.textContent = line;
      notice.append(p);
    }
    const make = document.createElement('button');
    make.type = 'button';
    make.className = 'btn btn--wide';
    make.textContent = 'make a key on this device';
    make.addEventListener('click', async () => {
      setBusy(make, true);
      try {
        await wallet.createLocal();
        const backup = document.createElement('p');
        backup.className = 'addr';
        backup.textContent = wallet.exportLocalKey();
        const label = document.createElement('p');
        label.className = 'meta';
        label.textContent = 'This is the whole key. Write it down now — it is not shown again unless you ask, and it exists nowhere else.';
        notice.replaceChildren(label, backup);
        afterConnect();
      } catch (err) {
        showRefusal(asRefusal(err));
      } finally {
        setBusy(make, false);
      }
    });
    notice.append(make);
  }

  // Forms.

  $('register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const handle = $('register-handle').value.trim().toLowerCase();
    const accepted = await send({ k: 'register', handle }, { button: $('register-submit'), slot: 'register-error' });
    if (accepted) $('sheet-register').close();
  });

  $('comment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('comment-text').value;
    const post = state.world.posts[state.pid];
    if (!post) return;
    const price = engagementPrice(post, 'comment', state.world);
    const accepted = await send(
      { k: 'comment', pid: state.pid, text },
      { button: $('comment-submit'), what: 'comment', nanoEur: price.nanoEur },
    );
    if (accepted) {
      $('comment-text').value = '';
      $('comment-count').textContent = '0';
    }
  });

  $('comment-text').addEventListener('input', () => {
    const n = $('comment-text').value.length;
    $('comment-count').textContent = formatCount(Math.min(n, MAX_COMMENT_CHARS));
  });

  $('composer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    // An old refusal cleared at the top of the handler, not inside `send` — the
    // upload happens first, and a stale sentence sitting beside a form while a
    // new act is in flight reads as the answer to that act.
    clearSlot('composer-error');
    const file = state.file;
    if (!file) return showRefusal(refuse('BAD_REQUEST', { file: null }), 'composer-error');
    let priceNano;
    try {
      priceNano = parseEurToNano($('composer-price').value || formatEur(PARAMS.viewPriceDefaultNanoEur));
    } catch (err) {
      return showRefusal(asRefusal(err), 'composer-error');
    }
    const days = Math.max(1, Number($('composer-days').value) || 1);
    const receipt = publishReceipt({ bytes: file.bytes, days, world: state.world });
    setBusy($('composer-submit'), true);
    try {
      // The bytes go first. A post act naming a cid nobody can fetch is a post
      // whose picture does not exist, and it would still be charged for.
      const up = await fetch(state.base + MEDIA_PATH, {
        method: 'POST',
        headers: { 'content-type': file.mime || 'application/octet-stream' },
        body: file.blob,
      });
      if (!up.ok) {
        const body = await up.json().catch(() => null);
        return showRefusal(body && body.code ? body : refuse('NOT_THE_WRITER', { status: up.status }), 'composer-error');
      }
    } catch (err) {
      return showRefusal(asRefusal(err), 'composer-error');
    } finally {
      setBusy($('composer-submit'), false);
    }
    const accepted = await send(
      {
        k: 'post',
        cid: file.cid,
        bytes: file.bytes,
        mime: file.mime,
        w: file.w,
        h: file.h,
        viewPriceNano: priceNano.toString(),
        days,
      },
      { button: $('composer-submit'), slot: 'composer-error', what: 'publish', nanoEur: receipt.totalNano },
    );
    if (accepted) {
      const pid = `p${state.world.seq.post}`;
      const post = state.world.posts[pid];
      if (post) await keepOwnShards({ ...post, pid }, file.buffer);
      $('sheet-composer').close();
      state.file = null;
      $('composer-form').reset();
      paintComposer();
    }
    return null;
  });

  $('composer-file').addEventListener('change', (event) => readFile(event.target));
  for (const id of ['composer-price', 'composer-days']) $(id).addEventListener('input', paintComposer);
  $('post-extend-days').addEventListener('input', () => state.pid && paintPost(state.pid));

  $('buy-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearSlot('buy-error');
    const side = sellSide();
    let amount;
    try {
      amount = parseUnits($('buy-amount').value || '0', side === 'btc' ? 0 : 18);
    } catch (err) {
      return showRefusal(asRefusal(err), 'buy-error');
    }
    let preview;
    try {
      preview = swapPreview(state.world.pool, side, amount, Number($('buy-slippage').value) || 50, state.world.constants);
    } catch (err) {
      return showRefusal(asRefusal(err), 'buy-error');
    }
    await send(
      { k: 'swap', sell: side, amt: amount.toString(), minOut: preview.minOut.toString() },
      { button: $('buy-submit'), slot: 'buy-error' },
    );
    return null;
  });

  for (const el of document.querySelectorAll('#buy-form input[name="sell"]')) el.addEventListener('change', paintSwap);
  $('buy-amount').addEventListener('input', paintSwap);
  $('buy-slippage').addEventListener('change', paintSwap);

  $('burn-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearSlot('burn-error');
    let sat;
    try {
      sat = parseUnits($('burn-sat').value || '0', 0);
    } catch (err) {
      return showRefusal(asRefusal(err), 'burn-error');
    }
    await send(
      { k: 'burnClaim', txid: $('burn-txid').value.trim().toLowerCase(), vout: Number($('burn-vout').value) || 0, sat: sat.toString() },
      { button: $('burn-submit'), slot: 'burn-error' },
    );
    return null;
  });

  $('cap-pledge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mb = Number($('cap-pledge-mb').value) || 0;
    const endpoint = $('cap-pledge-endpoint').value.trim();
    const permission = await space.requestPersistence();
    const serving = space.mayServe();
    if (!permission.persisted || !serving.ok) {
      // Said plainly rather than pretended: a device that cannot keep bytes, or
      // that would pay to serve them, is not a storage node.
      banner(`${permission.why} ${serving.ok ? '' : serving.why}`.trim());
    }
    await send({ k: 'capPledge', mb, endpoint }, { button: $('cap-pledge-submit') });
    return null;
  });

  // Scroll, fling and attention.

  window.addEventListener(
    'scroll',
    () => {
      meter.scroll(window.scrollY, Date.now());
      startTicking();
    },
    { passive: true },
  );

  window.addEventListener('resize', () => meter.setViewport(window.innerHeight), { passive: true });

  document.addEventListener('visibilitychange', () => {
    // A tab nobody is looking at bills nothing, and returning to one does not
    // bill the hour it spent hidden.
    if (document.hidden) meter.blur(Date.now());
    else startTicking();
  });

  // The end sentinel is the paging trigger.
  new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      const total = feedOrder(state.world, Date.now(), { author: state.author, seen: meter.pairs }).length;
      if (state.page >= total) return;
      state.page += PAGE_SIZE;
      render();
    },
    { rootMargin: '400px' },
  ).observe($('feed-end'));

  // ── start ────────────────────────────────────────────────────────────────

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      // SWEEP now: prune every cached picture whose lease has already run out.
      reg.active?.postMessage({ type: 'SWEEP' });
      // SKIP_WAITING is never sent behind the user's back. A new version that
      // took over mid-session would swap the rulebook under an act in flight, so
      // the app says an update is ready and takes it when the user asks.
      const offer = () => {
        if (!reg.waiting) return;
        waiting = reg.waiting;
        banner('A new version of the app is ready. Take it when you are not part-way through anything.');
      };
      offer();
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', offer));
    }, () => {});
  }

  paintSession();
  await wallet.loadLocal().catch(() => null);
  await space.open().catch(() => false);
  space.setNodeId(wallet.address);
  wallet.onChange(() => {
    meter.seed(state.world, wallet.address);
    render();
  });
  showView('feed');
  await refresh();

  // The manifest's two shortcuts start the app at ./?sheet=composer and
  // ./?sheet=wallet. The parameter is removed afterwards so a reload does not
  // reopen a sheet the user closed.
  const params = new URLSearchParams(location.search);
  const sheet = params.get('sheet');
  if (sheet === 'composer' || sheet === 'wallet') {
    openSheet(`sheet-${sheet}`);
    params.delete('sheet');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
  }

  return { state, session, meter, wallet, space };
}

// The DOM is the only thing that decides whether this file runs as an app. In a
// test there is no document, so nothing boots and every function above is an
// ordinary import.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot());
  else boot();
}
