/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const parseMeshes = vi.fn();
  const setMergeLayers = vi.fn();

  class MockIfcAPI {
    parseMeshes(content: string) {
      return parseMeshes(content);
    }
    setMergeLayers(enabled: boolean) {
      return setMergeLayers(enabled);
    }
  }

  return {
    init: vi.fn(async () => undefined),
    parseMeshes,
    setMergeLayers,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { IfcLiteBridge } from './ifc-lite-bridge.js';

describe('IfcLiteBridge', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.parseMeshes.mockReset();
    wasmMocks.setMergeLayers.mockReset();
  });

  it('forwards setMergeLayers to the WASM API after init', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    bridge.setMergeLayers(true);
    expect(bridge.getMergeLayers()).toBe(true);
    expect(wasmMocks.setMergeLayers).toHaveBeenCalledWith(true);

    bridge.setMergeLayers(false);
    expect(bridge.getMergeLayers()).toBe(false);
    expect(wasmMocks.setMergeLayers).toHaveBeenLastCalledWith(false);
  });

  it('caches setMergeLayers calls made before init and replays on init', async () => {
    const bridge = new IfcLiteBridge();
    bridge.setMergeLayers(true);
    expect(wasmMocks.setMergeLayers).not.toHaveBeenCalled();
    expect(bridge.getMergeLayers()).toBe(true);

    await bridge.init();
    expect(wasmMocks.setMergeLayers).toHaveBeenCalledWith(true);
  });

  it('blocks in-process reinitialization after a fatal wasm runtime error', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    wasmMocks.parseMeshes.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('panic');
    });

    expect(() => bridge.parseMeshes('broken ifc')).toThrow(WebAssembly.RuntimeError);
    await expect(bridge.init()).rejects.toThrow(
      'IFC-Lite WASM cannot recover from a fatal runtime error within the same document lifetime.',
    );
    expect(wasmMocks.init).toHaveBeenCalledTimes(1);
  });
});
