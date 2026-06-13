/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { getGeometryStreamWatchdogMs } from './watchdog.js';

describe('getGeometryStreamWatchdogMs', () => {
  it('browser, first batch, small file → 30s floor', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: 5,
    })).toBe(30_000 + 5 * 60);
  });

  it('browser, first batch, 0 MB → exactly 30s floor', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: 0,
    })).toBe(30_000);
  });

  it('browser, first batch, 1 GB → 90 s', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: 1024,
    })).toBe(30_000 + 1024 * 60);
  });

  it('browser, first batch, 2 GB → 150 s', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: 2048,
    })).toBe(30_000 + 2048 * 60);
  });

  it('browser, after first batch → fixed grace, independent of file size (#1097)', () => {
    // Subsequent-batch deadline is a fixed silent-window budget. It must NOT
    // scale with file size — the silent window is one bounded WASM call's
    // wall-time (CSG density), not bytes. A ~275 MB CSG-dense steel model used
    // to trip its own MB-scaled deadline mid-stream.
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 1, fileSizeMB: 275,
    })).toBe(40_000);
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 1, fileSizeMB: 4096,
    })).toBe(40_000);
  });

  it('browser, subsequent deadline is constant across wildly different sizes', () => {
    const small = getGeometryStreamWatchdogMs({ desktopStableWasm: false, batchCount: 1, fileSizeMB: 1 });
    const huge = getGeometryStreamWatchdogMs({ desktopStableWasm: false, batchCount: 50, fileSizeMB: 8192 });
    expect(small).toBe(huge);
  });

  it('desktop stable WASM, first batch, small file → 15 s floor', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 0, fileSizeMB: 10,
    })).toBe(15_000 + 10 * 30);
  });

  it('desktop stable WASM, first batch, 1 GB → 45 s', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 0, fileSizeMB: 1024,
    })).toBe(15_000 + 1024 * 30);
  });

  it('desktop stable WASM, after first batch → fixed grace, independent of file size', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 3, fileSizeMB: 1024,
    })).toBe(25_000);
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 3, fileSizeMB: 16,
    })).toBe(25_000);
  });

  it('never returns below the previous fixed floors (regression guard)', () => {
    // Previous floors: browser 30s first / 15s subsequent; desktop 15s / 5s.
    // The fixed subsequent grace was raised above those, so this still holds.
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: 0,
    })).toBeGreaterThanOrEqual(30_000);
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 1, fileSizeMB: 0,
    })).toBeGreaterThanOrEqual(15_000);
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 0, fileSizeMB: 0,
    })).toBeGreaterThanOrEqual(15_000);
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 1, fileSizeMB: 0,
    })).toBeGreaterThanOrEqual(5_000);
  });

  it('handles negative file size by clamping to 0', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0, fileSizeMB: -5,
    })).toBe(30_000);
  });

  it('handles fractional batchCount by flooring', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 0.5 as unknown as number, fileSizeMB: 100,
    })).toBe(30_000 + 100 * 60);
  });
});
