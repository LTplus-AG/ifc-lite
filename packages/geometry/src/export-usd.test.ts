/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the `GeometryProcessor.exportUsd` public surface: the
 * uninitialized guard and the delegation through `IfcLiteBridge` to the wasm
 * `IfcAPI.exportUsd`. The wasm boundary is mocked here (per AGENTS.md §Geometry
 * & WASM); the REAL compiled boundary is exercised end to end by
 * `scripts/test-wasm-contract.mjs` and `tests/e2e/usd-export.e2e.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const exportUsd = vi.fn();
  const free = vi.fn();

  class MockIfcAPI {
    exportUsd(content: Uint8Array) {
      return exportUsd(content);
    }
    free() {
      return free();
    }
  }

  return { init: vi.fn(async () => undefined), exportUsd, free, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

describe('GeometryProcessor.exportUsd', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.exportUsd.mockReset();
    wasmMocks.free.mockReset();
  });

  it('returns null before init() and never touches the wasm boundary', () => {
    const gp = new GeometryProcessor();
    expect(gp.exportUsd(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(wasmMocks.exportUsd).not.toHaveBeenCalled();
  });

  it('after init(), delegates to IfcAPI.exportUsd with the input bytes and returns them verbatim', async () => {
    const usda = new TextEncoder().encode('#usda 1.0\n(\n    defaultPrim = "World"\n)\n');
    wasmMocks.exportUsd.mockReturnValue(usda);

    const gp = new GeometryProcessor();
    await gp.init();

    const input = new TextEncoder().encode('ISO-10303-21;');
    const out = gp.exportUsd(input);

    expect(wasmMocks.exportUsd).toHaveBeenCalledTimes(1);
    expect(wasmMocks.exportUsd).toHaveBeenCalledWith(input);
    expect(out).toBe(usda);

    gp.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });
});
