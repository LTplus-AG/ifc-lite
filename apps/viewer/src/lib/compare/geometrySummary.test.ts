/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import {
  meshBounds,
  meshBoundsIndex,
  renderToWorldShift,
  summarizeGeometryChange,
  type Aabb,
} from './geometrySummary.js';

/**
 * `MeshData.positions` are per-element LOCAL-frame coordinates on the wasm
 * path: world vertex i = `origin + positions[3i..3i+3]`, and the local frame
 * is the DEFAULT there (`rust/geometry/src/router/transforms/mod.rs`). The
 * origin is the element's AABB centre, so it FOLLOWS the element: a pure
 * translation leaves `positions` byte-identical and moves only `origin`.
 *
 * `meshBounds` summed raw `positions`, so a genuinely moved element reported
 * `movedDistance = 0, reshaped = false` - no "Moved" badge in the panel and
 * `MovedDistance_m = 0` in the bulk CSV that #2529 extracted this logic into.
 * Every fixture in #2529's tests built meshes WITHOUT `origin`, which is why
 * the gap was invisible. These fixtures carry one.
 */

function mesh(
  expressId: number,
  positions: readonly number[],
  extras: { origin?: [number, number, number]; geometryAabb?: Aabb } = {},
): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    ...extras,
  } as unknown as MeshData;
}

/** Unit cube centred on its own local origin - the shape the wasm local frame
 *  produces (origin = element AABB centre, positions relative to it). */
const UNIT_CUBE = [
  -0.5, -0.5, -0.5,
  0.5, -0.5, -0.5,
  0.5, 0.5, 0.5,
  -0.5, 0.5, 0.5,
];

/** An un-georeferenced model: its render frame IS the world frame. */
const NO_SHIFT = renderToWorldShift(undefined);

/** A georeferenced model's `CoordinateInfo`: the wasm pass subtracted `rtc`
 *  (recorded in IFC Z-up axes) from every position. Bounds are irrelevant to
 *  the shift and left empty. */
function geoInfo(rtc: { x: number; y: number; z: number }): CoordinateInfo {
  const zero = { x: 0, y: 0, z: 0 };
  return {
    originShift: zero,
    originalBounds: { min: zero, max: zero },
    shiftedBounds: { min: zero, max: zero },
    hasLargeCoordinates: true,
    wasmRtcOffset: rtc,
  };
}

