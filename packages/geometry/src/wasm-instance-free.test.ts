/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fresh module per test: the once-per-worker latch is module state, and
 * `vi.resetModules()` is what a real worker restart looks like from here.
 */
async function loadFresh(): Promise<typeof import('./wasm-instance-free.js')> {
  vi.resetModules();
  return import('./wasm-instance-free.js');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('freeWasmInstanceQuietly', () => {
  it('frees the instance and stays quiet on success', async () => {
    const { freeWasmInstanceQuietly } = await loadFresh();
    const free = vi.fn();

    freeWasmInstanceQuietly({ free });

    expect(free).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tolerates a null / undefined wrapper', async () => {
    const { freeWasmInstanceQuietly } = await loadFresh();

    expect(() => freeWasmInstanceQuietly(null)).not.toThrow();
    expect(() => freeWasmInstanceQuietly(undefined)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a throwing free() and reports it once', async () => {
    const { freeWasmInstanceQuietly } = await loadFresh();
    const free = vi.fn(() => {
      throw new Error('null pointer passed to rust');
    });

    expect(() => freeWasmInstanceQuietly({ free })).not.toThrow();

    expect(free).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('once per worker');
    expect(warn.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('logs ONCE across a flood of failures, not once per call', async () => {
    // The callers are `processBatch`'s per-entity and per-batch recovery paths.
    // One bad model drives them thousands of times in a single load, and a
    // per-occurrence line there is a log flood, not diagnostics.
    const { freeWasmInstanceQuietly } = await loadFresh();
    const free = vi.fn(() => {
      throw new Error('null pointer passed to rust');
    });

    for (let i = 0; i < 1_000; i += 1) {
      freeWasmInstanceQuietly({ free });
    }

    expect(free).toHaveBeenCalledTimes(1_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-arms the latch for a fresh worker', async () => {
    const free = vi.fn(() => {
      throw new Error('null pointer passed to rust');
    });

    const first = await loadFresh();
    first.freeWasmInstanceQuietly({ free });
    const second = await loadFresh();
    second.freeWasmInstanceQuietly({ free });

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
