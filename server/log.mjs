// The act log: one canonical-JSON act per line, appended and never rewritten.
//
// ARCHITECTURE rule 1 says the act log is the only truth and every number in the
// network is a pure function of it. That makes this file the most boring and the
// most load-bearing one in the server: its whole job is that a line that was
// acknowledged is on the disk, in that order, forever, and that a crash halfway
// through a write cannot make the file mean something different when it comes
// back.
//
// ── THE FOUR PROPERTIES ────────────────────────────────────────────────────
//
// 1. ONE WRITER, ONE QUEUE. Two concurrent appends racing for the same index
//    would interleave bytes and mint two lines from one intent. Every append
//    goes through a single promise chain, so there is exactly one write in
//    flight and the index is assigned inside the critical section rather than
//    read before it.
//
// 2. FSYNC BEFORE OK. `append` does not resolve until the bytes are on the
//    platter. An act the host acknowledged and then lost is worse than a
//    refusal: the sender believes it was billed, every reader disagrees, and
//    nothing in the record says which is right.
//
// 3. A PARTIAL TAIL IS TRUNCATED ON OPEN, LOUDLY. A crash mid-write leaves a
//    line with no newline. It is cut back to the last complete newline and the
//    number of bytes dropped is reported on the log object, because a host that
//    silently repairs its own record is a host whose record nobody can check.
//
// 4. A LINE IS NEVER RESERIALISED. Redaction — the one lawful mutation —
//    overwrites a line IN PLACE at unchanged byte length, so no other line ever
//    moves and no offset a reader took is invalidated. Read the long comment on
//    `redact`: the mechanism is real, and the set of fields it may lawfully
//    touch in this rulebook is empty, which is a limit worth stating rather than
//    a feature worth pretending to.
//
// The log holds no opinions. It does not validate acts, does not check
// signatures and does not know what an act means — server/index.mjs does all of
// that before it calls `append`, and core/replay.mjs decides what any of it adds
// up to. This file decides only what is written down and in what order.

import { open, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, parseCanonical } from '../core/canonical.mjs';

/** The file, beside the rest of the record, named in ARCHITECTURE §4. */
export const LOG_FILE = 'acts.jsonl';

/**
 * The fields every act kind declares, mirrored from core/replay.mjs's act table.
 *
 * It is duplicated here and the duplication is deliberate: `redact` has to know
 * which fields the rulebook reads in order to refuse to remove one, and
 * core/replay.mjs does not export its table. The two must agree, and a
 * disagreement shows up as a redaction this file allows and replay then notices
 * — which is the safe direction for the copy to be wrong in, because the guard
 * is what would fail open, and the guard is checked by test/server.test.mjs
 * against the real refusals replay produces.
 */
export const RULEBOOK_FIELDS = Object.freeze({
  '': ['i', 't', 'as', 'k', 'sig'],
  register: ['handle'],
  burnClaim: ['txid', 'vout', 'sat'],
  swap: ['sell', 'amt', 'minOut'],
  liqAdd: ['sat', 'ptp'],
  liqRemove: ['shares'],
  post: ['cid', 'bytes', 'mime', 'w', 'h', 'viewPriceNano', 'days'],
  extend: ['pid', 'days'],
  view: ['pid', 'dwellMs', 'seq', 'vp'],
  like: ['pid'],
  comment: ['pid', 'text'],
  settle: ['pid'],
  capBuy: ['ptp'],
  capPledge: ['mb', 'endpoint'],
  capProof: ['challenge', 'answer'],
  capClaim: [],
  rulesSet: ['version', 'hash', 'fromEpoch'],
  closeEpoch: ['oracle'],
});

/** Whether a field of an act of this kind is one core/replay.mjs reads. */
export function rulebookReads(kind, field) {
  if (RULEBOOK_FIELDS[''].includes(field)) return true;
  const fields = RULEBOOK_FIELDS[kind];
  return Array.isArray(fields) && fields.includes(field);
}

const NEWLINE = 0x0a;

/**
 * Open the log at `dir/acts.jsonl`, reading back everything already in it.
 *
 * Returns an object rather than a class instance because there is exactly one
 * of these per process and nothing subclasses it. The acts are handed back in
 * file order, parsed, with no validation of any kind — a line the writer wrote
 * under an older build may be an act this build refuses, and it is replay's job
 * to skip it, not this file's job to hide it.
 */
