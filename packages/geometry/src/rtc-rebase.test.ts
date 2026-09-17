/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo } from './coordinate-types.js';
import {
  carriesGpuInstancedGeometry,
  convergeGeometryOntoRtcAnchor,
  isOnRtcAnchor,
  rebaseCoordinateInfoOntoRtcAnchor,
  rebaseOriginByRtcDelta,
  rtcRebaseDeltaYup,
} from './rtc-rebase.js';
import { ifcToViewerAxes } from './world-frame.js';

type Origin = [number, number, number];

function coordInfo(partial: Partial<CoordinateInfo>): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: box,
    shiftedBounds: box,
    hasLargeCoordinates: false,
    ...partial,
  };
}

/** Non-round, asymmetric-sign IFC anchor, like the #4897 repro's model B. */
const ANCHOR = { x: 1234567.891, y: -987654.321, z: 42.75 };
/** Swiss LV95 magnitude: one f32 ULP here is 0.25 m. */
const LV95 = { x: 2_600_123.456, y: 1_200_654.321, z: 432.1 };

interface TestMesh { positions: Float32Array; origin?: Origin; geometryClass?: number; geometryAabb?: unknown; localToWorld?: number[] }

function raw(meshes: TestMesh[], over: Partial<CoordinateInfo> = {}) {
  return { coordinateInfo: coordInfo(over), meshes } as {
    coordinateInfo: CoordinateInfo;
    meshes: TestMesh[];
    instancedGeometryAabbs?: Map<number, unknown>;
    pointClouds?: unknown[];
  };
}

