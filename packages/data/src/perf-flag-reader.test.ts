/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePerfFlagUrlValue, readPerfFlagRaw, readPerfFlagUrlParam } from './perf-flag-reader.js';

const g = globalThis as Record<string, unknown>;
const binding = { global: '__IFC_LITE_READER_TEST', urlParam: 'perf.readerTest' } as const;

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.__IFC_LITE_READER_TEST;
  Reflect.deleteProperty(globalThis, 'location');
  vi.restoreAllMocks();
});

describe('parsePerfFlagUrlValue', () => {
  it('maps URL text onto the shapes a global override takes', () => {
    expect(parsePerfFlagUrlValue('0')).toBe(0);
    expect(parsePerfFlagUrlValue('1.5')).toBe(1.5);
    expect(parsePerfFlagUrlValue('true')).toBe(true);
    expect(parsePerfFlagUrlValue('false')).toBe(false);
    expect(parsePerfFlagUrlValue('{"cellSize":16}')).toEqual({ cellSize: 16 });
    expect(parsePerfFlagUrlValue('["IFCSPACE"]')).toEqual(['IFCSPACE']);
    expect(parsePerfFlagUrlValue('off')).toBe('off');
    expect(parsePerfFlagUrlValue('')).toBe('');
  });

  it('drops malformed JSON with a warning instead of passing text through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parsePerfFlagUrlValue('{oops')).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('readPerfFlagRaw', () => {
  it('is undefined when nothing is set, including off-browser', () => {
    expect(readPerfFlagUrlParam('perf.readerTest')).toBeNull();
    expect(readPerfFlagRaw(binding)).toBeUndefined();
  });

  it('returns the global unchanged when set', () => {
    const value = { a: 1 };
    g.__IFC_LITE_READER_TEST = value;
    expect(readPerfFlagRaw(binding)).toBe(value);
    g.__IFC_LITE_READER_TEST = 0;
    expect(readPerfFlagRaw(binding)).toBe(0);
  });

  it('falls back to the URL param when the global is unset or null', () => {
    setSearch('?perf.readerTest=0');
    expect(readPerfFlagRaw(binding)).toBe(0);
    g.__IFC_LITE_READER_TEST = null;
    expect(readPerfFlagRaw(binding)).toBe(0);
    g.__IFC_LITE_READER_TEST = 7;
    expect(readPerfFlagRaw(binding)).toBe(7);
  });

  it('ignores the URL when the binding declares no param', () => {
    setSearch('?perf.readerTest=0');
    expect(readPerfFlagRaw({ global: binding.global })).toBeUndefined();
  });
});
