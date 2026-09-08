/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Upper-half (0xA0..0xFF) code-point tables for the ISO 8859 parts a `\P?\`
 * directive can select for a subsequent `\S\` (ISO 10303-21 6.4.3): letters
 * A..I select ISO 8859-1..9 (A=1, the default, needs no table — its upper
 * half is already the Unicode-identity mapping `\S\` used before this
 * change). Index 0 below is codepage 2 (`\PB\`) .. index 7 is codepage 9
 * (`\PI\`). `0000` marks a code position the ISO 8859 part itself leaves
 * unassigned; ISO 10303-21 does not define decoder behaviour there, so
 * {@link resolveExtendedChar} falls back to the raw byte value (the same
 * answer the default page gives) rather than U+FFFD.
 *
 * Source: https://www.unicode.org/Public/MAPPINGS/ISO8859/8859-{2..9}.TXT
 * (verified 2026-08-30). Keep in parity with `CODEPAGE_TABLES` in
 * `rust/core/src/step_encoding.rs` — both are pinned by the codepage cases in
 * `ifc_string_vectors.json`.
 */
const CODEPAGE_ROWS: readonly string[] = [
  // codepage 2: ISO 8859-2 (Central European)
  '00A0 0104 02D8 0141 00A4 013D 015A 00A7 00A8 0160 015E 0164 0179 00AD 017D 017B',
  '00B0 0105 02DB 0142 00B4 013E 015B 02C7 00B8 0161 015F 0165 017A 02DD 017E 017C',
  '0154 00C1 00C2 0102 00C4 0139 0106 00C7 010C 00C9 0118 00CB 011A 00CD 00CE 010E',
  '0110 0143 0147 00D3 00D4 0150 00D6 00D7 0158 016E 00DA 0170 00DC 00DD 0162 00DF',
  '0155 00E1 00E2 0103 00E4 013A 0107 00E7 010D 00E9 0119 00EB 011B 00ED 00EE 010F',
  '0111 0144 0148 00F3 00F4 0151 00F6 00F7 0159 016F 00FA 0171 00FC 00FD 0163 02D9',
  // codepage 3: ISO 8859-3 (South European)
  '00A0 0126 02D8 00A3 00A4 0000 0124 00A7 00A8 0130 015E 011E 0134 00AD 0000 017B',
  '00B0 0127 00B2 00B3 00B4 00B5 0125 00B7 00B8 0131 015F 011F 0135 00BD 0000 017C',
  '00C0 00C1 00C2 0000 00C4 010A 0108 00C7 00C8 00C9 00CA 00CB 00CC 00CD 00CE 00CF',
  '0000 00D1 00D2 00D3 00D4 0120 00D6 00D7 011C 00D9 00DA 00DB 00DC 016C 015C 00DF',
  '00E0 00E1 00E2 0000 00E4 010B 0109 00E7 00E8 00E9 00EA 00EB 00EC 00ED 00EE 00EF',
  '0000 00F1 00F2 00F3 00F4 0121 00F6 00F7 011D 00F9 00FA 00FB 00FC 016D 015D 02D9',
  // codepage 4: ISO 8859-4 (North European)
  '00A0 0104 0138 0156 00A4 0128 013B 00A7 00A8 0160 0112 0122 0166 00AD 017D 00AF',
  '00B0 0105 02DB 0157 00B4 0129 013C 02C7 00B8 0161 0113 0123 0167 014A 017E 014B',
  '0100 00C1 00C2 00C3 00C4 00C5 00C6 012E 010C 00C9 0118 00CB 0116 00CD 00CE 012A',
  '0110 0145 014C 0136 00D4 00D5 00D6 00D7 00D8 0172 00DA 00DB 00DC 0168 016A 00DF',
  '0101 00E1 00E2 00E3 00E4 00E5 00E6 012F 010D 00E9 0119 00EB 0117 00ED 00EE 012B',
  '0111 0146 014D 0137 00F4 00F5 00F6 00F7 00F8 0173 00FA 00FB 00FC 0169 016B 02D9',
  // codepage 5: ISO 8859-5 (Cyrillic)
  '00A0 0401 0402 0403 0404 0405 0406 0407 0408 0409 040A 040B 040C 00AD 040E 040F',
  '0410 0411 0412 0413 0414 0415 0416 0417 0418 0419 041A 041B 041C 041D 041E 041F',
  '0420 0421 0422 0423 0424 0425 0426 0427 0428 0429 042A 042B 042C 042D 042E 042F',
  '0430 0431 0432 0433 0434 0435 0436 0437 0438 0439 043A 043B 043C 043D 043E 043F',
  '0440 0441 0442 0443 0444 0445 0446 0447 0448 0449 044A 044B 044C 044D 044E 044F',
  '2116 0451 0452 0453 0454 0455 0456 0457 0458 0459 045A 045B 045C 00A7 045E 045F',
  // codepage 6: ISO 8859-6 (Arabic)
  '00A0 0000 0000 0000 00A4 0000 0000 0000 0000 0000 0000 0000 060C 00AD 0000 0000',
  '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 061B 0000 0000 0000 061F',
  '0000 0621 0622 0623 0624 0625 0626 0627 0628 0629 062A 062B 062C 062D 062E 062F',
  '0630 0631 0632 0633 0634 0635 0636 0637 0638 0639 063A 0000 0000 0000 0000 0000',
  '0640 0641 0642 0643 0644 0645 0646 0647 0648 0649 064A 064B 064C 064D 064E 064F',
  '0650 0651 0652 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000',
  // codepage 7: ISO 8859-7 (Greek)
  '00A0 2018 2019 00A3 20AC 20AF 00A6 00A7 00A8 00A9 037A 00AB 00AC 00AD 0000 2015',
  '00B0 00B1 00B2 00B3 0384 0385 0386 00B7 0388 0389 038A 00BB 038C 00BD 038E 038F',
  '0390 0391 0392 0393 0394 0395 0396 0397 0398 0399 039A 039B 039C 039D 039E 039F',
  '03A0 03A1 0000 03A3 03A4 03A5 03A6 03A7 03A8 03A9 03AA 03AB 03AC 03AD 03AE 03AF',
  '03B0 03B1 03B2 03B3 03B4 03B5 03B6 03B7 03B8 03B9 03BA 03BB 03BC 03BD 03BE 03BF',
  '03C0 03C1 03C2 03C3 03C4 03C5 03C6 03C7 03C8 03C9 03CA 03CB 03CC 03CD 03CE 0000',
  // codepage 8: ISO 8859-8 (Hebrew)
  '00A0 0000 00A2 00A3 00A4 00A5 00A6 00A7 00A8 00A9 00D7 00AB 00AC 00AD 00AE 00AF',
  '00B0 00B1 00B2 00B3 00B4 00B5 00B6 00B7 00B8 00B9 00F7 00BB 00BC 00BD 00BE 0000',
  '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000',
  '0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 2017',
  '05D0 05D1 05D2 05D3 05D4 05D5 05D6 05D7 05D8 05D9 05DA 05DB 05DC 05DD 05DE 05DF',
  '05E0 05E1 05E2 05E3 05E4 05E5 05E6 05E7 05E8 05E9 05EA 0000 0000 200E 200F 0000',
  // codepage 9: ISO 8859-9 (Turkish)
  '00A0 00A1 00A2 00A3 00A4 00A5 00A6 00A7 00A8 00A9 00AA 00AB 00AC 00AD 00AE 00AF',
  '00B0 00B1 00B2 00B3 00B4 00B5 00B6 00B7 00B8 00B9 00BA 00BB 00BC 00BD 00BE 00BF',
  '00C0 00C1 00C2 00C3 00C4 00C5 00C6 00C7 00C8 00C9 00CA 00CB 00CC 00CD 00CE 00CF',
  '011E 00D1 00D2 00D3 00D4 00D5 00D6 00D7 00D8 00D9 00DA 00DB 00DC 0130 015E 00DF',
  '00E0 00E1 00E2 00E3 00E4 00E5 00E6 00E7 00E8 00E9 00EA 00EB 00EC 00ED 00EE 00EF',
  '011F 00F1 00F2 00F3 00F4 00F5 00F6 00F7 00F8 00F9 00FA 00FB 00FC 0131 015F 00FF',
];

const CODEPAGE_TABLES: readonly number[][] = (() => {
  const tables: number[][] = [];
  for (let page = 0; page < 8; page++) {
    const rows = CODEPAGE_ROWS.slice(page * 6, page * 6 + 6);
    tables.push(rows.join(' ').split(' ').map((h) => parseInt(h, 16)));
  }
  return tables;
})();

/**
 * Map a `\S\` result code (0x80..0xFF) through the currently selected code
 * page. `codepage` 1 (the default, ISO 8859-1) and any `code` outside
 * 0xA0..0xFF (the C1 control range 0x80..0x9F, or a malformed operand outside
 * a single byte) pass through unchanged, matching the pre-codepage-aware
 * behaviour this decoder had before.
 */
function resolveExtendedChar(codepage: number, code: number): number {
  if (codepage <= 1 || code < 0xA0 || code > 0xFF) return code;
  const table = CODEPAGE_TABLES[codepage - 2];
  if (!table) return code;
  const mapped = table[code - 0xA0];
  return mapped === 0 ? code : mapped;
}

/**
 * Decode IFC STEP encoded strings.
 * Handles:
 * - \X2\XXXX\X0\ - Unicode hex encoding (e.g., \X2\00E4\X0\ -> a with umlaut)
 * - \X4\XXXXXXXX\X0\ - Unicode 4-byte hex for chars outside BMP
 * - \X\XX\ - ISO-8859-1 hex encoding (NOT code-page dependent: this is always
 *   the ISO 10646 row-0 value, per ISO 10303-21 6.4.3)
 * - \S\X - Extended ASCII: code point of X plus 128, mapped through the
 *   currently selected \P?\ code page (default ISO 8859-1)
 * - \PA\..\PI\ - Code page selectors (A=ISO 8859-1 .. I=ISO 8859-9); tracked
 *   for subsequent \S\ escapes, then the directive itself is dropped. Any
 *   other letter is dropped without changing the active page.
 * - \\ - one literal backslash (ISO 10303-21 doubles the reverse solidus)
 *
 * The \\ pair is collapsed AFTER the directive arms: a directive immediately
 * followed by an escaped backslash ends in three backslashes
 * (`\X2\00FC\X0\` + `\\`), so collapsing pairs in a pre-pass would eat the
 * directive's own terminator and leave an unterminated `\X2\`.
 *
 * This handles only backslash escapes. The '' doubled-quote escape is collapsed
 * by the STEP tokenizer's consumers (they strip surrounding quotes and
 * un-double), so decoding must not touch quotes or it would double-collapse.
 */
export function decodeIfcString(str: string): string {
  if (!str || typeof str !== 'string') return str;

  let result = '';
  let i = 0;
  let codepage = 1;

  while (i < str.length) {
    if (str[i] !== '\\') {
      result += str[i];
      i += 1;
      continue;
    }

    // Handle code page directives like \PA\, \PB\, ... Track A..I as
    // codepage 1..9 for subsequent \S\ escapes; any other letter (or an
    // unrecognized custom-page form) is consumed without changing the page.
    if (str[i + 1] === 'P' && str[i + 3] === '\\') {
      const letter = str[i + 2];
      if (letter >= 'A' && letter <= 'I') {
        codepage = letter.charCodeAt(0) - 0x40;
      }
      i += 4;
      continue;
    }

    // Handle \S\X where the value is the code point of X plus 128, mapped
    // through the active code page. Read X as a whole code point (advancing
    // past a surrogate pair) so a malformed multi-byte X stays in parity
    // with the Rust decoder instead of leaving a dangling surrogate.
    if (str[i + 1] === 'S' && str[i + 2] === '\\' && i + 3 < str.length) {
      const cp = str.codePointAt(i + 3)!;
      result += String.fromCodePoint(resolveExtendedChar(codepage, cp + 128));
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
          // Decode the payload as UTF-16 code units WITH pair awareness: a
          // surrogate pair split across two 4-hex groups combines into one
          // code point, while a LONE surrogate becomes U+FFFD - matching the
          // Rust decoder's String::from_utf16_lossy so both parse paths yield
          // identical strings (an unpaired surrogate would silently turn into
          // U+FFFD at the first re-encode anyway).
          const units: number[] = [];
          for (let j = 0; j < hex.length; j += 4) {
            units.push(parseInt(hex.slice(j, j + 4), 16));
          }
          for (let k = 0; k < units.length; k++) {
            const u = units[k];
            if (u >= 0xD800 && u <= 0xDBFF && k + 1 < units.length
              && units[k + 1] >= 0xDC00 && units[k + 1] <= 0xDFFF) {
              result += String.fromCharCode(u, units[k + 1]);
              k += 1;
            } else if (u >= 0xD800 && u <= 0xDFFF) {
              result += '�';
            } else {
              result += String.fromCharCode(u);
            }
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
            const cp = parseInt(hex.slice(j, j + 8), 16);
            // Guard the scalar: an 8-hex value above the Unicode maximum
            // (0x10FFFF) makes String.fromCodePoint throw a RangeError - on
            // the columnar batch-name path that throw propagated uncaught and
            // aborted the whole model load. Surrogate values (0xD800-0xDFFF)
            // are not scalar values either (fromCodePoint would produce an
            // unpaired surrogate); the Rust decoder's char::from_u32 rejects
            // both cases, so emit U+FFFD for both to keep the paths in parity.
            const isScalar = Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF
              && !(cp >= 0xD800 && cp <= 0xDFFF);
            result += isScalar ? String.fromCodePoint(cp) : '�';
          }
          i = end + 4;
          continue;
        }
      }
    }

    // Handle \\ - one literal backslash. Checked after the directive arms so a
    // `\X0\`/`\X\` terminator adjacent to an escaped backslash is consumed by
    // its own directive first, never paired with the escape that follows it.
    if (str[i + 1] === '\\') {
      result += '\\';
      i += 2;
      continue;
    }

    // Unknown escape sequence: keep the backslash and move on.
    result += str[i];
    i += 1;
  }

  return result;
}

/**
 * Encode a Unicode string to IFC STEP directive escapes.
 *
 * - Printable ASCII (32..126) is kept as-is, with ONE exception: the reverse
 *   solidus (`\`, U+005C) is printable ASCII but goes out as `\X\5C`, because
 *   a raw `\` in the output is what a reader takes for the start of a
 *   directive or of a `\\` pair.
 * - 8-bit values are encoded as \X\HH.
 * - BMP values are encoded as \X2\HHHH\X0\.
 * - Non-BMP values are encoded as \X4\HHHHHHHH\X0\.
 *
 * This is directive encoding only — it does NOT double the apostrophe (`'`,
 * code point 39 is printable ASCII and passes through unchanged). Its output
 * is therefore **not** safe to place directly inside a STEP single-quoted
 * string literal: an undoubled `'` terminates the literal early and produces
 * a file no conformant reader parses as intended (e.g. a name like
 * `O'Brien`). A caller writing into a literal must double `'` itself, or use
 * `escapeStepString` from `@ifc-lite/data`, which handles the full
 * literal-context contract: doubling `'` and `\`, mapping control characters
 * to a space, and encoding non-ASCII —
 * per ISO 10303-21 6.3.3.4. The two functions do not produce the same output
 * for the same input; do not assume they agree. Sweeping U+0000..U+02FF, they
 * disagree on exactly two of the 95 printable ASCII characters: the
 * apostrophe (U+0027; doubled there, passed through here) and the reverse
 * solidus (U+005C; doubled there, `\X\5C` here). They also disagree on all 32
 * C0 controls AND on DEL (U+007F) -- a space there, `\X\HH` here, since
 * `escapeStepString` collapses `/[\x00-\x1F\x7F]/g` to a space -- and on all
 * 128 of U+0080..U+00FF (`\X2\HHHH\X0\` there, `\X\HH` here). That is 163
 * disagreements in all. Above U+00FF they agree on all 512.
 *
 * Kept for round-trip use with {@link decodeIfcString}, within the scope the
 * two functions actually cover: `decodeIfcString(encodeIfcString(s)) === s`
 * for every `s` built from Unicode SCALAR values. That is not the same as
 * every JS string. A JS string can also hold an unpaired surrogate
 * (U+D800..U+DFFF), which is not a scalar value; this encoder writes it as a
 * `\X2\` directive, and {@link decodeIfcString} decodes every lone surrogate
 * to U+FFFD to stay in parity with the Rust decoder's
 * `String::from_utf16_lossy`. Those 2048 code units are the only inputs that
 * do not come back unchanged.
 *
 * Within that scope the guarantee is independent of apostrophe handling,
 * because doubling is a literal-context requirement, not an encoding one.
 * See https://github.com/LTplus-AG/ifc-lite/issues/3445.
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
