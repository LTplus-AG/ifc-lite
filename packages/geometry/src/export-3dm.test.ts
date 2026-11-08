/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the `GeometryProcessor.exportRhinoScene` public surface: the
 * uninitialized guard and the delegation through `IfcLiteBridge` to the wasm
 * `IfcAPI.exportRhinoScene`. The wasm boundary is mocked here (per AGENTS.md §Geometry
 * & WASM); the REAL compiled boundary is exercised end to end by
 * `scripts/test-wasm-contract.mjs` and `tests/e2e/usd-export.e2e.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const exportRhinoScene = vi.fn();
  const free = vi.fn();

  class MockIfcAPI {
    exportRhinoScene(content: Uint8Array, options: string) {
      return exportRhinoScene(content, options);
    }
    free() {
      return free();
    }
  }

  return { init: vi.fn(async () => undefined), exportRhinoScene, free, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

describe('GeometryProcessor.exportRhinoScene', () => {
  beforeEach(() => { wasmMocks.exportRhinoScene.mockReset(); });
  it('requires initialization', () => {
    expect(() => new GeometryProcessor().exportRhinoScene(new Uint8Array())).toThrow(/initialized/);
  });
  it('serializes options, copies the payload and frees the wasm handle', async () => {
    const free = vi.fn();
    const scene = { manifest: '{}', blob: new Uint8Array([1]), free };
    wasmMocks.exportRhinoScene.mockReturnValue(scene);
    const gp = new GeometryProcessor();
    await gp.init();
    const bytes = new Uint8Array([2]);
    expect(gp.exportRhinoScene(bytes, { isolated: [], layerScheme: 'class' })).toEqual({ manifest: '{}', blob: scene.blob });
    expect(wasmMocks.exportRhinoScene).toHaveBeenCalledWith(bytes, '{"isolated":[],"layerScheme":"class"}');
    expect(free).toHaveBeenCalledOnce();
    gp.dispose();
  });
  it('maps the empty geometry refusal like USD', async () => {
    wasmMocks.exportRhinoScene.mockImplementation(() => { throw new Error('NO_RENDER_GEOMETRY: empty'); });
    const gp = new GeometryProcessor();
    await gp.init();
    expect(() => gp.exportRhinoScene(new Uint8Array([2]))).toThrow(/NO_RENDER_GEOMETRY/);
    gp.dispose();
  });
});
