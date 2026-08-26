/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ISO 10303-21 lexical skipping: comments, and the string literals that must
// not be mistaken for them. Two representations, one rule -- bytes for the
// tokenizer, a decoded string for the header reader. See the divider below for
// the one point where they deliberately differ.
//
// The BYTE half below is written with line comments, not JSDoc, so the
// delimiters can be spelled literally. Escaping them with a zero-width space to
// survive a block comment puts invisible Unicode in the one place that explains
// how comment termination works, and anyone copying the example into a fixture
// then gets a string that is not a valid terminator.
//
// The string half uses JSDoc, because it is a public class whose methods want
// hover documentation, and escapes the delimiter as the backslash form instead.
// Two conventions in one file is not ideal; it is the smaller cost.

const SLASH = 0x2f; // '/'
const STAR = 0x2a; // '*'
const NEWLINE = 0x0a; // '\n'
const QUOTE = 0x27; // '\''

// Whether a comment opens at `pos`.
export function opensComment(buf: Uint8Array, pos: number, len: number): boolean {
  return buf[pos] === SLASH && pos + 1 < len && buf[pos + 1] === STAR;
}

// Index just past the */ closing the comment that opens at `pos`, or -1 when it
// is never closed.
//
// A STEP comment can contain anything, including a complete entity record. That
// is not hypothetical: files ship elements commented out for a revision, and
// such a record is well-formed, so every downstream shape check accepts it. The
// guard added in #856 requires a #<digits> to be followed by '=', which rejects
// a bare #1 in prose and cannot reject a commented-out record, because that
// record has its '='. The region has to be skipped as a region.
//
// Nesting is not supported, and must not be: ISO 10303-21 comments do not nest,
// so the first */ closes the comment, and treating an inner /* as a new level
// would swallow live records after it.
//
// This function is not string-aware and must not be called from inside a
// string literal. Callers skip literals with skipStringLiteral first, which is
// what keeps a /* inside a HEADER description from opening a comment.
//
// Known, shared with the Rust EntityScanner, and deliberately NOT fixed here:
// ISO 10303-21 allows a comment anywhere whitespace is allowed, and none of the
// scanners treat one as trivia *within* a record. Two shapes, both pre-existing
// and both unchanged by this file:
//
//   #1 /* note */ = IFCWALL();        header: fails the '=' check, no record
//   #1=IFCWALL('a', /* n; */ $);      body: ends early at the ';' in the comment
//
// That is true of scanEntities, of scanEntitiesFast, of the worker scanner, and
// of the Rust side, whose next_entity wants '=' straight after the digits and
// whose find_entity_end jumps to the next quote or semicolon with memchr2.
// Correcting it on the TypeScript side alone would put the JS fallback and the
// wasm scan at odds on well-formed files, so it wants one change across all
// four loops rather than a partial one here. Separate defect.
//
// The literal skip above is a smaller version of the same tension and is worth
// naming rather than hiding. Rust has no literal skip outside a record, so on a
// malformed file carrying an unpaired quote in DATA the two now disagree: this
// consumes to the next quote, Rust does not. Accepted because it only affects
// files that are already malformed, and it fails in the same direction as the
// unterminated-comment rule. Worth giving the Rust scanner the same skip.
export function skipComment(buf: Uint8Array, pos: number, len: number): number {
  let p = pos + 2;
  while (p + 1 < len) {
    if (buf[p] === STAR && buf[p + 1] === SLASH) return p + 2;
    p++;
  }
  return -1;
}

// Index just past the closing quote of the literal opening at `pos`, or `len`
// when it never closes. A doubled '' is an escaped quote and stays inside.
//
// Scanners consume a literal whole so nothing inside it can be mistaken for
// syntax. Without this, a HEADER description reading `'rev /* pending'` opens a
// comment that never closes, and the scanner drops the entire DATA section of
// a legal file. A `#12=` inside such a string was equally readable as a record.
// The outer loops walk HEADER records byte by byte, since those carry no `#` to
// consume them, so HEADER is exactly where this bites.
export function skipStringLiteral(buf: Uint8Array, pos: number, len: number): number {
  let p = pos + 1;
  while (p < len) {
    if (buf[p] === QUOTE) {
      if (p + 1 < len && buf[p + 1] === QUOTE) {
        p += 2;
        continue;
      }
      return p + 1;
    }
    p++;
  }
  return len;
}

