/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for `exportRhinoScene`: it loads the separate
 * `@ifc-lite/wasm/rhino` engine once, serializes options, copies the payload
 * and frees the handle. The wasm boundary is mocked here (per AGENTS.md
 * §Geometry & WASM); the REAL compiled boundary is exercised end to end by
 * `scripts/test-wasm-contract.mjs` (`scripts/lib/rhino-export-contract.mjs`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({ init: vi.fn(async () => undefined), exportRhinoScene: vi.fn() }));

vi.mock('@ifc-lite/wasm/rhino', () => ({
  default: wasmMocks.init,
  exportRhinoScene: wasmMocks.exportRhinoScene,
}));

import { exportRhinoScene } from './index.js';

describe('exportRhinoScene', () => {
  beforeEach(() => { wasmMocks.exportRhinoScene.mockReset(); });
  it('serializes options, copies the payload and frees the wasm handle', async () => {
    const free = vi.fn();
    const scene = { manifest: '{}', blob: new Uint8Array([1]), free };
    wasmMocks.exportRhinoScene.mockReturnValue(scene);
    const bytes = new Uint8Array([2]);
    await expect(exportRhinoScene(bytes, { isolated: [], layerScheme: 'class' })).resolves.toEqual({ manifest: '{}', blob: scene.blob });
    expect(wasmMocks.exportRhinoScene).toHaveBeenCalledWith(bytes, '{"isolated":[],"layerScheme":"class"}');
    expect(free).toHaveBeenCalledOnce();
  });
  it('initializes the Rhino engine once across exports', async () => {
    wasmMocks.exportRhinoScene.mockReturnValue({ manifest: '{}', blob: new Uint8Array(), free: vi.fn() });
    // A fresh module instance, so its engine cache starts empty.
    vi.resetModules();
    const fresh = await import('./rhino-export.js');
    wasmMocks.init.mockClear();
    await fresh.exportRhinoScene(new Uint8Array([2]));
    await fresh.exportRhinoScene(new Uint8Array([3]));
    expect(wasmMocks.init).toHaveBeenCalledOnce();
  });
  it('passes the empty geometry refusal through, like USD', async () => {
    wasmMocks.exportRhinoScene.mockImplementation(() => { throw new Error('NO_RENDER_GEOMETRY: empty'); });
    await expect(exportRhinoScene(new Uint8Array([2]))).rejects.toThrow(/NO_RENDER_GEOMETRY/);
  });
});
