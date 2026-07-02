/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decode IFC STEP encoded strings.
 * Handles:
 * - \X2\XXXX\X0\ - Unicode hex encoding (e.g., \X2\00E4\X0\ -> a with umlaut)
 * - \X4\XXXXXXXX\X0\ - Unicode 4-byte hex for chars outside BMP
 * - \X\XX\ - ISO-8859-1 hex encoding
 * - \S\X - Extended ASCII with escape
 * - \P..\ - Code page switches (supported as directives and removed)
 *
 * This handles only backslash escapes. The '' doubled-quote escape is collapsed
 * by the STEP tokenizer's consumers (they strip surrounding quotes and
 * un-double), so decoding must not touch quotes or it would double-collapse.
 */
export function decodeIfcString(str: string): string {
  if (!str || typeof str !== 'string') return str;

  let result = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] !== '\\') {
      result += str[i];
      i += 1;
      continue;
    }

    // Handle code page directives like \PA\, \PB\, ... by consuming them.
    if (str[i + 1] === 'P' && str[i + 3] === '\\') {
      i += 4;
      continue;
    }

    // Handle \S\X where the value is the code point of X plus 128. Read X as a
    // whole code point (advancing past a surrogate pair) so a malformed
    // multi-byte X stays in parity with the Rust decoder instead of leaving a
    // dangling surrogate.
    if (str[i + 1] === 'S' && str[i + 2] === '\\' && i + 3 < str.length) {
      const cp = str.codePointAt(i + 3)!;
      result += String.fromCodePoint(cp + 128);
      i += 3 + (cp > 0xFFFF ? 2 : 1);
      continue;
    }

    // Handle \X\HH (8-bit value from ISO 10646 row 0 / ISO-8859-1 overlap).
    if (str[i + 1] === 'X' && str[i + 2] === '\\' && i + 5 <= str.length) {
      const hex = str.slice(i + 3, i + 5);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        result += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
    }

    // Handle \X2\....\X0\ (UTF-16 hex code units, 4 chars each).
    if (str.startsWith('\\X2\\', i)) {
      const end = str.indexOf('\\X0\\', i + 4);
      if (end !== -1) {
        const hex = str.slice(i + 4, end);
        if (hex.length % 4 === 0 && /^[0-9A-Fa-f]+$/.test(hex)) {
          for (let j = 0; j < hex.length; j += 4) {
            result += String.fromCharCode(parseInt(hex.slice(j, j + 4), 16));
          }
          i = end + 4;
          continue;
        }
      }
    }

    // Handle \X4\........\X0\ (Unicode scalar values, 8 hex digits each).
    if (str.startsWith('\\X4\\', i)) {
      const end = str.indexOf('\\X0\\', i + 4);
      if (end !== -1) {
        const hex = str.slice(i + 4, end);
        if (hex.length % 8 === 0 && /^[0-9A-Fa-f]+$/.test(hex)) {
          for (let j = 0; j < hex.length; j += 8) {
            result += String.fromCodePoint(parseInt(hex.slice(j, j + 8), 16));
          }
          i = end + 4;
          continue;
        }
      }
    }

    // Unknown escape sequence: keep the backslash and move on.
    result += str[i];
    i += 1;
  }

  return result;
}

/**
 * Encode a Unicode string to IFC STEP string escapes.
 *
 * - Printable ASCII (32..126) is kept as-is.
 * - 8-bit values are encoded as \X\HH.
 * - BMP values are encoded as \X2\HHHH\X0\.
 * - Non-BMP values are encoded as \X4\HHHHHHHH\X0\.
 */
export function encodeIfcString(str: string): string {
  if (!str || typeof str !== 'string') return str;

  let encoded = '';
  for (const ch of str) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint >= 32 && codePoint <= 126 && ch !== '\\') {
      encoded += ch;
      continue;
    }

    if (codePoint <= 0xFF) {
      encoded += `\\X\\${codePoint.toString(16).toUpperCase().padStart(2, '0')}`;
      continue;
    }

    if (codePoint <= 0xFFFF) {
      encoded += `\\X2\\${codePoint.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
      continue;
    }

    encoded += `\\X4\\${codePoint.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
  }

  return encoded;
}
