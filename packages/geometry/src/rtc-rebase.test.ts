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