describe('meshBounds folds MeshData.origin (#2529 regression)', () => {
  it('reports a pure translation carried only by origin as a move with the true distance', () => {
    // Identical positions on both sides; only the per-element origin moved,
    // exactly what the wasm local-frame pipeline emits for a moved element.
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [10, 2, 3] })], 7, NO_SHIFT);
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [50, 2, 3] })], 7, NO_SHIFT);
    assert.ok(ba && bb, 'both sides must produce a box');
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 40) < 1e-6,
      `element moved 40 m via origin only; got movedDistance = ${summary.movedDistance}`,
    );
    assert.strictEqual(summary.reshaped, false, 'a pure translation is not a reshape');
  });

  it('still detects a reshape when origin is non-zero (not everything reads as moved)', () => {
    // Same origin both sides; the mesh itself grew 1 m in local x. The fold
    // must not blur a real shape change into a phantom move-only answer.
    const grown = [
      -1.5, -0.5, -0.5,
      0.5, -0.5, -0.5,
      0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5,
    ];
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [10, 2, 3] })], 7, NO_SHIFT);
    const bb = meshBounds([mesh(7, grown, { origin: [10, 2, 3] })], 7, NO_SHIFT);
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.strictEqual(summary.reshaped, true, 'the box grew 1 m in x - that is a reshape');
    assert.ok(Math.abs(summary.sizeDelta.x - 1) < 1e-6, `sizeDelta.x = ${summary.sizeDelta.x}`);
  });

  it('keeps precision at georeferenced world coordinates (origin is f64)', () => {
    // The local frame exists precisely so f32 positions stay element-small at
    // georef scale; the fold must do the world reconstruction in f64 and keep
    // a 40 m move readable next to a 4,200 km coordinate.
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [4200000, 30, 5100000] })], 7, NO_SHIFT);
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [4200040, 30, 5100000] })], 7, NO_SHIFT);
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 40) < 1e-6,
      `expected 40 m at georef scale, got ${summary.movedDistance}`,
    );
    assert.strictEqual(summary.reshaped, false);
  });

  it('unions all submeshes of the entity and ignores other entities', () => {
    const meshes = [
      mesh(7, [-0.5, 0, 0, 0.5, 0, 0], { origin: [10, 0, 0] }),
      mesh(7, [0, -2, 0, 0, 2, 0], { origin: [10, 0, 0] }),
      mesh(8, [100, 100, 100], { origin: [1000, 0, 0] }), // different element
    ];
    assert.deepStrictEqual(meshBounds(meshes, 7, NO_SHIFT), {
      frame: 'world',
      min: [9.5, -2, 0],
      max: [10.5, 2, 0],
    });
  });

  it('prefers the wasm world box (geometryAabb) over folding positions', () => {
    // `geometryAabb` is ABSOLUTE world - RTC offset AND origin already folded
    // (see `MeshData.geometryAabb` / buildFingerprints.ts). Two revisions that
    // chose different RTC offsets agree only through it, so when the hashing
    // pass produced one it must win over any locally folded box.
    const withBox = mesh(7, UNIT_CUBE, {
      origin: [10, 2, 3],
      geometryAabb: { min: [109.5, 1.5, 2.5], max: [110.5, 2.5, 3.5] },
    });
    assert.deepStrictEqual(meshBounds([withBox], 7, NO_SHIFT), {
      frame: 'world',
      min: [109.5, 1.5, 2.5],
      max: [110.5, 2.5, 3.5],
    });
  });

  it('returns null for an absent entity and for an entity with empty positions', () => {
    assert.strictEqual(meshBounds([mesh(7, UNIT_CUBE)], 99, NO_SHIFT), null);
    assert.strictEqual(meshBounds([mesh(7, [])], 7, NO_SHIFT), null);
  });

  it('treats absent origin as world positions (legacy / native meshes)', () => {
    assert.deepStrictEqual(meshBounds([mesh(7, [1, 2, 3, 5, 6, 7])], 7, NO_SHIFT), {
      frame: 'world',
      min: [1, 2, 3],
      max: [5, 6, 7],
    });
  });
});

describe('mixed frames: one-sided geometryAabb on a georeferenced model (#2659)', () => {
  // The RTC offset the wasm pass subtracted, in IFC Z-up axes. As a Y-up
  // render-to-world shift that is (x, z, -y) = (4200000, 0, -5100000), so
  // absolute world = origin + positions + shift. Both revisions here chose
  // the same RTC.
  const TO_WORLD = renderToWorldShift(geoInfo({ x: 4200000, y: 5100000, z: 0 }));

  it('reports the element movement, not the RTC offset, when only one side kept its box', () => {
    // Base kept its wasm box (absolute world). Head is the supported NaN-drop
    // case: hashed, but the box was dropped at the boundary
    // (`geometry-fingerprints.ts` resolves a NaN sentinel to undefined), so it
    // falls back to origin + positions. The element really moved 2 m in x.
    // Without lifting the fallback into the absolute frame, the head side
    // stays RTC-relative and the "movement" is the 6,600 km RTC offset.
    const ba = meshBounds(
      [mesh(7, UNIT_CUBE, { geometryAabb: { min: [4200009.5, 1.5, -5099997.5], max: [4200010.5, 2.5, -5099996.5] } })],
      7,
      TO_WORLD,
    );
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [12, 2, 3] })], 7, TO_WORLD);
    assert.ok(ba && bb, 'both sides must produce a box');
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 2) < 1e-6,
      `element moved 2 m; a mixed-frame comparison fabricates the RTC offset instead - got movedDistance = ${summary.movedDistance}`,
    );
    assert.strictEqual(summary.reshaped, false, 'a pure translation is not a reshape');
  });

  it('folds each revision its OWN shift when neither side has a box and the RTC choices differ', () => {
    // Fallback vs fallback across two revisions that chose different RTC
    // offsets: each side is relative to its own frame, so comparing them raw
    // reports the frame difference, not the element. Real movement: 2 m in x.
    const toWorldA = { x: 1000, y: 0, z: 0 } as const;
    const toWorldB = { x: 2000, y: 0, z: 0 } as const;
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [5, 0, 0] })], 7, toWorldA); // abs 1005
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [-993, 0, 0] })], 7, toWorldB); // abs 1007
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 2) < 1e-6,
      `element moved 2 m across differing RTC choices; got movedDistance = ${summary.movedDistance}`,
    );
  });

  it('keeps the both-sided geometryAabb comparison unchanged (boxes already absolute)', () => {
    // When BOTH sides carry the wasm box the shift must not be applied to
    // them - they are already absolute - so the answer is exactly the box
    // delta regardless of the model shift passed alongside.
    const ba = meshBounds(
      [mesh(7, UNIT_CUBE, { origin: [10, 2, 3], geometryAabb: { min: [4200009.5, 1.5, -5099997.5], max: [4200010.5, 2.5, -5099996.5] } })],
      7,
      TO_WORLD,
    );
    const bb = meshBounds(
      [mesh(7, UNIT_CUBE, { origin: [12, 2, 3], geometryAabb: { min: [4200011.5, 1.5, -5099997.5], max: [4200012.5, 2.5, -5099996.5] } })],
      7,
      TO_WORLD,
    );
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 2) < 1e-6,
      `box-vs-box distance must stay 2 m; got ${summary.movedDistance}`,
    );
  });
});

