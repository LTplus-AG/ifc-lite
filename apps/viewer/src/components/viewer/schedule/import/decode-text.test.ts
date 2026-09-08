/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { decodeScheduleFileBytes } from './decode-text.js';

function utf16leBytes(text: string): ArrayBuffer {
  // BOM (FF FE) + UTF-16LE code units, built by hand rather than relying on
  // a binary fixture file (none exists in this importer's test suite).
  const buf = new ArrayBuffer(2 + text.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, 0xff);
  view.setUint8(1, 0xfe);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  return buf;
}

function utf16beBytes(text: string): ArrayBuffer {
  const buf = new ArrayBuffer(2 + text.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, 0xfe);
  view.setUint8(1, 0xff);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), false);
  }
  return buf;
}

function utf8Bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('decodeScheduleFileBytes', () => {
  it('decodes a UTF-16LE buffer (Excel Unicode-Text export), stripping the BOM', () => {
    // Regression: readAsText assumes UTF-8, so a UTF-16LE file "succeeds"
    // but produces NUL-byte-laced garbage task names instead of failing.
    const csv = 'Name,Start\r\nTask One,2026-01-05\r\n';
    const text = decodeScheduleFileBytes(utf16leBytes(csv));
    assert.strictEqual(text, csv);
    assert.ok(!text.includes(String.fromCharCode(0)));
  });

  it('decodes a UTF-16BE buffer, stripping the BOM', () => {
    const csv = 'Name,Start\r\nTask 1,2026-01-05\r\n';
    const text = decodeScheduleFileBytes(utf16beBytes(csv));
    assert.strictEqual(text, csv);
  });

  it('falls back to UTF-8 when there is no BOM (existing behavior)', () => {
    const csv = 'Name,Start\nTask 1,2026-01-05\n';
    const text = decodeScheduleFileBytes(utf8Bytes(csv));
    assert.strictEqual(text, csv);
  });

  it('leaves a UTF-8 BOM in place (the CSV/MSPDI parsers strip it themselves)', () => {
    const withBom = '﻿Name,Start\nTask 1,2026-01-05\n';
    const text = decodeScheduleFileBytes(utf8Bytes(withBom));
    assert.strictEqual(text.charCodeAt(0), 0xfeff);
  });
});
