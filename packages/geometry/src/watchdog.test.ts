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

  it('browser, after first batch → 15 s regardless of file size', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: false, batchCount: 1, fileSizeMB: 4096,
    })).toBe(15_000);
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

  it('desktop stable WASM, after first batch → 5 s', () => {
    expect(getGeometryStreamWatchdogMs({
      desktopStableWasm: true, batchCount: 3, fileSizeMB: 1024,
    })).toBe(5_000);
  });

  it('never returns below the previous fixed floors (regression guard)', () => {
    // Browser path floor was 30s/15s; desktop was 15s/5s.
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