describe('renderToWorldShift', () => {
  it('composes originShift with the Z-up-to-Y-up-swapped RTC offset', () => {
    // reproject.ts contract: world_yup = render + originShift + (rtc.x, rtc.z, -rtc.y).
    const info = geoInfo({ x: 100, y: 200, z: 300 });
    const shifted: CoordinateInfo = { ...info, originShift: { x: 1, y: 2, z: 3 } };
    assert.deepStrictEqual(renderToWorldShift(shifted), { x: 101, y: 302, z: -197 });
  });

  it('answers the zero shift for a model with no coordinate info', () => {
    assert.deepStrictEqual(renderToWorldShift(undefined), { x: 0, y: 0, z: 0 });
  });
});

describe('meshBoundsIndex (the bulk-report twin, #2529)', () => {
  it('agrees with meshBounds for every entity, origin fold included', () => {
    const meshes = [
      mesh(7, UNIT_CUBE, { origin: [10, 2, 3] }),
      mesh(7, [0, -2, 0, 0, 2, 0], { origin: [10, 2, 3] }),
      mesh(8, UNIT_CUBE, {
        origin: [50, 0, 0],
        geometryAabb: { min: [49.5, -0.5, -0.5], max: [50.5, 0.5, 0.5] },
      }),
      mesh(9, []),
    ];
    const index = meshBoundsIndex(meshes, NO_SHIFT);
    assert.deepStrictEqual(index.get(7), meshBounds(meshes, 7, NO_SHIFT));
    assert.deepStrictEqual(index.get(8), meshBounds(meshes, 8, NO_SHIFT));
    assert.strictEqual(index.has(9), false, 'an entity with no vertices gets no box');
  });

  it('folds the render-to-world shift exactly like meshBounds (#2659 binds both paths)', () => {
    // The bulk CSV must not disagree with the detail panel about the frame:
    // same georeferenced shift, same absolute box.
    const toWorld = renderToWorldShift(geoInfo({ x: 4200000, y: 5100000, z: 0 }));
    const meshes = [mesh(7, UNIT_CUBE, { origin: [12, 2, 3] })];
    const indexed = meshBoundsIndex(meshes, toWorld).get(7);
    assert.deepStrictEqual(indexed, meshBounds(meshes, 7, toWorld));
    assert.deepStrictEqual(indexed, {
      frame: 'world',
      min: [4200011.5, 1.5, -5099997.5],
      max: [4200012.5, 2.5, -5099996.5],
    });
  });
});