export interface Skip {
  // Index to continue scanning from.
  next: number;
  // Newlines crossed, to add to the caller's line counter.
  lines: number;
  // True when scanning must stop: an unterminated comment runs to EOF, so
  // there is nothing left to find. Matches the Rust scanner returning None.
  stop: boolean;
}

// Skip a string literal or a comment starting at `pos`. Callers test
// `opensLiteralOrComment` first, so this is only reached on a byte that starts
// one. Shared by both generators, which otherwise held two copies of the rule.
export function skipLexical(buf: Uint8Array, pos: number, len: number): Skip {
  if (buf[pos] === QUOTE) {
    const next = skipStringLiteral(buf, pos, len);
    return { next, lines: countNewlines(buf, pos, next), stop: false };
  }
  const next = skipComment(buf, pos, len);
  if (next < 0) {
    return { next: len, lines: countNewlines(buf, pos, len), stop: true };
  }
  return { next, lines: countNewlines(buf, pos, next), stop: false };
}

// Whether a string literal or a comment starts at `pos`.
export function opensLiteralOrComment(buf: Uint8Array, pos: number, len: number): boolean {
  return buf[pos] === QUOTE || opensComment(buf, pos, len);
}

// Newlines in [from, to), so a skipped region does not desync line numbers.
export function countNewlines(buf: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let p = from; p < to; p++) {
    if (buf[p] === NEWLINE) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The same rule over a decoded string.
//
// The functions above scan `Uint8Array`, which is what the tokenizer holds. The
// header reader (`source-header.ts`) works on a decoded string and slices with
// CHARACTER offsets, so it cannot use them without moving its whole read onto
// bytes. Both representations live here so the rule has one owner rather than
// one per caller, which is the shape #3284 was.
//
// They differ on exactly one point, deliberately. `skipLexical` above answers
// an unterminated comment with `{stop: true}`, running it to end of input,
// because the tokenizer is already past the point of deciding anything. Below,
// an unterminated `/*` is simply NOT a comment: a header prescan that swallows
// every later record has lost the schema, which is a worse answer than the two
// mistyped characters deserve.
// ---------------------------------------------------------------------------

/**
 * A scan of one decoded string.
 *
 * The buffer and the scan state are bound together on purpose. The state is a
 * memo: once a `*\/` search from some `i` fails, no closer exists at or after
 * any later position either, so no later `/*` can open a comment. Every scan
 * here moves its index forward monotonically, so AT MOST ONE closer search can
 * ever fail, and every other one succeeds and consumes a span disjoint from the
 * rest. That is what keeps the whole thing linear.
 *
 * Two earlier shapes were both wrong, and the second was mine:
 *
 *   - searching for the closer at every `/*` is QUADRATIC. A failing search
 *     runs to the end of the text, the caller advances one character, and the
 *     next `/*` repeats it. A 64 KiB header holding 21000 unterminated `/*`
 *     took 5.7 seconds.
 *   - hoisting `lastIndexOf('*\/')` to the top of each scan fixes that but
 *     makes every scan pay a full pass over the buffer even when the input is
 *     well formed and the answer is 100 bytes in. The Rust twin is handed whole
 *     uncapped files, where that measured 250ns -> 52ms on 200 MB.
 *
 * Deferring the search until a `/*` is actually seen, and remembering the one
 * failure, costs nothing on well-formed input and stays linear on hostile
 * input.
 *
 * Binding the buffer to the state also removes an invariant that was previously
 * only checkable by hand: the old free functions took the closer position as an
 * argument, so passing one derived from a DIFFERENT string compiled and
 * silently mis-scanned.
 */
export class StepTextScan {
  /** `*\/` searches performed. At most one of them can fail; see the class doc. */
  searches = 0;
  private noCloser = false;

  constructor(private readonly text: string) {}

  /**
   * If a `/* ... *\/` comment starts at `text[i]`, the index just past it.
   * Otherwise -1.
   *
   * An UNTERMINATED `/*` is not a comment. Running it to end-of-text would
   * swallow every record after it and lose the whole header, which is worse
   * than the malformed input deserves and worse than doing nothing. Treating it
   * as ordinary text costs only that one `/`, and the scan still advances.
   */
  skipCommentAt(i: number): number {
    const { text } = this;
    if (text[i] !== '/' || text[i + 1] !== '*') return -1;
    if (this.noCloser) return -1;
    this.searches++;
    const close = text.indexOf('*/', i + 2);
    if (close < 0) {
      this.noCloser = true;
      return -1;
    }
    return close + 2;
  }

  /**
   * If a string literal or a comment starts at `text[i]`, the index just past
   * it. Otherwise -1.
   *
   * Neither carries structure: a keyword, a comma or a bracket inside one is
   * text. Every scan in `source-header.ts` has to agree on that, so it is one
   * function rather than a copy per loop. #3284 was one file holding two rules
   * for the same thing; three private copies of this loop is that shape again.
   *
   * The result always ADVANCES the caller's index. An earlier form returned the
   * `*\/` offset and left -1 to mean unterminated, which a caller adding 1 to
   * turns into 0: the scan restarts at the top, finds the same comment, and
   * never terminates.
   *
   * The two unterminated cases are deliberately not symmetric. An unterminated
   * literal runs to end-of-text, because a lone `'` cannot be read as ordinary
   * text. An unterminated `/*` is simply not a comment, because it can. This is
   * also where this half differs from `skipLexical` above; see the divider.
   */
  skipLexicalAt(i: number): number {
    const { text } = this;
    if (text[i] === "'") {
      for (let p = i + 1; p < text.length; p++) {
        if (text[p] !== "'") continue;
        if (text[p + 1] === "'") { p++; continue; } // `''` is an escaped quote, not the end
        return p + 1;
      }
      return text.length;
    }
    return this.skipCommentAt(i);
  }

  /**
   * Advance past whitespace and comments. ISO 10303-21 allows a comment
   * wherever whitespace is allowed, including between a record keyword and its
   * `(`.
   *
   * ASCII whitespace only, which is what 10303-21 means. `/\s/` also matches
   * U+00A0 and the other Unicode space separators, while the Rust half tests
   * bytes, so the two halves disagreed on `FILE_SCHEMA (('IFC2X3'))`.
   */
  skipTrivia(i: number): number {
    const { text } = this;
    for (;;) {
      while (i < text.length && isAsciiSpace(text[i])) i++;
      const skip = this.skipCommentAt(i);
      if (skip < 0) return i;
      i = skip;
    }
  }
}

/** ASCII whitespace per ISO 10303-21. See `StepTextScan.skipTrivia`. */
function isAsciiSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Case-insensitive ASCII compare of `keyword` against `text` at `i`. Callers
 * pass upper-case keywords.
 *
 * Compares character by character instead of uppercasing a copy of `text`,
 * because a copy cannot be indexed into. `'ß'.toUpperCase()` is two characters,
 * so one of them shifts every later offset, and the caller then slices the
 * ORIGINAL text with an offset measured in the copy.
 *
 * ASCII-only on purpose. That is what ISO 10303-21 case-insensitivity means,
 * and it declines the matches a full Unicode fold accepts: `'ſ'` (long s)
 * uppercases to `'S'`, so a full fold reads ` ENDſEC` as `ENDSEC`.
 */
export function matchesKeywordAt(text: string, i: number, keyword: string): boolean {
  for (let k = 0; k < keyword.length; k++) {
    let c = text.charCodeAt(i + k); // NaN past the end, and NaN !== anything
    if (c >= 97 && c <= 122) c -= 32;
    if (c !== keyword.charCodeAt(k)) return false;
  }
  return true;
}

