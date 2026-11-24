/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Encode a DXF R12 (AC1009) document's text to the bytes it actually
 * declares: windows-1252 (`$DWGCODEPAGE ANSI_1252`, written by
 * {@link DxfWriter.toString}), not UTF-8.
 *
 * DXF only became UTF-8 at R2007 (AC1021) — every version this writer
 * targets is single-byte-codepage text (ISO 10303 doesn't apply; this is
 * Autodesk's own DXF Reference, "International text" / `$DWGCODEPAGE`). A
 * reader with no declared codepage (older files, or ours before this fix)
 * defaults to `ANSI_1252` (confirmed against `ezdxf`, which mirrors
 * AutoCAD's own default) — so bytes that are actually UTF-8 decode as
 * mojibake: "Wände" round-trips as "WÃ¤nde". This module is the single
 * place that turns the writer's JS string into the bytes a real DXF
 * consumer reads, so the two can't drift apart again.
 *
 * windows-1252 is a superset of ISO-8859-1/Latin-1 in the printable range
 * (0x00-0x7F and 0xA0-0xFF encode identically) but replaces Latin-1's
 * 0x80-0x9F C1 control block with 27 printable characters (curly quotes,
 * en/em dash, €, …) — the ones a Western European label is actually likely
 * to contain.
 *
 * A BMP character outside windows-1252 (Romanian ă ș ț, Czech č ř ž, Polish
 * ł ś, Cyrillic, CJK) is written as the DXF Unicode escape `\U+XXXX` (four
 * uppercase hex digits), which AutoCAD and `ezdxf` decode in pre-R2007 text
 * (Autodesk DXF Reference, "Text control codes and special characters").
 * The escape is pure ASCII, so it cannot corrupt neighbouring bytes. A
 * literal backslash that is followed by `U+` is itself written as `\U+005C`
 * so user text can never be misread as an escape; DXF defines no `\\`
 * escape for TEXT (only MTEXT), so no other backslash needs touching.
 * Astral code points (emoji) have no four-digit escape and, like lone
 * surrogates, become `?`.
 */

/** windows-1252 byte -> code point for the 0x80-0x9F range that diverges from Latin-1; `undefined` = unassigned. */
const CP1252_HIGH_C1: readonly (number | undefined)[] = [
  0x20ac, undefined, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, // 0x80-0x87
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, undefined, 0x017d, undefined, // 0x88-0x8f
  undefined, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, // 0x90-0x97
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, undefined, 0x017e, 0x0178, // 0x98-0x9f
];

/** Code point -> windows-1252 byte, for the codepoints in {@link CP1252_HIGH_C1} (lazily built once). */
let codePointToHighByte: Map<number, number> | undefined;

function getCodePointToHighByte(): Map<number, number> {
  if (codePointToHighByte === undefined) {
    codePointToHighByte = new Map();
    for (let i = 0; i < CP1252_HIGH_C1.length; i++) {
      const cp = CP1252_HIGH_C1[i];
      if (cp !== undefined) codePointToHighByte.set(cp, 0x80 + i);
    }
  }
  return codePointToHighByte;
}

/** `?` — substituted for any code point windows-1252 cannot represent. */
const REPLACEMENT_BYTE = 0x3f;

/**
 * Encode one Unicode code point to its windows-1252 byte, or
 * {@link REPLACEMENT_BYTE} when the code point has no windows-1252
 * representation (astral code points, most scripts beyond Western Europe).
 */
function encodeCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return codePoint; // ASCII: identical in every relevant encoding.
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint; // Latin-1 supplement: byte == code point.
  const highByte = getCodePointToHighByte().get(codePoint);
  return highByte ?? REPLACEMENT_BYTE;
}

export interface Cp1252EncodeResult {
  bytes: Uint8Array;
  /** True when at least one code point could not be represented at all and was replaced with `?` (information lost). */
  hadUnmappable: boolean;
  /** True when at least one BMP code point outside windows-1252 was written as a `\U+XXXX` escape (nothing lost). */
  hadEscaped: boolean;
}

/** True for a code point that has a four-digit `\U+XXXX` spelling: BMP, not a surrogate half, not a C1 control. */
function isEscapable(codePoint: number): boolean {
  return codePoint >= 0x100 && codePoint <= 0xffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
}

/**
 * Encode a full DXF document string (as produced by
 * {@link DxfWriter.toString}) to windows-1252 bytes — the encoding its own
 * `$DWGCODEPAGE ANSI_1252` header variable declares — with characters
 * outside that code page spelled as `\U+XXXX` (see the module comment).
 * Iterates by code point (not UTF-16 code unit) so a surrogate pair is
 * treated as the one astral character it represents.
 */
export function encodeDxfCp1252(text: string): Cp1252EncodeResult {
  const bytes: number[] = [];
  let hadUnmappable = false;
  let hadEscaped = false;
  const pushAscii = (s: string): void => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const codePoint = ch.codePointAt(0) ?? REPLACEMENT_BYTE;
    if (codePoint === 0x5c && chars[i + 1] === 'U' && chars[i + 2] === '+') {
      pushAscii('\\U+005C'); // a literal backslash before `U+` must not read as an escape
      hadEscaped = true;
      continue;
    }
    const byte = encodeCodePoint(codePoint);
    if (byte === REPLACEMENT_BYTE && codePoint !== REPLACEMENT_BYTE) {
      if (isEscapable(codePoint)) {
        pushAscii(`\\U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
        hadEscaped = true;
        continue;
      }
      hadUnmappable = true;
    }
    bytes.push(byte);
  }
  return { bytes: Uint8Array.from(bytes), hadUnmappable, hadEscaped };
}
