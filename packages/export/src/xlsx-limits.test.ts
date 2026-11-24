/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { sanitizeSheetName, clampXlsxCellText, XLSX_MAX_CELL_CHARS } from './xlsx-limits.js';

describe('sanitizeSheetName', () => {
  it('removes illegal characters and caps at 31', () => {
    const n = sanitizeSheetName('Ground floor – Rooms & Areas [Draft]: v2/3');
    expect(n).not.toMatch(/[\\/?*[\]:]/);
    expect(n.length).toBeLessThanOrEqual(31);
  });
  it('keeps clean names untouched', () => expect(sanitizeSheetName('Sală')).toBe('Sală'));
  it('dedupes case-insensitively within 31 chars', () => {
    const long = 'x'.repeat(40);
    const a = sanitizeSheetName(long);
    const b = sanitizeSheetName(long.toUpperCase(), [a]);
    expect(b.toLowerCase()).not.toBe(a.toLowerCase());
    expect(b.length).toBeLessThanOrEqual(31);
    expect(sanitizeSheetName('ROOMS', ['Rooms'])).toBe('ROOMS (2)');
  });
  it('handles empty, apostrophes and History', () => {
    expect(sanitizeSheetName('')).toBe('Sheet1');
    expect(sanitizeSheetName("'a'")).toBe('a');
    expect(sanitizeSheetName('history')).toBe('history (1)');
  });
});

describe('clampXlsxCellText', () => {
  it('truncates over-limit text with a visible ellipsis', () => {
    const t = clampXlsxCellText('x'.repeat(40000));
    expect(t.length).toBe(XLSX_MAX_CELL_CHARS);
    expect(t.endsWith('…')).toBe(true);
  });
  it('leaves in-limit text alone', () => expect(clampXlsxCellText('abc')).toBe('abc'));
});
