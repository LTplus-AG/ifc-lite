/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an ISO 10303-21 string literal ends, for every walker that splits,
 * rewrites or scans STEP text (#7589).
 *
 * Inside a literal, `''` is an escaped quote and the PAGE directive `\S\` takes
 * the next character as its operand, which may itself be an apostrophe:
 * `'Para \S\' 5'` is one literal reading "Para § 5". The entity scanners learnt
 * that in #7540; a walker that ends the literal at the operand misreads every
 * later comma, paren and reference in the record. The PAGE test comes first,
 * because `'5\S\''` is "5§" and closes at its last quote, and no other legal
 * string unit can end in `\S\` right before a quote, so the lookback cannot
 * misfire on a legal file. The byte-level twin is `isPageQuoteOperand` in
 * `@ifc-lite/parser` (`step-lexing.ts`); the Rust one is
 * `ifc_lite_core::step_encoding::step_string_literal_end`.
 */

/** Whether the apostrophe at `pos` (inside a literal) is a `\S\` operand. */
export function isStepPageQuoteOperand(text: string, pos: number): boolean {
  return pos >= 3 && text.charCodeAt(pos - 1) === 0x5c && text.charCodeAt(pos - 2) === 0x53
    && text.charCodeAt(pos - 3) === 0x5c;
}

/**
 * Index just past the apostrophe closing the literal whose opening apostrophe
 * is at `open`, or `-1` when it never closes.
 */
export function stepStringLiteralEnd(text: string, open: number): number {
  for (let p = text.indexOf("'", open + 1); p >= 0; p = text.indexOf("'", p + 1)) {
    if (isStepPageQuoteOperand(text, p)) continue;
    if (text.charCodeAt(p + 1) === 0x27) { p++; continue; }
    return p + 1;
  }
  return -1;
}
