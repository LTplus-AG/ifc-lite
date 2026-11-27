/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decode the bytes of an XML entry to text the way XML 1.0 Appendix F says a
 * processor finds the encoding: a byte-order mark first, then the shape of the
 * first bytes (`<?` in UTF-16 with and without a BOM), and only then the
 * declaration. The reader used to decode every entry as UTF-8, so a UTF-16
 * `markup.bcf` (what .NET `Encoding.Unicode` writers produce) decoded to NUL
 * interleaved text and its whole topic was dropped.
 *
 * The declaration is deliberately NOT trusted for UTF-8 versus UTF-16: some
 * writers declare `utf-16` over UTF-8 bytes, and the byte shape is the truth.
 * It is consulted only when the bytes are not valid UTF-8 and it names an
 * 8-bit Latin encoding, which is the one case where "invalid UTF-8" has a
 * single sensible reading. Anything else keeps the lenient UTF-8 decode.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const [b0, b1, b2, b3] = bytes;
  if (b0 === 0xff && b1 === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (b0 === 0xfe && b1 === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (b0 === 0x3c && b1 === 0x00 && b2 === 0x3f && b3 === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  if (b0 === 0x00 && b1 === 0x3c && b2 === 0x00 && b3 === 0x3f) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const declared = head.match(/^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (declared && /^(iso-8859-1|latin-?1|windows-1252|cp1252)$/.test(declared)) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
    return new TextDecoder().decode(bytes);
  }
}
