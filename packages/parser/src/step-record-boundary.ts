/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where one STEP record ends, and whether a given `;` is its own (#4179).
 *
 * The TypeScript half of the rule argued in `close_step_record` in
 * rust/core/src/parser/lexical.rs. Rust is the source of truth
 * per AGENTS.md; read the two rules, the general property they approximate,
 * and why a refusal recovers rather than stops, THERE, and change the halves
 * together. `StepTokenizer.scanEntitiesFast` (tokenizer.ts) calls into here;
 * `WORKER_CODE` (scan-worker-source.ts) hand-duplicates it because a Blob
 * worker cannot import at runtime.
 */

import { opensComment, skipComment, skipStringLiteral, skipTrivia } from './step-lexing.js';

const QUOTE = 0x27; // '\''
const LPAREN = 0x28; // '('
const RPAREN = 0x29; // ')'

// Byte length of the record starting at `startOffset` whose argument list
// opens at `pos`: up to and including the ')' balancing that '('.
//
// A failure is CLASSIFIED, because the two kinds call for opposite answers
// from a scan that wants to recover (#4179). UNBALANCED_RECORD: every literal
// and comment closed, so bytes after this record are readable and a caller may
// resume there. UNREADABLE_RECORD: one never closed, so everything to end of
// input is inside it and nothing can be resumed.
//
// A string literal is jumped over by skipStringLiteral rather than counted, so
// the '(' in 'Storey (Level 1)' is text and not depth, and STEP's doubled-quote
// escape ('') stays inside the literal instead of closing it. Sharing that
// helper keeps the escape rule in one place: an open-coded `inString` flag here
// would be a second copy, free to drift from the one every other scanner uses.
//
// A comment is jumped over for the same reason, in the same order: the literal
// test comes first, so a '/*' inside a value is text; the comment is then taken
// whole, so a '(' or a quote inside it is text. Without that, the comment in
// `#1=IFCWALL('a', /* see IFCWALL( */ $);` opened a depth that never closed.
export const UNBALANCED_RECORD = -1;
export const UNREADABLE_RECORD = -2;
export function findEntityLength(buf: Uint8Array, pos: number, startOffset: number): number {
  const len = buf.length;
  let depth = 0;

  while (pos < len) {
    const char = buf[pos];

    if (char === QUOTE) {
      // Returns `-1` on an unterminated literal (see skipStringLiteral's own
      // doc): nothing after it is readable.
      const next = skipStringLiteral(buf, pos, len);
      if (next < 0) return UNREADABLE_RECORD;
      pos = next;
    } else if (opensComment(buf, pos, len)) {
      const end = skipComment(buf, pos, len);
      // Unterminated: the rest of the input is inside the comment.
      if (end < 0) return UNREADABLE_RECORD;
      pos = end;
    } else if (char === LPAREN) {
      depth++;
      pos++;
    } else if (char === RPAREN) {
      depth--;
      pos++;
      if (depth === 0) return pos - startOffset;
    } else {
      pos++;
    }
  }

  return UNBALANCED_RECORD; // ran out of input with the '(' still open
}

/**
 * Offset just past the `)` balancing the record's own `(`, or one of
 * `UNBALANCED_RECORD` / `UNREADABLE_RECORD`.
 *
 * The byte a scan resumes at after dropping a record it refused, and the two
 * failures a caller must tell apart to know whether it may resume at all.
 */
export function recordCloseOffset(
  buf: Uint8Array,
  parenPos: number,
  startOffset: number,
): number {
  const length = findEntityLength(buf, parenPos, startOffset);
  return length > 0 ? startOffset + length : length;
}

/**
 * Whether the `;` at `semi` terminates the record that closes at `close` (from
 * `recordCloseOffset`).
 *
 * Only for the case a caller's backwards whitespace walk could not settle: on
 * a record with a trailing comment before its `;` the walk lands on the last
 * byte of the comment close, and it cannot see through a comment (searching
 * back for the opener would find one written inside a string literal).
 * Skipping the trivia after
 * the closing `)` answers it exactly, for any run of comments, and runs only
 * here -- never on a record whose `)` sits directly before its `;`.
 *
 * Takes `close` rather than recomputing it so the caller, which needs the same
 * offset to resume from when this returns false, balances the record once.
 */
export function semicolonClosesRecord(
  buf: Uint8Array,
  close: number,
  semi: number,
): boolean {
  if (close <= 0) return false;
  const after = skipTrivia(buf, close, buf.length);
  return !after.stop && after.next === semi;
}
