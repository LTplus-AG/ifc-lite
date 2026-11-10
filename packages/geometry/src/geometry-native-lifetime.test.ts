/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit F5: `GeometryProcessor.init()` on the native (Tauri) path built a new
 * platform bridge on every call, and `dispose()` never released it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ifc-lite/wasm', () => ({
  default: vi.fn(async () => undefined),
  IfcAPI: class {},
}));

const platform = vi.hoisted(() => ({
  created: 0,
  disposed: [] as number[],
  /** When set, the next bridge's init() waits on it. */
  gate: null as Promise<void> | null,
  failNext: null as Error | null,
}));

vi.mock('./platform-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform-bridge.js')>();
  return {
    ...actual,
    isTauri: () => true,
    createPlatformBridge: async (): Promise<import('./platform-bridge.js').IPlatformBridge> => {
      const id = ++platform.created;
      const gate = platform.gate;
      const failure = platform.failNext;
      platform.failNext = null;
      return {
        init: async () => {
          if (gate) await gate;
          if (failure) throw failure;
        },
        isInitialized: () => true,
        processGeometry: async () => ({ meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: undefined as never }),
        processGeometryStreaming: async () => ({ totalMeshes: 0, totalVertices: 0, totalTriangles: 0, parseTimeMs: 0, geometryTimeMs: 0 }),
        getApi: () => null,
        dispose: () => { platform.disposed.push(id); },
      };
    },
  };
});

import { GeometryProcessor } from './index.js';

beforeEach(() => {
  platform.created = 0;
  platform.disposed = [];
  platform.gate = null;
  platform.failNext = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('GeometryProcessor native lifetime (F5)', () => {
  it('concurrent and repeated init() calls build one platform bridge', async () => {
    const processor = new GeometryProcessor();
    await Promise.all([processor.init(), processor.init()]);
    await processor.init();
    expect(platform.created).toBe(1);
  });

  it('dispose() disposes the platform bridge, and a later init() builds a fresh one', async () => {
    const processor = new GeometryProcessor();
    await processor.init();
    processor.dispose();
    expect(platform.disposed).toEqual([1]);
    // The disposed bridge is not used again.
    await expect(processor.process(new Uint8Array())).rejects.toThrow();
    await processor.init();
    expect(platform.created).toBe(2);
    processor.dispose();
    expect(platform.disposed).toEqual([1, 2]);
  });

  it('a dispose() during init rejects that init and disposes the bridge it built', async () => {
    let open!: () => void;
    platform.gate = new Promise<void>((resolve) => { open = resolve; });
    const processor = new GeometryProcessor();
    const pending = processor.init();
    await vi.waitFor(() => expect(platform.created).toBe(1));
    processor.dispose();
    open();
    await expect(pending).rejects.toThrow(/superseded by dispose/);
    expect(platform.disposed).toEqual([1]);
    await expect(processor.process(new Uint8Array())).rejects.toThrow();
  });

  it('a failed native init disposes its bridge and is retried by the next init()', async () => {
    platform.failNext = new Error('no tauri');
    const processor = new GeometryProcessor();
    await expect(processor.init()).rejects.toThrow('no tauri');
    expect(platform.disposed).toEqual([1]);
    await processor.init();
    expect(platform.created).toBe(2);
  });
});
