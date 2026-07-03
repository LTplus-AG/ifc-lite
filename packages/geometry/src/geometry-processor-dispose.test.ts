/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const free = vi.fn();

  class MockIfcAPI {
    free() {
      return free();
    }
  }

  return {
    init: vi.fn(async () => undefined),
    free,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

describe('GeometryProcessor disposal (issue: WASM Symbol.dispose ergonomics)', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.free.mockReset();
  });

  it('dispose() frees the underlying WASM IfcAPI handle exactly once', async () => {
    const processor = new GeometryProcessor();
    await processor.init();

    processor.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent: a repeat call does not double-free the handle', async () => {
    const processor = new GeometryProcessor();
    await processor.init();

    processor.dispose();
    processor.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });

  it('`using` frees the handle deterministically at scope exit', async () => {
    async function withScopedProcessor(): Promise<void> {
      using processor = new GeometryProcessor();
      await processor.init();
      expect(wasmMocks.free).not.toHaveBeenCalled();
    }

    await withScopedProcessor();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });

  it('an explicit dispose() call before `using` scope exit is not a double-free', async () => {
    async function withScopedProcessor(): Promise<void> {
      using processor = new GeometryProcessor();
      await processor.init();
      processor.dispose();
      expect(wasmMocks.free).toHaveBeenCalledTimes(1);
    }

    await withScopedProcessor();
    // [Symbol.dispose]() runs again at scope exit, but the bridge already
    // nulled its handle, so free() is still only ever called once.
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });

  it('dispose() before init() is a no-op (no handle to free yet)', () => {
    const processor = new GeometryProcessor();
    expect(() => processor.dispose()).not.toThrow();
    expect(wasmMocks.free).not.toHaveBeenCalled();
  });
});
