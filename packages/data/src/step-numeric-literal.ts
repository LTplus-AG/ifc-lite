/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const PLUS = 0x2b;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const UPPER_E = 0x45;
const LOWER_E = 0x65;

function isSign(c: number): boolean {
  return c === PLUS || c === MINUS;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

/**
 * True when `token`, already trimmed, is exactly one legal STEP REAL or
 * INTEGER literal (ISO 10303-21 §5.3): an optional sign, then digits with an
 * optional decimal point (`1`, `1.`, `1.5`) or a bare-dot decimal (`.5`),
 * then an optional exponent (`e`/`E`, optional sign, digits) — nothing before
 * or after.
 *
 * The one copy of this grammar (#5193). `parseFloat` accepts any leading
 * numeric prefix and discards the rest (`parseFloat('1.52.3')` is `1.52`, a
 * dropped comma fused into a plausible coordinate), so every STEP token
 * reader gates on this before trusting it: `parseStepValue`
 * (step-serializers.ts), and `@ifc-lite/parser`'s `parseAttributeValue` and
 * `getNumber`.
 *
 * Hand-rolled rather than a regex: `parseAttributeValue` runs this once per
 * attribute of every entity in the file, on tokens almost always under 20
 * characters, and a single forward scan with no backtracking is cheaper at
 * that call volume than compiling or running a regex engine.
 */
export function isCompleteStepNumericLiteral(token: string): boolean {
  const n = token.length;
  let i = 0;
  if (i < n && isSign(token.charCodeAt(i))) i++;
  let digits = 0;
  while (i < n && isDigit(token.charCodeAt(i))) {
    i++;
    digits++;
  }
  if (i < n && token.charCodeAt(i) === DOT) {
    i++;
    while (i < n && isDigit(token.charCodeAt(i))) {
      i++;
      digits++;
    }
  }
  // A sign, or a lone `.`, with no digit anywhere is not a number attempt at
  // all — reject before considering an exponent, which cannot rescue it.
  if (digits === 0) return false;
  if (i < n) {
    const e = token.charCodeAt(i);
    if (e !== UPPER_E && e !== LOWER_E) return false;
    i++;
    if (i < n && isSign(token.charCodeAt(i))) i++;
    let expDigits = 0;
    while (i < n && isDigit(token.charCodeAt(i))) {
      i++;
      expDigits++;
    }
    if (expDigits === 0) return false;
  }
  return i === n;
}
