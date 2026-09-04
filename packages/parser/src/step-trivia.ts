/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regex source for ISO 10303-21 "trivia": a run of ASCII whitespace and
 * non-nesting `/* ... *​/` comments, in any order, ANYWHERE whitespace is
 * legal in a record — including between a type name and its `(`.
 *
 * String-side counterpart to `skipTrivia` in `step-lexing.ts`, for callers
 * that already hold a decoded record as a JS string and build a regex around
 * it (entity/typed-value extraction and rewriting), rather than scanning raw
 * bytes. Both mirror `skip_step_trivia` in `rust/core/src/parser/lexical.rs`.
 *
 * Deliberately ASCII-only (`[ \t\n\r\x0b\x0c]`, matching `is_step_space` /
 * `isSpaceByte` in `step-lexing.ts`) rather than `\s`, which also matches
 * U+00A0 and other Unicode space separators Rust's byte scanner does not
 * treat as whitespace — the exact TS/Rust divergence class issue #3733
 * fixed for the byte scanners; a new trivia matcher should not reintroduce
 * it under a different name.
 *
 * ## Why each alternative is shaped the way it is
 *
 * The outer `(?:A|B)*` must have exactly ONE way to partition any input into
 * iterations. Where it has more than one, a failing suffix makes the engine
 * enumerate them, which is exponential in the length of the trivia run. Both
 * alternatives below are written to keep that count at one, and BOTH shapes
 * have been measured — the two axes fail independently, so neither is
 * theoretical:
 *
 * - The comment body is `(?:[^*]|\*(?!/))*`, NOT a lazy `[\s\S]*?`. A lazy
 *   body looks unambiguous locally, but when the overall pattern fails past
 *   a comment the engine retries it against every later `*​/`, so one comment
 *   can absorb the ones after it and the two alternatives start overlapping
 *   on the same span. Requiring every `*` in the body to not be followed by
 *   `/` gives the body exactly one maximal extent, so a comment can never
 *   swallow the next one.
 * - The whitespace alternative is a SINGLE-CHARACTER class, NOT `[...]+`.
 *   This is the counter-intuitive half: `+` looks like it collapses a run
 *   into one iteration, but the outer `*` can still split an n-character run
 *   into any composition of `+` matches (2^(n-1) of them) and walks all of
 *   them on failure — the textbook `(?:A+|B)*` blowup. A single-character
 *   class has exactly one partition: n iterations of one character each.
 *
 * Both hazards are pinned by `packages/parser/test/step-trivia-redos.test.ts`,
 * one case per axis, and the test comment there carries the measurements.
 * Change either alternative only with that test in front of you.
 *
 * ## Relation to the byte scanners
 *
 * The comment body also brings this pattern into line with
 * `skip_step_trivia`, which stops a comment at its FIRST `*​/`. A lazy body
 * did not: on backtracking it would accept `/* a *​/ *​/` as one comment,
 * where Rust reads a comment followed by junk and refuses the record. The
 * shared vector "reject: comments do not nest, so the trailing `*​/` is junk"
 * in `rust/core/tests/fixtures/type_paren_trivia_vectors.json` pins that
 * agreement, so this is a deliberate narrowing, not an accident.
 *
 * An unpaired, unterminated `/*` still fails to match rather than hanging:
 * the body runs out of input, backtracking is O(1) per position, and the
 * required `\*​/` after it never appears.
 */
export const STEP_TRIVIA = '(?:[ \\t\\n\\r\\x0b\\x0c]|/\\*(?:[^*]|\\*(?!/))*\\*/)*';
