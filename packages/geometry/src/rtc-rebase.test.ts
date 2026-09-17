/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo } from './coordinate-types.js';
import { rebaseGeometryOntoFirstRealAnchor, rebasePositionsToRtcOffset, rtcRebaseDeltaYup } from './rtc-rebase.js';
import { ifcToViewerAxes, viewerToIfcAxes } from './world-frame.js';

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

describe('rtcRebaseDeltaYup', () => {
  it('is zero when the anchor does not change', () => {
    const delta = rtcRebaseDeltaYup(ANCHOR, ANCHOR);
    expect(delta).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('is zero moving from an absent offset to an explicit zero one', () => {
    const delta = rtcRebaseDeltaYup(undefined, { x: 0, y: 0, z: 0 });
    expect(delta).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('is the Y-up form of the new anchor when moving off the raw (absent) frame', () => {
    const delta = rtcRebaseDeltaYup(undefined, ANCHOR);
    expect(delta).toEqual(ifcToViewerAxes(ANCHOR));
  });

  it('round-trips: applying the delta then its inverse returns the original point', () => {
    const forward = rtcRebaseDeltaYup(undefined, ANCHOR);
    const back = rtcRebaseDeltaYup(ANCHOR, { x: 0, y: 0, z: 0 });
    expect(forward.x + back.x).toBeCloseTo(0, 9);
    expect(forward.y + back.y).toBeCloseTo(0, 9);
    expect(forward.z + back.z).toBeCloseTo(0, 9);
  });
});

describe('rebasePositionsToRtcOffset', () => {
  it('leaves positions untouched when the anchor is unchanged', () => {
    const positions = new Float32Array([1.5, -2.25, 3.125, 10, 20, 30]);
    const before = positions.slice();
    rebasePositionsToRtcOffset(positions, ANCHOR, ANCHOR);
    expect(positions).toEqual(before);
  });

  it('shifts a raw-frame mesh into a newly-introduced anchor and the world point stays put', () => {
    // A raw-frame vertex IS the world point (Y-up-swapped): the box centre
    // from the #4897 repro, (0, 1.5, 0) render-frame == (0, 0, 1.5) IFC.
    const positions = new Float32Array([0, 1.5, 0]);
    const worldBefore = viewerToIfcAxes({ x: positions[0], y: positions[1], z: positions[2] });

    rebasePositionsToRtcOffset(positions, undefined, ANCHOR);

    // The vertex moved...
    expect(positions[0]).not.toBeCloseTo(0, 3);
    // ...but adding the new anchor back (render -> world) recovers the SAME
    // world point: re-basing must not change what a model represents.
    const worldAfter = viewerToIfcAxes({ x: positions[0], y: positions[1], z: positions[2] });
    const recovered = { x: worldAfter.x + ANCHOR.x, y: worldAfter.y + ANCHOR.y, z: worldAfter.z + ANCHOR.z };
    // `positions` is a Float32Array: at ANCHOR's ~1.2e6 magnitude, a single
    // ULP is ~0.06, so this is a float32-precision comparison, not float64.
    expect(recovered.x).toBeCloseTo(worldBefore.x, 1);
    expect(recovered.y).toBeCloseTo(worldBefore.y, 1);
    expect(recovered.z).toBeCloseTo(worldBefore.z, 1);
  });

  it('handles a trailing partial vertex without throwing or touching it', () => {
    const positions = new Float32Array([1, 2, 3, 4, 5]); // 1 full vertex + 2 stray components
    expect(() => rebasePositionsToRtcOffset(positions, undefined, ANCHOR)).not.toThrow();
    expect(positions[3]).toBe(4);
    expect(positions[4]).toBe(5);
  });
});

describe('rebaseGeometryOntoFirstRealAnchor', () => {
  it('is a no-op when the just-loaded model has no offset', () => {
    const raw = { coordinateInfo: coordInfo({}), meshes: [{ positions: new Float32Array([1, 2, 3]) }] };
    const moved = rebaseGeometryOntoFirstRealAnchor([raw], null);
    expect(moved).toEqual([]);
    expect(raw.coordinateInfo.wasmRtcOffset).toBeUndefined();
    expect(raw.meshes[0].positions).toEqual(new Float32Array([1, 2, 3]));
  });

  it('is a no-op when an existing model already has a real anchor (loader already unified it)', () => {
    const existingAnchor = { x: 5, y: 6, z: 7 };
    const alreadyAnchored = {
      coordinateInfo: coordInfo({ wasmRtcOffset: existingAnchor }),
      meshes: [{ positions: new Float32Array([1, 2, 3]) }],
    };
    const moved = rebaseGeometryOntoFirstRealAnchor([alreadyAnchored], ANCHOR);
    expect(moved).toEqual([]);
    // Untouched: still the ORIGINAL anchor, not overwritten by the new one.
    expect(alreadyAnchored.coordinateInfo.wasmRtcOffset).toEqual(existingAnchor);
    expect(alreadyAnchored.meshes[0].positions).toEqual(new Float32Array([1, 2, 3]));
  });

  it('rebases every still-raw model onto the first real anchor introduced', () => {
    const raw1 = { coordinateInfo: coordInfo({}), meshes: [{ positions: new Float32Array([0, 1.5, 0]) }] };
    const raw2 = { coordinateInfo: coordInfo({}), meshes: [{ positions: new Float32Array([2, 3, 4]) }] };

    const moved = rebaseGeometryOntoFirstRealAnchor([raw1, raw2], ANCHOR);

    expect(moved).toEqual([raw1, raw2]);
    expect(raw1.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
    expect(raw2.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
    // Positions actually moved (mutated in place) — not merely re-tagged.
    expect(raw1.meshes[0].positions).not.toEqual(new Float32Array([0, 1.5, 0]));
  });

  it('refuses a federation whose raw model carries an instanced-type template', () => {
    // Class 2 is a GPU-instanced TEMPLATE: the occurrences that place it are
    // in instance buffers this module cannot reach, so moving the meshes
    // would leave one model straddling two frames (#4906 review).
    const raw = {
      coordinateInfo: coordInfo({}),
      meshes: [
        { positions: new Float32Array([0, 1.5, 0]) },
        { positions: new Float32Array([1, 1, 1]), geometryClass: 2 },
      ],
    };
    const moved = rebaseGeometryOntoFirstRealAnchor([raw], ANCHOR);
    expect(moved).toEqual([]);
    expect(raw.coordinateInfo.wasmRtcOffset).toBeUndefined();
    expect(raw.meshes[0].positions).toEqual(new Float32Array([0, 1.5, 0]));
  });

  it('refuses on a non-empty instanced-box map even with no template mesh', () => {
    const raw = {
      coordinateInfo: coordInfo({}),
      meshes: [{ positions: new Float32Array([0, 1.5, 0]) }],
      instancedGeometryAabbs: new Map([[7, { min: [0, 0, 0], max: [1, 1, 1] }]]),
    };
    expect(rebaseGeometryOntoFirstRealAnchor([raw], ANCHOR)).toEqual([]);
    expect(raw.meshes[0].positions).toEqual(new Float32Array([0, 1.5, 0]));
  });

  it('refuses the WHOLE federation when only one of its models is instanced', () => {
    // A per-model refusal would move the other models and leave this one
    // behind, which is the frame split #4897 is about, one level down.
    const plain = { coordinateInfo: coordInfo({}), meshes: [{ positions: new Float32Array([2, 3, 4]) }] };
    const instanced = {
      coordinateInfo: coordInfo({}),
      meshes: [{ positions: new Float32Array([0, 1.5, 0]), geometryClass: 2 }],
    };
    expect(rebaseGeometryOntoFirstRealAnchor([plain, instanced], ANCHOR)).toEqual([]);
    expect(plain.meshes[0].positions).toEqual(new Float32Array([2, 3, 4]));
    expect(plain.coordinateInfo.wasmRtcOffset).toBeUndefined();
  });

  it('an EMPTY instanced-box map is not instanced geometry and still re-bases', () => {
    const raw = {
      coordinateInfo: coordInfo({}),
      meshes: [{ positions: new Float32Array([0, 1.5, 0]) }],
      instancedGeometryAabbs: new Map(),
    };
    expect(rebaseGeometryOntoFirstRealAnchor([raw], ANCHOR)).toEqual([raw]);
    expect(raw.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
  });

  it('mutates every mesh of a multi-mesh model, not just the first', () => {
    const raw = {
      coordinateInfo: coordInfo({}),
      meshes: [
        { positions: new Float32Array([1, 1, 1]) },
        { positions: new Float32Array([2, 2, 2]) },
      ],
    };
    rebaseGeometryOntoFirstRealAnchor([raw], ANCHOR);
    expect(raw.meshes[0].positions).not.toEqual(new Float32Array([1, 1, 1]));
    expect(raw.meshes[1].positions).not.toEqual(new Float32Array([2, 2, 2]));
  });
});

/**
 * The frame move must land on EVERYTHING that is in the render frame, in the
 * same call, and on nothing that is not (#4906 review of #4897).
 *
 * Fixtures here are deliberately capable of failing: a non-round anchor so the
 * delta is non-zero on all three axes, an ASYMMETRIC box (a symmetric one
 * shifted the wrong way, or not at all, can still look plausible), and
 * distinct `originalBounds` / `shiftedBounds` objects so a change to one
 * cannot be mistaken for a change to the other.
 */
describe('rebaseGeometryOntoFirstRealAnchor — frame-carrying fields', () => {
  /** Asymmetric on every axis, and `originalBounds !== shiftedBounds`. */
  function framedGeometry() {
    return {
      coordinateInfo: coordInfo({
        originShift: { x: 3, y: 5, z: 7 },
        originalBounds: { min: { x: -11, y: 0.5, z: -3 }, max: { x: 4, y: 19, z: 1.25 } },
        shiftedBounds: { min: { x: -14, y: -4.5, z: -10 }, max: { x: 1, y: 14, z: -5.75 } },
      }),
      meshes: [{
        positions: new Float32Array([-11, 0.5, -3, 4, 19, 1.25]),
        geometryAabb: { min: [-11, 0.5, -3] as [number, number, number], max: [4, 19, 1.25] as [number, number, number] },
        localToWorld: [1, 0, 0, 100.5, 0, 1, 0, -200.25, 0, 0, 1, 300.125, 0, 0, 0, 1],
      }],
    };
  }

  it('moves both render-frame boxes by the SAME non-zero delta as the positions', () => {
    const geometry = framedGeometry();
    const positionsBefore = geometry.meshes[0].positions.slice();
    const originalBefore = structuredClone(geometry.coordinateInfo.originalBounds);
    const shiftedBefore = structuredClone(geometry.coordinateInfo.shiftedBounds);

    rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR);

    const delta = ifcToViewerAxes(ANCHOR);
    // The delta is worth nothing as a witness if it is zero on some axis.
    expect(Math.min(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z))).toBeGreaterThan(1);

    // Positions moved by -delta (f32 at ~1.2e6: one ULP is ~0.06).
    expect(geometry.meshes[0].positions[0]).toBeCloseTo(positionsBefore[0] - delta.x, 1);
    expect(geometry.meshes[0].positions[1]).toBeCloseTo(positionsBefore[1] - delta.y, 1);
    expect(geometry.meshes[0].positions[2]).toBeCloseTo(positionsBefore[2] - delta.z, 1);

    // ...and so did both boxes, by exactly the same delta (f64 here).
    const { originalBounds, shiftedBounds } = geometry.coordinateInfo;
    for (const edge of ['min', 'max'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(originalBounds[edge][axis]).toBeCloseTo(originalBefore[edge][axis] - delta[axis], 9);
        expect(shiftedBounds[edge][axis]).toBeCloseTo(shiftedBefore[edge][axis] - delta[axis], 9);
      }
    }
  });

  it('keeps the world position the two boxes report unchanged across the re-base', () => {
    // What a consumer actually reads: `bounds + originShift + rtcYup`
    // (`computeFootprintGeoJSON`). The re-base must not move the model.
    const geometry = framedGeometry();
    const shift = geometry.coordinateInfo.originShift;
    const worldBefore = {
      x: geometry.coordinateInfo.shiftedBounds.min.x + shift.x,
      y: geometry.coordinateInfo.shiftedBounds.min.y + shift.y,
      z: geometry.coordinateInfo.shiftedBounds.min.z + shift.z,
    };

    rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR);

    const rtcYup = ifcToViewerAxes(geometry.coordinateInfo.wasmRtcOffset!);
    const after = geometry.coordinateInfo.shiftedBounds.min;
    expect(after.x + shift.x + rtcYup.x).toBeCloseTo(worldBefore.x, 9);
    expect(after.y + shift.y + rtcYup.y).toBeCloseTo(worldBefore.y, 9);
    expect(after.z + shift.z + rtcYup.z).toBeCloseTo(worldBefore.z, 9);
  });

  it('preserves `originalBounds - shiftedBounds === originShift`', () => {
    const geometry = framedGeometry();
    rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR);
    const { originalBounds, shiftedBounds, originShift } = geometry.coordinateInfo;
    for (const edge of ['min', 'max'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(originalBounds[edge][axis] - shiftedBounds[edge][axis]).toBeCloseTo(originShift[axis], 9);
      }
    }
  });

  it('leaves the ABSOLUTE-world fields alone: geometryAabb and localToWorld do not move', () => {
    // Both are RTC-invariant by contract — `geometryAabb` has the file's RTC
    // folded back in, `localToWorld` is the pre-RTC placement chain — so the
    // new `wasmRtcOffset` is what re-aligns them with the moved vertices.
    // Translating them here would move the model in the world.
    const geometry = framedGeometry();
    const aabbBefore = structuredClone(geometry.meshes[0].geometryAabb);
    const l2wBefore = [...geometry.meshes[0].localToWorld];

    rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR);

    expect(geometry.meshes[0].geometryAabb).toEqual(aabbBefore);
    expect(geometry.meshes[0].localToWorld).toEqual(l2wBefore);
  });

  it('absent stays absent: a mesh with no geometryAabb / localToWorld gains neither', () => {
    const geometry = {
      coordinateInfo: coordInfo({
        originalBounds: { min: { x: -11, y: 0.5, z: -3 }, max: { x: 4, y: 19, z: 1.25 } },
        shiftedBounds: { min: { x: -11, y: 0.5, z: -3 }, max: { x: 4, y: 19, z: 1.25 } },
      }),
      meshes: [{ positions: new Float32Array([-11, 0.5, -3]) }],
    };

    expect(rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR)).toEqual([geometry]);

    expect('geometryAabb' in geometry.meshes[0]).toBe(false);
    expect('localToWorld' in geometry.meshes[0]).toBe(false);
    // The re-base did happen — otherwise the two assertions above prove nothing.
    expect(geometry.coordinateInfo.wasmRtcOffset).toEqual(ANCHOR);
  });

  it('leaves the boxes untouched when it refuses an instanced federation', () => {
    const geometry = framedGeometry();
    (geometry.meshes[0] as { geometryClass?: number }).geometryClass = 2;
    const originalBefore = structuredClone(geometry.coordinateInfo.originalBounds);
    const shiftedBefore = structuredClone(geometry.coordinateInfo.shiftedBounds);

    expect(rebaseGeometryOntoFirstRealAnchor([geometry], ANCHOR)).toEqual([]);

    expect(geometry.coordinateInfo.originalBounds).toEqual(originalBefore);
    expect(geometry.coordinateInfo.shiftedBounds).toEqual(shiftedBefore);
    expect(geometry.coordinateInfo.wasmRtcOffset).toBeUndefined();
  });
});