describe('rtcRebaseDeltaYup', () => {
  it('is zero when the anchor does not change, including absent -> explicit zero', () => {
    expect(rtcRebaseDeltaYup(ANCHOR, ANCHOR)).toEqual({ x: 0, y: 0, z: 0 });
    expect(rtcRebaseDeltaYup(undefined, { x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('is the Y-up form of the new anchor when moving off the raw frame', () => {
    expect(rtcRebaseDeltaYup(undefined, ANCHOR)).toEqual(ifcToViewerAxes(ANCHOR));
  });

  it('is the Y-up difference when moving between two real anchors', () => {
    const from = { x: 10, y: 20, z: 30 };
    const delta = rtcRebaseDeltaYup(from, ANCHOR);
    const expected = ifcToViewerAxes({ x: ANCHOR.x - 10, y: ANCHOR.y - 20, z: ANCHOR.z - 30 });
    expect(delta.x).toBeCloseTo(expected.x, 6);
    expect(delta.y).toBeCloseTo(expected.y, 6);
    expect(delta.z).toBeCloseTo(expected.z, 6);
  });
});

describe('rebaseOriginByRtcDelta', () => {
  it('treats an absent origin as [0,0,0] and returns a new array', () => {
    const delta = { x: 1, y: 2, z: 3 };
    expect(rebaseOriginByRtcDelta(undefined, delta)).toEqual([-1, -2, -3]);
    const shared: Origin = [5, 5, 5];
    const moved = rebaseOriginByRtcDelta(shared, delta);
    expect(moved).toEqual([4, 3, 2]);
    expect(shared).toEqual([5, 5, 5]);
  });
});

describe('precision (#4906 review): the rebase never narrows the anchor into f32', () => {
  it('keeps 1 mm of element detail exact at a Swiss LV95-scale anchor', () => {
    // Relativized wasm output: f64 element origin + small f32 local detail.
    const mesh: TestMesh = { positions: new Float32Array([0, 0, 0, 0.001, 0, 0]), origin: [12.5, 3.25, -7.75] };
    convergeGeometryOntoRtcAnchor([raw([mesh])], LV95);
    const origin = mesh.origin ?? [0, 0, 0];
    const x0 = origin[0] + mesh.positions[0];
    const x1 = origin[0] + mesh.positions[3];
    expect(Math.abs((x1 - x0) - 0.001)).toBeLessThan(1e-6);
    // ...and the element still lands where the new frame says it is.
    expect(x0 + LV95.x).toBeCloseTo(12.5, 6);
  });

  it('leaves the f32 positions bit-identical and moves only the f64 origin', () => {
    const positions = new Float32Array([0.123, -4.5, 6.75, 0.124, -4.5, 6.75]);
    const before = positions.slice();
    const mesh: TestMesh = { positions, origin: [100.25, 3, -50.5] };
    convergeGeometryOntoRtcAnchor([raw([mesh])], LV95);
    expect(mesh.positions).toBe(positions);
    expect(Array.from(mesh.positions)).toEqual(Array.from(before));
    const delta = ifcToViewerAxes(LV95);
    expect(mesh.origin).toEqual([100.25 - delta.x, 3 - delta.y, -50.5 - delta.z]);
  });

  it('gives an absolute-position mesh (no origin) an origin instead of touching its vertices', () => {
    const mesh: TestMesh = { positions: new Float32Array([1.5, 2.5, 3.5]) };
    convergeGeometryOntoRtcAnchor([raw([mesh])], LV95);
    expect(Array.from(mesh.positions)).toEqual([1.5, 2.5, 3.5]);
    const delta = ifcToViewerAxes(LV95);
    expect(mesh.origin).toEqual([-delta.x, -delta.y, -delta.z]);
  });
});

describe('convergeGeometryOntoRtcAnchor', () => {
  it('moves every raw geometry onto the anchor and reports it', () => {
    const a = raw([{ positions: new Float32Array([0, 1.5, 0]) }]);
    const b = raw([{ positions: new Float32Array([2, 3, 4]), origin: [1, 1, 1] }]);
    const { moved, refused } = convergeGeometryOntoRtcAnchor([a, b], ANCHOR);
    expect(moved).toEqual([a, b]);
    expect(refused).toEqual([]);
    expect(a.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
    expect(b.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
  });

  it('leaves a geometry already on the anchor alone', () => {
    const on = raw([{ positions: new Float32Array([1, 2, 3]), origin: [7, 8, 9] }], { wasmRtcOffset: { ...ANCHOR } });
    const info = on.coordinateInfo;
    expect(convergeGeometryOntoRtcAnchor([on], ANCHOR)).toEqual({ moved: [], refused: [] });
    expect(on.coordinateInfo).toBe(info);
    expect(on.meshes[0].origin).toEqual([7, 8, 9]);
  });

  it('moves a geometry drawn against a DIFFERENT real anchor (overlapping loads)', () => {
    const other = { x: 1234000, y: -987000, z: 40 };
    const g = raw([{ positions: new Float32Array([1, 2, 3]), origin: [0, 0, 0] }], { wasmRtcOffset: other });
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    const delta = rtcRebaseDeltaYup(other, ANCHOR);
    expect(g.meshes[0].origin).toEqual([-delta.x, -delta.y, -delta.z]);
    expect(g.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
  });

  it('is idempotent: a second call moves nothing', () => {
    const g = raw([{ positions: new Float32Array([1, 2, 3]), origin: [1, 2, 3] }]);
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    const origin = g.meshes[0].origin;
    expect(convergeGeometryOntoRtcAnchor([g], ANCHOR).moved).toEqual([]);
    expect(g.meshes[0].origin).toEqual(origin);
  });

  it('moves a MeshData shared by two geometries (or listed twice) exactly once', () => {
    const shared: TestMesh = { positions: new Float32Array([0, 0, 0]), origin: [0, 0, 0] };
    const g1 = raw([shared]);
    const g2 = raw([shared]);
    convergeGeometryOntoRtcAnchor([g1, g2, g1], ANCHOR);
    const delta = ifcToViewerAxes(ANCHOR);
    expect(shared.origin).toEqual([-delta.x, -delta.y, -delta.z]);
  });

  it('refuses a GPU-instanced geometry per model and still moves the others', () => {
    const plain = raw([{ positions: new Float32Array([2, 3, 4]) }]);
    const template = raw([{ positions: new Float32Array([0, 1.5, 0]), origin: [1, 1, 1], geometryClass: 2 }]);
    const boxesOnly = raw([{ positions: new Float32Array([0, 1.5, 0]), origin: [1, 1, 1] }]);
    boxesOnly.instancedGeometryAabbs = new Map([[7, { min: [0, 0, 0], max: [1, 1, 1] }]]);

    const { moved, refused } = convergeGeometryOntoRtcAnchor([plain, template, boxesOnly], ANCHOR);

    expect(moved).toEqual([plain]);
    expect(refused).toEqual([template, boxesOnly]);
    for (const g of [template, boxesOnly]) {
      expect(g.meshes[0].origin).toEqual([1, 1, 1]);
      expect(g.coordinateInfo.wasmRtcOffset).toBeUndefined();
    }
  });

  it('an EMPTY instanced-box map is not instanced geometry', () => {
    const g = raw([{ positions: new Float32Array([0, 1.5, 0]) }]);
    g.instancedGeometryAabbs = new Map();
    expect(carriesGpuInstancedGeometry(g)).toBe(false);
    expect(convergeGeometryOntoRtcAnchor([g], ANCHOR).moved).toEqual([g]);
  });

  it('never moves or refuses a point cloud: it is raw in every load order', () => {
    const cloud = raw([]);
    cloud.pointClouds = [{ expressId: 1 }];
    const info = cloud.coordinateInfo;
    expect(convergeGeometryOntoRtcAnchor([cloud], ANCHOR)).toEqual({ moved: [], refused: [] });
    expect(cloud.coordinateInfo).toBe(info);
  });
});

/**
 * Fixtures deliberately capable of failing: a non-round anchor so the delta
 * is non-zero on all three axes, an ASYMMETRIC box, and distinct
 * `originalBounds` / `shiftedBounds` objects.
 */
describe('rebaseCoordinateInfoOntoRtcAnchor / frame-carrying fields', () => {
  function framed() {
    return raw([{
      positions: new Float32Array([-11, 0.5, -3, 4, 19, 1.25]),
      origin: [0.5, 0.25, 0.125],
      geometryAabb: { min: [-11, 0.5, -3], max: [4, 19, 1.25] },
      localToWorld: [1, 0, 0, 100.5, 0, 1, 0, -200.25, 0, 0, 1, 300.125, 0, 0, 0, 1],
    }], {
      originShift: { x: 3, y: 5, z: 7 },
      originalBounds: { min: { x: -11, y: 0.5, z: -3 }, max: { x: 4, y: 19, z: 1.25 } },
      shiftedBounds: { min: { x: -14, y: -4.5, z: -10 }, max: { x: 1, y: 14, z: -5.75 } },
      wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false },
    });
  }

  it('moves both render-frame boxes by the same non-zero delta as the origin', () => {
    const g = framed();
    const originalBefore = structuredClone(g.coordinateInfo.originalBounds);
    const shiftedBefore = structuredClone(g.coordinateInfo.shiftedBounds);
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    const delta = ifcToViewerAxes(ANCHOR);
    expect(Math.min(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z))).toBeGreaterThan(1);
    expect(g.meshes[0].origin).toEqual([0.5 - delta.x, 0.25 - delta.y, 0.125 - delta.z]);
    for (const edge of ['min', 'max'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(g.coordinateInfo.originalBounds[edge][axis]).toBeCloseTo(originalBefore[edge][axis] - delta[axis], 9);
        expect(g.coordinateInfo.shiftedBounds[edge][axis]).toBeCloseTo(shiftedBefore[edge][axis] - delta[axis], 9);
      }
    }
  });

  it('keeps the world position the boxes report, and originalBounds - shiftedBounds === originShift', () => {
    const g = framed();
    const shift = g.coordinateInfo.originShift;
    const worldBefore = g.coordinateInfo.shiftedBounds.min.x + shift.x;
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    const rtcYup = ifcToViewerAxes(g.coordinateInfo.wasmRtcOffset!);
    expect(g.coordinateInfo.shiftedBounds.min.x + shift.x + rtcYup.x).toBeCloseTo(worldBefore, 9);
    const { originalBounds, shiftedBounds, originShift } = g.coordinateInfo;
    expect(originalBounds.max.z - shiftedBounds.max.z).toBeCloseTo(originShift.z, 9);
  });

  it('replaces the stale wasmRtcFrame with the frame the geometry is now in (#4906 review)', () => {
    const g = framed();
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    // The cache serialiser's invariant: needsShift === (wasmRtcOffset present),
    // and active components equal the offset.
    expect(g.coordinateInfo.wasmRtcFrame).toEqual({ ...ANCHOR, needsShift: true });
    expect(isOnRtcAnchor(g.coordinateInfo, ANCHOR)).toBe(true);
  });

  it('leaves the ABSOLUTE-world fields alone: geometryAabb and localToWorld do not move', () => {
    const g = framed();
    const aabbBefore = structuredClone(g.meshes[0].geometryAabb);
    const l2wBefore = [...g.meshes[0].localToWorld!];
    convergeGeometryOntoRtcAnchor([g], ANCHOR);
    expect(g.meshes[0].geometryAabb).toEqual(aabbBefore);
    expect(g.meshes[0].localToWorld).toEqual(l2wBefore);
  });

  it('does not mutate the CoordinateInfo it was given', () => {
    const info = framed().coordinateInfo;
    const before = structuredClone(info);
    rebaseCoordinateInfoOntoRtcAnchor(info, ANCHOR);
    expect(info).toEqual(before);
  });
});
