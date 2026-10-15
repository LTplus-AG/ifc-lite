/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a `#id=TYPE(args);` record's parts sit in its text: the one reader
 * every STEP writer in this package frames a record with before it edits one
 * (#7682, EXPORT-STEP-1).
 *
 * ISO 10303-21 allows trivia (whitespace, including vertical tab and form
 * feed, and `/* ... *​/` comments) wherever whitespace may go, so
 * `#5=IFCWALL(...) ;` and `#5=IFCWALL(...) /* c *​/;` are records like any
 * other. The writers used to find the frame each their own way, and the ones
 * that looked for a literal `');'` read those records as no record at all:
 * every named, positional and retype edit on them was dropped and nothing
 * reported it.
 *
 * This is the matched half of `rust/export/src/step_record_frame.rs`; the two
 * are changed together and pinned by the shared parity vectors in
 * `rust/export/tests/fixtures/step_log_parity_vectors.json`. Trivia follows
 * core's `skip_step_trivia` / `is_step_space` (`skipTrivia` / `isSpaceByte` in
 * `@ifc-lite/parser`'s `step-lexing.ts`): ASCII whitespace only, and an
 * unterminated comment ends the scan with nothing found.
 *
 * The close is found from the END, the way the writers found it before: the
 * last `)` that only trivia and one `;` follow. A forward scan would have to
 * trust the record's string literals, and a record with an undoubled
 * apostrophe would then have no frame at all, where it now has one whose
 * argument list the slot splitter refuses and the caller reports as
 * unreadable. The candidate found walking back is then checked forward, so a
 * frame returned is always one the forward trivia rule agrees with.
 */

/** `#id=TYPE(`: everything a record's head says, as string offsets. */
export interface StepRecordHead {
  /** The `=` after the instance name. */
  readonly eq: number;
  /** The type keyword, `typeStart..typeEnd`. */
  readonly typeStart: number;
  readonly typeEnd: number;
  /** The `(` that opens the argument list. */
  readonly open: number;
}

/** A whole record: its head, the `)` closing the argument list, and the `;`. */
export interface StepRecordFrame {
  readonly head: StepRecordHead;
  readonly close: number;
  readonly semi: number;
}

/** `is_step_space`: space, tab, LF, CR, vertical tab, form feed. */
function isStepSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

/** `skip_step_trivia`: the first index at or after `i` that is not trivia, or -1 when a comment never closes. */
function skipTrivia(text: string, i: number): number {
  let p = i;
  for (;;) {
    while (p < text.length && isStepSpace(text.charCodeAt(p))) p++;
    if (!(text[p] === '/' && text[p + 1] === '*')) return p;
    const end = text.indexOf('*/', p + 2);
    if (end === -1) return -1;
    p = end + 2;
  }
}

/**
 * `#digits TRIVIA =`: the line declares an entity instance, whatever follows
 * the `=`. Trivia, comments included, sits before the `=` as core's scanner
 * reads it: `#48/* c *​/=(IFCA(..)IFCB(..));` is a record. A scanner indexes records {@link stepRecordHead} does not read (a
 * complex instance `#N=(IFCA(..)IFCB(..));`, a non-ASCII character after the
 * `=` or before the `(`), so a line that opens like this and has no frame is an
 * UNREADABLE record, never "no record": an edit queued for it is reported, not
 * passed over (#7682 review).
 */
export function opensStepRecord(text: string): boolean {
  let i = skipTrivia(text, 0);
  if (i === -1 || text[i] !== '#') return false;
  i++;
  const digits = i;
  while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
  if (i === digits) return false;
  const eq = skipTrivia(text, i);
  return eq !== -1 && text[eq] === '=';
}

function isKeywordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/**
 * The record's head, or null when `text` does not open as
 * `#digits = KEYWORD (`, trivia allowed around the `=` and before the `(`.
 */
export function stepRecordHead(text: string): StepRecordHead | null {
  let i = skipTrivia(text, 0);
  if (i === -1 || text[i] !== '#') return null;
  i++;
  const digits = i;
  while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
  if (i === digits) return null;
  const eq = skipTrivia(text, i);
  if (eq === -1 || text[eq] !== '=') return null;
  const typeStart = skipTrivia(text, eq + 1);
  if (typeStart === -1) return null;
  let typeEnd = typeStart;
  while (isKeywordChar(text[typeEnd])) typeEnd++;
  if (typeEnd === typeStart) return null;
  const open = skipTrivia(text, typeEnd);
  if (open === -1 || text[open] !== '(') return null;
  return { eq, typeStart, typeEnd, open };
}

/**
 * Where a trailing comment that ends just before `end` (with `*​/`) starts. A
 * comment cannot hold `*​/`, so it opens at one of the `/*` after the previous
 * `*​/`: the nearest one unless the comment itself holds a `/*`, else the first
 * one unless a string in the record body holds a `*​/` and a `/*`. Neither
 * guess is trusted: {@link stepRecordFrame} tries both and keeps the one the
 * forward check confirms.
 */
function commentStart(text: string, end: number, nearest: boolean): number {
  const body = text.slice(0, end);
  if (nearest) return body.lastIndexOf('/*');
  const prev = body.lastIndexOf('*/');
  const floor = prev === -1 ? 0 : prev + 2;
  return body.indexOf('/*', floor);
}

/** Walk back over trivia ending just before `k`. */
function triviaBack(text: string, k: number, nearest: boolean): number {
  for (;;) {
    while (k > 0 && isStepSpace(text.charCodeAt(k - 1))) k--;
    if (k < 4 || text[k - 2] !== '*' || text[k - 1] !== '/') return k;
    const start = commentStart(text, k - 2, nearest);
    if (start === -1) return k;
    k = start;
  }
}

function frameWith(text: string, head: StepRecordHead, nearest: boolean): StepRecordFrame | null {
  const semi = triviaBack(text, text.length, nearest) - 1;
  if (semi < 0 || text[semi] !== ';') return null;
  const close = triviaBack(text, semi, nearest) - 1;
  if (close <= head.open || text[close] !== ')') return null;
  // The walk back is a guess about where the trailing comments begin; the
  // forward trivia rule is what decides it.
  const verified = skipTrivia(text, close + 1) === semi && skipTrivia(text, semi + 1) === text.length;
  return verified ? { head, close, semi } : null;
}

/**
 * The record's frame, or null when `text` is not one whole record:
 * {@link stepRecordHead}, then a `)` that only trivia, one `;` and trivia follow.
 */
export function stepRecordFrame(text: string): StepRecordFrame | null {
  const head = stepRecordHead(text);
  if (head === null) return null;
  return frameWith(text, head, true) ?? frameWith(text, head, false);
}

/** The text between the argument list's parentheses. */
export function frameArgs(text: string, frame: StepRecordFrame): string {
  return text.slice(frame.head.open + 1, frame.close);
}

/** `text` with its argument list replaced, every other character kept. */
export function withFrameArgs(text: string, frame: StepRecordFrame, args: string): string {
  return `${text.slice(0, frame.head.open + 1)}${args}${text.slice(frame.close)}`;
}
