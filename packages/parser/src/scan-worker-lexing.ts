/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan worker's lexing helpers, as a string.
 *
 * `step-lexing.ts` is to `tokenizer.ts` what this file is to
 * `scan-worker-source.ts`: the STEP lexical rules, separated from the scan
 * loop that walks them. The worker's copy has to be a string and has to be
 * hand-duplicated because a Blob worker cannot import at runtime -- that is a
 * transport constraint, never a licence for the rules themselves to drift.
 * Each function below names the `step-lexing.ts` function it mirrors.
 *
 * Interpolated into `WORKER_CODE`, which supplies `buf`, `len` and `line`.
 */
export const WORKER_LEXING = `
  // The STEP whitespace set: space, tab, CR, LF, form feed, vertical tab.
  // The matched half is the now-exported isSpaceByte in step-lexing.ts; a
  // member going missing from one copy is what #3733 was.
  function isSpaceByteAt(p) {
    var t = buf[p];
    return t === 0x20 || t === 0x09 || t === 0x0A || t === 0x0D || t === 0x0C || t === 0x0B;
  }

  // Whether a STEP comment opens at p.
  function opensCommentAt(p) {
    return p + 1 < len && buf[p] === 0x2F && buf[p + 1] === 0x2A;
  }

  // Index just past the '*/' closing the comment at p, or -1 when it never
  // closes. Counts the newlines it crosses so line numbers stay in step.
  //
  // Kept behaviourally identical to skipComment/skipTrivia in step-lexing.ts,
  // which this cannot import: the worker source is a string, so this copy of
  // the rule has to live here. Comments do not nest, per ISO 10303-21.
  function skipCommentAt(p) {
    var q = p + 2;
    while (q + 1 < len) {
      if (buf[q] === 0x2A && buf[q + 1] === 0x2F) return q + 2;
      if (buf[q] === 0x0A) line++;
      q++;
    }
    return -1;
  }

  // Skip whitespace, comments, and any run of the two -- 10303-21 allows a
  // comment wherever whitespace is allowed, INCLUDING inside a record.
  // Returns -1 when a comment opens and never closes: everything from there on
  // is inside it, so there is nothing left to find.
  //
  // The whitespace byte set (space, tab, CR, LF, form feed, vertical tab) is
  // kept byte-for-byte in sync with isSpaceByte in step-lexing.ts and its
  // three inline twins in tokenizer.ts's scanEntitiesFast -- this file is a
  // string because a Blob worker cannot import at runtime, not a reason for
  // the rule itself to drift.
  function skipTriviaAt(p) {
    for (;;) {
      while (p < len) {
        var t = buf[p];
        if (t === 0x20 || t === 0x09 || t === 0x0D || t === 0x0C || t === 0x0B) { p++; }
        else if (t === 0x0A) { line++; p++; }
        else break;
      }
      if (!opensCommentAt(p)) return p;
      var e = skipCommentAt(p);
      if (e < 0) return -1;
      p = e;
    }
  }

  // Byte length from startOffset through the ')' balancing the '(' at p, or a
  // CLASSIFIED failure: -1 unbalanced but readable, -2 a literal or comment
  // that never closed. The RECOVERY point for a record with no ';' of its own
  // (#4179), and the exact answer for whether a ';' is the record's own.
  // Mirrors findEntityLength in step-record-boundary.ts; a literal is jumped
  // whole and a comment after it, in that order, so a paren inside either is
  // text. NOTE: skipCommentAt advances the line counter, so a caller that
  // re-walks the record must save and restore it.
  function findEntityLengthAt(p, startOffset) {
    var d = 0;
    while (p < len) {
      var b = buf[p];
      if (b === 0x27) {
        p++;
        for (;;) {
          if (p >= len) return -2;
          if (buf[p] === 0x27) { if (buf[p + 1] === 0x27) { p += 2; continue; } p++; break; }
          p++;
        }
      } else if (opensCommentAt(p)) {
        var q = skipCommentAt(p);
        if (q < 0) return -2;
        p = q;
      } else if (b === 0x28) { d++; p++; }
      else if (b === 0x29) { if (d === 0) return -1; d--; p++; if (d === 0) return p - startOffset; }
      else { p++; }
    }
    return -1;
  }
`;
