/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ISO 10303-21 lexical skipping for the byte-level scanners: comments, and the
// string literals that must not be mistaken for them.
//
// Written as line comments, not a JSDoc block, so the delimiters below can be
// spelled literally. Escaping them with a zero-width space to survive a block
// comment puts invisible Unicode in the one place that explains how comment
// termination works, and anyone copying the example into a fixture then gets a
// string that is not a valid terminator.

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
// Known, shared with the Rust EntityScanner, and deliberately NOT fixed here: a
// comment sitting inside a record's parameter list is invisible to the loops
// that find the end of a record. `#1=IFCWALL('a', /* note; here */ $);` ends
// early, at the semicolon inside the comment. That is true of scanEntitiesFast,
// of the worker scanner, and of the Rust find_entity_end, which jumps to the
// next quote or semicolon with memchr2 and knows nothing about comments either.
// Correcting it on the TypeScript side alone would make the JS fallback
// disagree with the wasm scan on the same file, so it wants one change across
// all four loops rather than a partial one here. Separate defect.
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
