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
 * Both alternatives are written so the outer `(?:A|B)*` has exactly one way
 * to partition any given input into iterations — there is nothing left for
 * the engine to backtrack over:
 *
 * - The comment body is `(?:[^*]|\*(?!/))*`, not `[\s\S]*?`. A lazy
 *   `[\s\S]*?` looks unambiguous locally, but when the *overall* pattern
 *   fails past a comment, the engine retries the lazy body against every
 *   later `*​/` in the string, so one comment can absorb subsequent ones and
 *   the two alternatives (comment vs. whitespace) start overlapping on the
 *   same span. That overlap is what makes `(?:A|B)*` exponential: with N
 *   well-formed, back-to-back `/**​/` comments there are ~2^N ways to
 *   group them into "one comment eats the rest" vs. "N separate comments",
 *   and a failing suffix forces the engine to try all of them. Measured
 *   with the OLD (lazy-body) pattern against `'#5=IFCWALL' + '/**​/'.repeat(n)`
 *   with no closing `(`: n=25 ~0.1s, n=28 ~0.8s, n=30 ~3s+ (machine-
 *   dependent, but the doubling-per-comment growth is the signature).
 *   `(?:[^*]|\*(?!/))*` forbids that: every `*` inside the body must NOT be
 *   followed by `/`, so the body has exactly one maximal extent for a given
 *   start position — no shorter match is ever retried, and one comment can
 *   never swallow the next.
 * - The whitespace alternative is `[ \t\n\r\x0b\x0c]+`, not a bare
 *   character class. A single-char alternative has no quantifier of its own
 *   so it does not carry the same exponential risk by itself (measured:
 *   with the comment body already unambiguous, restoring the single-char
 *   class stays linear even against 200k whitespace characters) — but `+`
 *   still removes a second, cheaper redundancy: without it the outer `*`
 *   has many ways to split one whitespace run into N single-character
 *   iterations, all recombined on backtracking. `+` collapses a run to one
 *   iteration, so there is only one partition to consider there too.
 *
 * Both changes preserve the language exactly: still any run, in any order,
 * of STEP whitespace and paired `/* ... *​/` comments. Only the matching
 * *path* changed, verified with a ~111k-case fuzz comparison of the old and
 * new patterns over well-formed whitespace/comment combinations (0
 * mismatches) plus the two-way rejection and adversarial-input suites in
 * `wrapped-type-paren-adjacency.test.ts` and the trivia timing test.
 *
 * An unpaired, unterminated `/*` (no matching `*​/` anywhere after it) still
 * correctly fails to match rather than hanging: `(?:[^*]|\*(?!/))*` simply
 * runs out of input, backtracking is O(1) per position (no ambiguity to
 * explore), and the required `\*​/` after the body never appears. Note this
 * corrects an earlier version of this comment, which reasoned that an
 * exponential blowup "requires an already-malformed file" — that was wrong:
 * the measurement above uses only well-formed, correctly paired comments;
 * malformed input was never required to trigger it.
 */
export const STEP_TRIVIA = '(?:[ \\t\\n\\r\\x0b\\x0c]+|/\\*(?:[^*]|\\*(?!/))*\\*/)*';
