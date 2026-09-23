/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5210: once a producer is validated, `calculateBounds` samples each mesh's
 * first and last vertex without the per-vertex validity filter. One garbage
 * vertex used to widen the accumulated bounds for the rest of the load, and
 * every later clean batch compared against it and lost. The sampled per-batch
 * result is now checked once; a poisoned batch is recomputed through the
 * filtered path and counted in `boundsRecoveryFallbackCount`.
 */

import { describe, it, expect, vi } from 'vitest';
import { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';

const GARBAGE = 1.0e30;

/** One triangle with the given vertices (x,y,z triples). */
function mesh(expressId: number, verts: number[], origin?: [number, number, number]): MeshData {
  return {
    expressId,
    positions: new Float32Array(verts),
    normals: new Float32Array(verts.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ...(origin ? { origin } : {}),
  };
}

function meshAt(x: number, y: number, z: number): MeshData {
  return mesh(1, [x, y, z, x, y, z, x, y, z]);
}

/** A handler past its first-batch decision, on the sampling path (WASM RTC applied). */
function establishedHandler(): CoordinateHandler {
  const handler = new CoordinateHandler();
  handler.setWasmMetadata(1, { x: 2_600_000, y: 1_200_000, z: 0 });
  handler.processMeshesIncremental([meshAt(100, 0, 0), meshAt(-100, 0, 0)]);
  return handler;
}

describe('CoordinateHandler bounds recovery (#5210)', () => {
  it('one garbage batch does not poison the bounds of the rest of the load', () => {
    const handler = establishedHandler();
    handler.processMeshesIncremental([meshAt(GARBAGE, GARBAGE, GARBAGE)]);
    handler.processMeshesIncremental([meshAt(50, 20, 3)]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originalBounds.max.x).toBe(100);
    expect(info.originalBounds.max.y).toBe(20);
    expect(info.originalBounds.max.z).toBe(3);
    expect(info.originalBounds.min.x).toBe(-100);
    expect(info.boundsRecoveryFallbackCount).toBe(1);
    expect(handler.getCurrentCoordinateInfo()?.boundsRecoveryFallbackCount).toBe(1);
  });

  it('keeps the clean vertices of a batch whose sampled last vertex is garbage', () => {
    const handler = establishedHandler();
    handler.processMeshesIncremental([mesh(2, [300, 0, 0, 300, 0, 0, GARBAGE, GARBAGE, GARBAGE])]);
    expect(handler.getFinalCoordinateInfo().originalBounds.max.x).toBe(300);
  });

  it('the recompute drops only the garbage, not geometry the sampling path keeps', () => {
    // A long infrastructure model can legitimately reach past the 10 km
    // post-RTC threshold. The sampling path keeps such a vertex; a batch
    // recomputed because of an unrelated garbage vertex must keep it too.
    const handler = establishedHandler();
    handler.processMeshesIncremental([meshAt(20_000, 0, 0), meshAt(GARBAGE, 0, 0)]);
    const info = handler.getFinalCoordinateInfo();
    expect(info.originalBounds.max.x).toBe(20_000);
    expect(info.boundsRecoveryFallbackCount).toBe(1);
  });

  it('counts once per poisoned batch, never for clean or empty batches, and resets', () => {
    const handler = establishedHandler();
    handler.processMeshesIncremental([meshAt(10, 0, 0)]);
    handler.processMeshesIncremental([]);
    handler.processMeshesIncremental([mesh(3, [])]);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(0);

    handler.processMeshesIncremental([meshAt(GARBAGE, 0, 0), meshAt(0, GARBAGE, 0)]);
    handler.processMeshesIncremental([meshAt(Infinity, 0, 0)]);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(2);

    // NaN on one axis leaves that axis looking empty while the others carry
    // garbage; the batch is still poisoned, and the garbage never lands.
    handler.processMeshesIncremental([meshAt(Number.NaN, GARBAGE, GARBAGE)]);
    const info = handler.getFinalCoordinateInfo();
    expect(info.boundsRecoveryFallbackCount).toBe(3);
    expect(info.originalBounds.max.y).toBeLessThan(1e7);

    handler.reset();
    handler.processMeshesIncremental([meshAt(10, 0, 0)]);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(0);
  });

  it('stays on the sampling path for clean batches at UTM-scale world coordinates', () => {
    // world = origin + position. A native producer (no setWasmMetadata) with
    // metre-scale positions is inferred RTC-applied and becomes eligible even
    // though its world coordinates sit at real eastings/northings. A check
    // against the 10 km threshold would fall back on every batch here.
    const handler = new CoordinateHandler();
    const utm = (id: number, e: number, n: number) =>
      mesh(id, [0, 0, 0, 1, 1, 0, 2, 0, 0.5], [e, n, 0]);
    const fastSpy = vi.spyOn(
      handler as unknown as { calculateBoundsFast: (m: MeshData[]) => unknown },
      'calculateBoundsFast',
    );
    handler.processMeshesIncremental([utm(1, 500_000, 5_000_000)]);
    fastSpy.mockClear();
    for (let i = 0; i < 5; i++) {
      handler.processMeshesIncremental([utm(2 + i, 500_000 + i * 10, 5_000_000 + i * 10)]);
    }
    expect(fastSpy).toHaveBeenCalledTimes(5);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(0);
  });
});