export async function openLog({ dir, file = LOG_FILE } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('openLog: dir is required');
  const path = resolve(join(dir, file));
  await mkdir(dirname(path), { recursive: true });

  // 'a+' creates the file without truncating anything; the handle is then
  // reopened 'r+' so that writes can be positional. On POSIX an 'a' handle
  // ignores the offset and always appends, which would make in-place redaction
  // silently append instead — the reopen is what stops that.
  const created = await open(path, 'a+');
  await created.close();
  const fh = await open(path, 'r+');

  const whole = await fh.readFile();
  let size = whole.length;
  let truncatedBytes = 0;

  // A crash mid-write leaves bytes with no newline behind them. Cut back to the
  // last complete line and say how much was dropped. Reporting it is the point:
  // the number ends up in GET /api/v1/status, so a reader can see that this host
  // lost a write rather than having to infer it from a gap.
  if (size > 0 && whole[size - 1] !== NEWLINE) {
    const lastNl = whole.lastIndexOf(NEWLINE);
    const keep = lastNl === -1 ? 0 : lastNl + 1;
    truncatedBytes = size - keep;
    await fh.truncate(keep);
    await fh.sync();
    size = keep;
  }

  // Every line's byte range is kept, because redaction writes at an offset and
  // the chain builder wants the exact bytes that were hashed, not a fresh
  // serialisation of the parsed value.
  const spans = [];
  const acts = [];
  const unreadable = [];
  {
    let start = 0;
    for (let i = 0; i < size; i++) {
      if (whole[i] !== NEWLINE) continue;
      const raw = whole.subarray(start, i);
      spans.push({ start, length: i - start });
      const text = raw.toString('utf8');
      try {
        // parseCanonical, never JSON.parse: the line was WRITTEN by
        // canonicalJson, which encodes a bigint as "~<decimal>" and gives any
        // string already starting "~" one more. Reading it back with a bare
        // JSON.parse returns a wei balance as the string "~1000", which
        // re-encodes to different bytes — so the writer would accept acts that
        // a replay of its own log then skips. That is a Rule 2 violation
        // reached without anybody writing a second rulebook, and it was
        // measured, not imagined.
        acts.push(parseCanonical(text));
      } catch {
        // A corrupted middle line is kept in the file and reported, not deleted.
        // Replay skips what it cannot use; this host does not get to decide that
        // a line it cannot parse never existed.
        unreadable.push(spans.length - 1);
        acts.push(null);
      }
      start = i + 1;
    }
  }

  let tail = Promise.resolve();
  let closed = false;

  /** The exact bytes of one stored line. Read directly, not through the queue,
   * because a read never moves the file and a redaction of the same line is
   * already serialised against every other write. */
  async function readLine(index) {
    const span = spans[index];
    if (!span) return null;
    const buf = Buffer.alloc(span.length);
    await fh.read(buf, 0, span.length, span.start);
    return buf.toString('utf8');
  }

  /** Run `fn` with nothing else touching the file. One writer, one queue. */
  function serialise(fn) {
    const run = tail.then(fn, fn);
    // The chain must not break when one write fails, or every later append
    // inherits a rejection it had nothing to do with.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    path,

    /** Bytes dropped from an incomplete last line when this log was opened. */
    get truncatedBytes() {
      return truncatedBytes;
    },

    /** The line indices that would not parse. Empty in a healthy log. */
    get unreadable() {
      return unreadable.slice();
    },

    /** The acts, in file order. `null` where a line would not parse. */
    get acts() {
      return acts;
    },

    get count() {
      return acts.length;
    },

    get bytes() {
      return size;
    },

    /** The index the next accepted act will carry. Dense and zero-based. */
    get nextIndex() {
      return acts.length;
    },

    /**
     * Append one act and return the index it was given.
     *
     * The index is assigned INSIDE the queue, not by the caller, because an
     * index read before the write is an index another append can take first.
     * The act is stored with `i` set to that index, so the line is
     * self-describing and a reader never has to count to know where it is.
     *
     * Resolves after fsync. Everything before that point is a promise the host
     * has not yet kept.
     */
    append(act) {
      return serialise(async () => {
        if (closed) throw new Error('log is closed');
        const i = acts.length;
        const stored = { ...act, i };
        const line = canonicalJson(stored);
        const buf = Buffer.from(line + '\n', 'utf8');
        await fh.write(buf, 0, buf.length, size);
        await fh.sync();
        spans.push({ start: size, length: buf.length - 1 });
        acts.push(stored);
        size += buf.length;
        return { i, line, act: stored };
      });
    },

    /**
     * The exact bytes of one stored line, as they are on the disk.
     *
     * The chain builder hashes what was written rather than what a fresh
     * serialisation would produce, so that a line redacted afterwards still
     * hashes to what the block committed to under its structural rule.
     */
    lineAt(index) {
      return readLine(index);
    },

    /**
     * Redaction: take the payload out of a stored line and leave the structure.
     *
     * The mechanism, precisely. The named fields' values are replaced with
     * `null` and the line is padded with spaces to its ORIGINAL byte length, so
     * the write lands entirely inside the space the line already occupied. No
     * other line moves, no offset any reader holds is invalidated, and the file
     * is never rewritten as a whole — which is what makes this compatible with
     * an append-only record rather than a hole in it. JSON tolerates the
     * trailing spaces, so a reader that knows nothing about redaction still
     * parses the line.
     *
     * THE LIMIT, STATED PLAINLY, BECAUSE IT IS THE INTERESTING PART. In this
     * rulebook there is no field this may lawfully be used on. ARCHITECTURE §6
     * names `cid` and `text` as the payload — the parts a structural hash
     * excludes — but core/replay.mjs READS both of them: a `post` whose cid is
     * null fails validation, so a replay of the redacted log would skip the post
     * act, and every view, like, comment and settlement that followed it would
     * refuse in turn. The world would not be redacted; it would be a different
     * world. Rule 1 says the log is the only truth, and a deletion that changes
     * what the truth is is not a deletion, it is a rewrite.
     *
     * So `redact` refuses any field the rulebook reads, and what a settled post
     * actually deletes is the PICTURE — the bytes in server/media.mjs, which the
     * log never held. That is not a workaround: the log carries a cid, the cid
     * addresses bytes held somewhere else, and removing those bytes is exactly
     * the deletion §6 describes, with the structural record and the payload
     * commitment left standing. The commitment residue that proves which bytes
     * existed is the cid itself, still in the line.
     *
     * Pass `{ force: true }` to redact a field the rulebook reads anyway. It
     * exists for a legal order that leaves a host no choice, it will change what
     * replay computes, and it says so.
     */
    redact(index, fields, { force = false } = {}) {
      return serialise(async () => {
        if (closed) throw new Error('log is closed');
        const span = spans[index];
        if (!span) {
          const err = new Error('NOT_FOUND');
          err.detail = { index, count: acts.length };
          throw err;
        }
        const list = Array.isArray(fields) ? fields : [fields];
        const act = acts[index];
        const kind = act && typeof act.k === 'string' ? act.k : '';

        if (!force) {
          for (const f of list) {
            if (rulebookReads(kind, f)) {
              const err = new Error('REDACT_UNSAFE');
              err.detail = {
                index,
                field: f,
                kind,
                why: 'core/replay.mjs reads this field; removing it would change every number after it',
              };
              throw err;
            }
          }
        }

        const redacted = { ...act };
        let touched = 0;
        for (const f of list) {
          if (!Object.prototype.hasOwnProperty.call(redacted, f)) continue;
          redacted[f] = null;
          touched += 1;
        }
        if (touched === 0) return { index, touched: 0, line: await readLine(index) };

        const line = canonicalJson(redacted);
        const lineBytes = Buffer.from(line, 'utf8');
        if (lineBytes.length > span.length) {
          // Cannot happen with a null substitution — null is never longer than
          // the value it replaces — but a future caller replacing a value with
          // something else would find out here rather than by corrupting the
          // next line.
          const err = new Error('REDACT_UNSAFE');
          err.detail = {
            index,
            why: 'the redacted line is longer than the line it replaces',
            bytes: lineBytes.length,
            span: span.length,
          };
          throw err;
        }
        // THE PADDING IS COUNTED IN BYTES, BECAUSE THE SPAN IS. `padEnd` counts
        // UTF-16 code units, and the two measures are not the same number: one
        // CJK character is one unit and three bytes, one emoji is two units and
        // four, one combining mark is one unit and two. So padding a line that
        // still carries any non-ASCII text to `span.length` UNITS produced a
        // buffer LONGER than the region it was written into, and the write ran
        // off the end of the line and over the act on the next one. Measured on
        // a line carrying CJK, an emoji and a combining accent in a field the
        // redaction did not touch: a 194-byte line came back as 216 bytes, the
        // following act was overwritten mid-token, and reopening the log found
        // one unreadable line where there had been two good ones.
        //
        // The buffer is therefore allocated AT the span's byte length and the
        // line copied into it, so the write is exactly as long as the region it
        // lands in by construction rather than by arithmetic a reader has to
        // redo. `copy` cannot overrun the destination, and the check above has
        // already refused a line that would not fit.
        const buf = Buffer.alloc(span.length, 0x20);
        lineBytes.copy(buf);
        await fh.write(buf, 0, buf.length, span.start);
        await fh.sync();
        acts[index] = redacted;
        // The line AS IT NOW IS ON THE DISK, padding included: a caller that
        // hashes what it is handed must hash the bytes that are stored.
        return { index, touched, line: buf.toString('utf8') };
      });
    },

    async close() {
      await serialise(async () => {
        if (closed) return;
        closed = true;
        await fh.close();
      });
    },
  };
}
