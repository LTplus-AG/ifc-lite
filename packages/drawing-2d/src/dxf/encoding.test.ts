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

  it('replaces a code point with no windows-1252 representation with "?" (0x3F) and reports hadUnmappable', () => {
    const { bytes, hadUnmappable } = encodeDxfCp1252('日本語');
    expect(Array.from(bytes)).toEqual([0x3f, 0x3f, 0x3f]);
    expect(hadUnmappable).toBe(true);
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
