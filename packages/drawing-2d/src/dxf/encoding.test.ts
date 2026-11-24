/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `encodeDxfCp1252` tests. The defect these guard: `DxfWriter.toString()`
 * produces a DXF R12 document declaring `$DWGCODEPAGE ANSI_1252`, but a
 * naive `new Blob([text])` or `TextEncoder().encode(text)` at the point of
 * writing the file to disk/download UTF-8-encodes it instead — a real
 * external DXF reader (confirmed against `ezdxf`, which mirrors AutoCAD's
 * own default for a file with no declared codepage) then decodes those
 * UTF-8 bytes as windows-1252 and "Wände" comes back "WÃ¤nde". These tests
 * pin the encoder's byte output directly (no way to run `ezdxf` in this
 * repo's CI — see AGENTS.md), matching the windows-1252 standard table.
 */

import { describe, expect, it } from 'vitest';
import { encodeDxfCp1252 } from './encoding.js';
import { DxfWriter } from './writer.js';
import { parseDxf } from './parser.js';

/** Bytes as a string, one char per byte; `cp1252` also maps the en dash (0x96) the fixtures use, since Node's latin1 decoder leaves 0x80-0x9F as C1 controls. */
function ascii(bytes: Uint8Array, cp1252 = false): string {
  let out = '';
  for (const b of bytes) out += cp1252 && b === 0x96 ? '\u2013' : String.fromCharCode(b);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

describe('encodeDxfCp1252', () => {
  it('encodes plain ASCII byte-for-byte (identical across every candidate encoding)', () => {
    const { bytes, hadUnmappable } = encodeDxfCp1252('LINE 8\nA-WALL\n');
    expect(bytesToHex(bytes)).toBe(bytesToHex(new TextEncoder().encode('LINE 8\nA-WALL\n')));
    expect(hadUnmappable).toBe(false);
  });

  it('encodes the Latin-1-supplement range (U+00A0..U+00FF) as byte == code point — NOT UTF-8', () => {
    // 'ä' = U+00E4. UTF-8 would emit two bytes (0xC3 0xA4); DXF R12 windows-1252 is one byte, 0xE4.
    const { bytes, hadUnmappable } = encodeDxfCp1252('Wände');
    expect(Array.from(bytes)).toEqual([0x57, 0xe4, 0x6e, 0x64, 0x65]); // W ä n d e
    expect(bytes.length).toBe(5); // one byte per character — this is exactly what UTF-8 would NOT do.
    expect(hadUnmappable).toBe(false);
  });

  it('encodes windows-1252\'s 0x80-0x9F printable block (the Latin-1 divergence: curly quotes, en/em dash, €)', () => {
    // U+2013 EN DASH -> 0x96; U+20AC EURO SIGN -> 0x80; U+201C/U+201D curly quotes -> 0x93/0x94.
    const { bytes, hadUnmappable } = encodeDxfCp1252('–€“”');
    expect(Array.from(bytes)).toEqual([0x96, 0x80, 0x93, 0x94]);
    expect(hadUnmappable).toBe(false);
  });

  it('spells a BMP code point outside windows-1252 as \\U+XXXX (uppercase hex) and keeps hadUnmappable false', () => {
    const { bytes, hadUnmappable, hadEscaped } = encodeDxfCp1252('日本語');
    expect(ascii(bytes)).toBe('\\U+65E5\\U+672C\\U+8A9E');
    expect(hadUnmappable).toBe(false);
    expect(hadEscaped).toBe(true);
  });

  it('keeps Romanian, Czech and Polish text readable instead of "?"', () => {
    expect(ascii(encodeDxfCp1252('Sală de ședințe – Etaj 2, 25 m²').bytes)).toBe(
      'Sal\\U+0103 de \\U+0219edin\\U+021Be \x96 Etaj 2, 25 m\xb2',
    );
    expect(ascii(encodeDxfCp1252('Łódź').bytes)).toBe('\\U+0141\xf3d\\U+017A');
    expect(ascii(encodeDxfCp1252('Příčka').bytes)).toBe('P\\U+0159\xed\\U+010Dka');
  });

  it('writes a literal backslash before U+ as \\U+005C so it cannot read as an escape', () => {
    expect(ascii(encodeDxfCp1252('a\\U+0041b').bytes)).toBe('a\\U+005CU+0041b');
    expect(ascii(encodeDxfCp1252('C:\\dir').bytes)).toBe('C:\\dir'); // other backslashes untouched
  });

  it('round-trips through ifc-lite\'s own parser (writer -> bytes -> parseDxf)', () => {
    for (const label of ['Sală de ședințe – Etaj 2, 25 m²', 'Łódź', 'Příčka', 'a\\U+0041b', '日本']) {
      const w = new DxfWriter();
      w.addText({ x: 0, y: 0 }, label, 2.5, 'TXT');
      const doc = parseDxf(ascii(encodeDxfCp1252(w.toString()).bytes, true));
      const t = doc.entities.find((e) => e.kind === 'text');
      expect(t && 'text' in t ? t.text : undefined).toBe(label);
    }
  });

  it('replaces an unassigned windows-1252 C1 slot (e.g. U+0081, never assigned in cp1252) the same way', () => {
    const { bytes, hadUnmappable } = encodeDxfCp1252('');
    expect(Array.from(bytes)).toEqual([0x3f]);
    expect(hadUnmappable).toBe(true);
  });

  it('does not flag hadUnmappable when nothing needed replacing', () => {
    const { hadUnmappable } = encodeDxfCp1252('plain ASCII only');
    expect(hadUnmappable).toBe(false);
  });

  it('treats an astral code point (surrogate pair) as one unmappable character, not two replacements', () => {
    // U+1F600 GRINNING FACE — encoded as a UTF-16 surrogate pair in the JS string.
    const grinningFace = String.fromCodePoint(0x1f600);
    expect(grinningFace.length).toBe(2); // sanity: it IS a surrogate pair in UTF-16.
    const { bytes, hadUnmappable } = encodeDxfCp1252(grinningFace);
    expect(Array.from(bytes)).toEqual([0x3f]); // one replacement byte, not two.
    expect(hadUnmappable).toBe(true);
  });

  it('handles the empty string', () => {
    const { bytes, hadUnmappable } = encodeDxfCp1252('');
    expect(bytes.length).toBe(0);
    expect(hadUnmappable).toBe(false);
  });
});
