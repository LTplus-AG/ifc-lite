/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-slot half of the STEP argument reader: given ONE part that
 * `splitTopLevelStepArguments` (`step-argument-parser.ts`) separated on a
 * top-level comma, is that part a single well-formed STEP value?
 *
 * This is the TypeScript twin of `ifc_lite_core::parser::is_step_value`
 * (F4 M-export-a, #7778), and both are held to
 * `rust/core/tests/fixtures/step_slot_vectors.json`
 * (`step-slot-vectors.parity.test.ts` here, `slots_tests.rs` there). The
 * grammar is the one the STEP tokenizer reads, so whatever passes is a token
 * on the reading side: a string `'...'`, a binary `"[0-3]hex*"`, `$`, `*`, a
 * reference `#digits`, an enumeration `.NAME.`, a number, a list `( ... )`
 * or a typed value `NAME( ... )`. Not values, because the tokenizer reads
 * none of them: a bare keyword, `1..2`, `#+5`, an empty list element
 * (`(1,,2)`), a binary with a non-hex byte, an integer beyond `i64`. The
 * whitespace is the STEP set (space, tab, LF, CR, FF, VT), never `\s`, so a
 * no-break space is not padding. A comment that never closes is not trivia.
 *
 * The scan carries its nesting in a counter rather than recursing, so no input
 * can exhaust the stack; nesting past {@link MAX_SLOT_NESTING_DEPTH} (the
 * tokenizer's bound) is refused like any other malformed part. The recursive
 * descent this replaced bounded nesting at 64 because it could throw
 * `RangeError` (#4213); the loop has no such floor.
 */

import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { isCompleteStepNumericLiteral } from '@ifc-lite/data';

/** The tokenizer's nesting bound (`MAX_NESTING_DEPTH` in core's tokenizer). */
const MAX_SLOT_NESTING_DEPTH = 256;

const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;
const U32_MAX = 4294967295;

/** The STEP whitespace set, as core's `is_step_space`. */
export function isStepSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/** Whether `text` is empty or only STEP whitespace. */
export function isStepBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isStepSpaceCode(text.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Index past the whitespace and `/* ... *\/` comments starting at `from`, or
 * -1 when a comment never closes (core's `skip_step_trivia`).
 */
export function skipStepTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && isStepSpaceCode(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) === 0x2f && text.charCodeAt(i + 1) === 0x2a) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    return i;
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isNameCode(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function isHexCode(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isNumberRunCode(code: number): boolean {
  return isDigit(code) || code === 0x2b || code === 0x2d || code === 0x2e || code === 0x45 || code === 0x65;
}

/** Index past the run of name characters at `from`. */
function nameEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isNameCode(text.charCodeAt(i))) i++;
  return i;
}

/**
 * Index past the number at `from`, or -1: one complete STEP numeric literal
 * (core's `read_step_number`), an `INTEGER` within `i64`.
 */
function numberEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isNumberRunCode(text.charCodeAt(i))) i++;
  const token = text.slice(from, i);
  if (!isCompleteStepNumericLiteral(token)) return -1;
  if (!/[.eE]/.test(token)) {
    const value = BigInt(token);
    if (value > I64_MAX || value < I64_MIN) return -1;
  }
  return i;
}

/**
 * Whether `value` is exactly ONE STEP value, trivia allowed around it and
 * between its parts. See the module comment for the grammar.
 */
export function isStepValue(value: string): boolean {
  const n = value.length;
  let i = skipStepTrivia(value, 0);
  if (i === -1) return false;
  let depth = 0;
  // Whether the next thing read is a value (after `(` or `,`) rather than a
  // separator (after a value).
  let expectValue = true;
  for (;;) {
    if (expectValue) {
      if (i >= n) return false;
      const code = value.charCodeAt(i);
      const openList = (from: number): boolean => {
        depth++;
        if (depth > MAX_SLOT_NESTING_DEPTH) return false;
        i = skipStepTrivia(value, from);
        if (i === -1) return false;
        // An empty list is a value; an element may not be empty.
        if (value.charCodeAt(i) === 0x29) {
          depth--;
          i++;
          expectValue = false;
        }
        i = skipStepTrivia(value, i);
        return i !== -1;
      };
      if (code === 0x27) {
        const end = stepStringLiteralEnd(value, i);
        if (end === -1) return false;
        i = end;
      } else if (code === 0x22) {
        const close = value.indexOf('"', i + 1);
        if (close === -1) return false;
        const first = value.charCodeAt(i + 1);
        if (close === i + 1 || first < 0x30 || first > 0x33) return false;
        for (let k = i + 2; k < close; k++) {
          if (!isHexCode(value.charCodeAt(k))) return false;
        }
        i = close + 1;
      } else if (code === 0x24 || code === 0x2a) {
        i++;
      } else if (code === 0x23) {
        let end = i + 1;
        while (end < n && isDigit(value.charCodeAt(end))) end++;
        if (end === i + 1 || Number(value.slice(i + 1, end)) > U32_MAX) return false;
        i = end;
      } else if (code === 0x2e && i + 1 < n && !isDigit(value.charCodeAt(i + 1))) {
        const end = nameEnd(value, i + 1);
        if (end === i + 1 || value.charCodeAt(end) !== 0x2e) return false;
        i = end + 1;
      } else if (code === 0x28) {
        if (!openList(i + 1)) return false;
        continue;
      } else if (code === 0x2b || code === 0x2d || code === 0x2e || isDigit(code)) {
        const end = numberEnd(value, i);
        if (end === -1) return false;
        i = end;
      } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f) {
        const open = skipStepTrivia(value, nameEnd(value, i));
        // A bare keyword is no value.
        if (open === -1 || value.charCodeAt(open) !== 0x28) return false;
        if (!openList(open + 1)) return false;
        continue;
      } else {
        return false;
      }
      expectValue = false;
      i = skipStepTrivia(value, i);
      if (i === -1) return false;
      continue;
    }
    // A value just closed: at depth zero it was the whole slot.
    if (depth === 0) return i === n;
    const code = value.charCodeAt(i);
    if (code === 0x29) depth--;
    else if (code === 0x2c) expectValue = true;
    else return false;
    i = skipStepTrivia(value, i + 1);
    if (i === -1) return false;
  }
}

/**
 * Whether `part` — one slot `splitTopLevelStepArguments` already separated on
 * a top-level comma, raw text including any surrounding whitespace or
 * comments — is a single well-formed STEP value, or is empty.
 *
 * Empty is deliberately accepted, matching `splitTopLevelStepArguments`:
 * `a,,b` is one empty part, not a rejection, so slot indices after it stay
 * aligned with what the entity parser counts. A part that is ONLY a comment is
 * NOT given that pass: counting it as one more empty slot would shift every
 * index after it.
 */
export function isWellFormedStepSlot(part: string): boolean {
  return isStepBlank(part) || isStepValue(part);
}
