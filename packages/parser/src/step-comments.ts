/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ISO 10303-21 comment handling for the byte-level scanners.
//
// Written as line comments, not a JSDoc block, so the delimiters below can be
// spelled literally. Escaping them with a zero-width space to survive a block
// comment puts invisible Unicode in the one place that explains how comment
// termination works, and anyone copying the example into a fixture then gets a
// string that is not a valid terminator.

const SLASH = 0x2f; // '/'
const STAR = 0x2a; // '*'
const NEWLINE = 0x0a; // '\n'

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
// Known and deliberate limitation, shared with the Rust EntityScanner: this is
// not string-aware, so a /* inside a HEADER string literal opens a comment here.
// Callers that can be positioned inside a DATA string literal must not call it;
// see the note on scanEntities.
//
// Also known, also shared, and deliberately NOT fixed here: a comment sitting
// inside a record's parameter list is invisible to the loops that find the end
// of a record. `#1=IFCWALL('a', /* note; here */ $);` ends early, at the
// semicolon inside the comment. That is true of scanEntitiesFast, of the worker
// scanner, and of the Rust find_entity_end, which jumps to the next quote or
// semicolon with memchr2 and knows nothing about comments either. Correcting it
// on the TypeScript side alone would make the JS fallback disagree with the wasm
// scan on the same file, so it wants one change across all four loops rather
// than a partial one here. Separate defect, separate change.
export function skipComment(buf: Uint8Array, pos: number, len: number): number {
  let p = pos + 2;
  while (p + 1 < len) {
    if (buf[p] === STAR && buf[p + 1] === SLASH) return p + 2;
    p++;
  }
  return -1;
}

// Newlines in [from, to), so a skipped region does not desync line numbers.
export function countNewlines(buf: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let p = from; p < to; p++) {
    if (buf[p] === NEWLINE) n++;
  }
  return n;
}
