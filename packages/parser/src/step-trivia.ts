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
 * The comment body is `[\s\S]*?` (lazy, not `[\s\S]*`): for every WELL-FORMED
 * comment this is the same match either quantifier would settle on — regex
 * backtracking tries longer alternatives too when a shorter one leaves the
 * rest of the pattern unsatisfied, so laziness alone is not a correctness
 * guarantee here. Kept lazy anyway because it is the closer analogue of
 * `skip_step_comment`'s forward-only, no-backtracking scan and never matches
 * MORE than necessary when a match exists at all. Neither quantifier can, by
 * itself, reproduce that scanner's true non-nesting semantics on adversarial
 * input containing a bare, unpaired `*​/` before the real one (regex
 * backtracking will walk past it looking for a way to complete the overall
 * pattern) — accepted because ISO 10303-21 forbids an unpaired `*​/` outside
 * a comment, so producing one requires an already-malformed file, and this
 * module is reached only after the record has matched a much stricter
 * historical adjacency test suite (see `wrapped-type-paren-adjacency.test.ts`)
 * that covers every case a real STEP writer produces.
 */
export const STEP_TRIVIA = '(?:[ \\t\\n\\r\\x0b\\x0c]|/\\*[\\s\\S]*?\\*/)*';
