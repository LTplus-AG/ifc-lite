/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The kept half of the section cut (#2042).
 *
 * DEFECT CLASS — printing the half the user cut away. The screen decides with
 * a fragment discard, the export decides with a triangle clip, and the two
 * express the SAME half in opposite forms: the shader keeps
 * `(dot(p,n) - d) * side <= 0` with `side = flipped ? -1 : 1`, while
 * `clipMeshToHalfSpace` only understands `dot(p, normal) <= offset`. Drop the
 * negation and the PDF is dimensionally perfect and shows the wrong building —
 * nothing downstream can tell, because the drawing, the layout and the scale
 * are all self-consistent about the wrong geometry.
 *
 * So the central test here does not assert a normal or an offset in isolation:
 * it re-implements the shader's own predicate, verbatim from
 * `packages/renderer/src/shaders/main.wgsl.ts`, and asserts the two agree
 * point for point. A sign error cannot survive that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveKeptHalfSpace,
  type ViewSectionResolveInput,
} from './view-section-plane.js';

const SCENE_BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 8, z: 6 } };

function input(overrides: Partial<ViewSectionResolveInput['plane']> & {
  buildingRotation?: number;
  uiRange?: { min: number; max: number } | null;
} = {}): ViewSectionResolveInput {
  const { buildingRotation, uiRange, ...plane } = overrides;
  return {
    plane: { axis: 'down', position: 50, flipped: false, ...plane },
    sceneBounds: SCENE_BOUNDS,
    buildingRotation,
    uiRange: uiRange ?? null,
  };
}

/** The WGSL predicate, restated: true when the fragment SURVIVES. */
function shaderKeeps(
  p: { x: number; y: number; z: number },
  normal: readonly [number, number, number],
  distance: number,
  flipped: boolean,
): boolean {
  const side = flipped ? -1 : 1;
  const distToPlane = (p.x * normal[0] + p.y * normal[1] + p.z * normal[2] - distance) * side;
  return !(distToPlane > 0);
}

/** `clipMeshToHalfSpace`'s predicate: keep `dot(p, normal) <= offset`. */
function clipKeeps(
  p: { x: number; y: number; z: number },
  half: { normal: { x: number; y: number; z: number }; offset: number },
): boolean {
  return p.x * half.normal.x + p.y * half.normal.y + p.z * half.normal.z <= half.offset;
}

/** A spread of points across and well outside the scene box. */
function samplePoints(): { x: number; y: number; z: number }[] {
  const points: { x: number; y: number; z: number }[] = [];
  for (const x of [-3, 0, 2.5, 5, 7.5, 10, 13]) {
    for (const y of [-3, 0, 2, 4, 6, 8, 11]) {
      for (const z of [-2, 0, 3, 6, 9]) points.push({ x, y, z });
    }
  }
  return points;
}

describe('resolveKeptHalfSpace (#2042)', () => {
  it('keeps a horizontal cut BELOW the plane when unflipped', () => {
    // 'down' -> world Y; 50% of [0, 8] is Y = 4.
    const half = resolveKeptHalfSpace(input({ axis: 'down', position: 50 }));
    assert.deepEqual(half.normal, { x: 0, y: 1, z: 0 });
    assert.equal(half.offset, 4);
    assert.equal(clipKeeps({ x: 5, y: 3.9, z: 3 }, half), true, 'below the cut survives');
    assert.equal(clipKeeps({ x: 5, y: 4.1, z: 3 }, half), false, 'above the cut is removed');
  });

  it('keeps the OPPOSITE half when flipped, by negating the plane', () => {
    const half = resolveKeptHalfSpace(input({ axis: 'down', position: 50, flipped: true }));
    // -n / -d is the only way `dot(p,n) >= d` can be said in the clip's one form.
    assert.deepEqual(half.normal, { x: -0, y: -1, z: -0 });
    assert.equal(half.offset, -4);
    assert.equal(clipKeeps({ x: 5, y: 4.1, z: 3 }, half), true, 'above the cut survives when flipped');
    assert.equal(clipKeeps({ x: 5, y: 3.9, z: 3 }, half), false, 'below the cut is removed when flipped');
  });

  it('agrees with the shader predicate point for point, on every axis and both flips', () => {
    const points = samplePoints();
    for (const axis of ['down', 'front', 'side'] as const) {
      for (const flipped of [false, true]) {
        for (const position of [0, 25, 50, 100]) {
          const request = input({ axis, position, flipped });
          const half = resolveKeptHalfSpace(request);
          // The unflipped resolution IS the shader's (normal, distance) pair;
          // recover it from the returned half so the comparison cannot cheat.
          const unflipped = resolveKeptHalfSpace({ ...request, plane: { ...request.plane, flipped: false } });
          const normal: [number, number, number] = [
            unflipped.normal.x, unflipped.normal.y, unflipped.normal.z,
          ];
          for (const p of points) {
            assert.equal(
              clipKeeps(p, half),
              shaderKeeps(p, normal, unflipped.offset, flipped),
              `disagreed at ${JSON.stringify(p)} for axis=${axis} flipped=${flipped} position=${position}`,
            );
          }
        }
      }
    }
  });

  it('maps each cardinal axis to the axis the shader preset uses', () => {
    assert.deepEqual(resolveKeptHalfSpace(input({ axis: 'side', position: 0 })).normal, { x: 1, y: 0, z: 0 });
    assert.deepEqual(resolveKeptHalfSpace(input({ axis: 'down', position: 0 })).normal, { x: 0, y: 1, z: 0 });
    assert.deepEqual(resolveKeptHalfSpace(input({ axis: 'front', position: 0 })).normal, { x: 0, y: 0, z: 1 });
  });

  it('interpolates the plane across the range measured along the CUTTING normal', () => {
    // 'side' -> X over [0, 10]; 25% is X = 2.5, 100% is X = 10.
    assert.equal(resolveKeptHalfSpace(input({ axis: 'side', position: 25 })).offset, 2.5);
    assert.equal(resolveKeptHalfSpace(input({ axis: 'side', position: 100 })).offset, 10);
  });

  it('rotates the cardinal normal by the building rotation about world Y', () => {
    const half = resolveKeptHalfSpace(input({ axis: 'side', position: 0, buildingRotation: Math.PI / 2 }));
    // +X rotated 90 degrees about Y becomes +Z (x' = -z*sin, z' = x*sin).
    assert.ok(Math.abs(half.normal.x) < 1e-12, `expected x ~ 0, got ${half.normal.x}`);
    assert.equal(half.normal.y, 0);
    assert.ok(Math.abs(half.normal.z - 1) < 1e-12, `expected z ~ 1, got ${half.normal.z}`);
    // The range now spans Z (0..6), not X (0..10), which is the whole point of
    // measuring along the cutting normal rather than the cardinal axis (#2447).
    assert.ok(Math.abs(half.offset - 0) < 1e-12);
    const mid = resolveKeptHalfSpace(input({ axis: 'side', position: 50, buildingRotation: Math.PI / 2 }));
    assert.ok(Math.abs(mid.offset - 3) < 1e-12, `expected 3 (half of the Z extent), got ${mid.offset}`);
  });

  it('honours the UI slider range only while the normal is still that unit axis', () => {
    // Inside the scene range and untilted: honoured, so 50% of [2, 6] is 4.
    const honoured = resolveKeptHalfSpace(input({ axis: 'down', position: 50, uiRange: { min: 2, max: 6 } }));
    assert.equal(honoured.offset, 4);
    // A range wider than the scene bounds cannot be a storey scope; ignored.
    const ignored = resolveKeptHalfSpace(input({ axis: 'down', position: 50, uiRange: { min: -100, max: 100 } }));
    assert.equal(ignored.offset, 4, 'falls back to 50% of the scene Y extent, which is also 4');
    const ignoredLow = resolveKeptHalfSpace(input({ axis: 'down', position: 25, uiRange: { min: -100, max: 100 } }));
    assert.equal(ignoredLow.offset, 2, '25% of [0,8], not of [-100,100]');
  });

  it('uses a face-picked plane verbatim, renormalised', () => {
    const half = resolveKeptHalfSpace(
      input({ custom: { normal: [0, 0, 3], distance: 9 } }),
    );
    // A non-unit normal must scale the distance with it, or the cut slides.
    assert.deepEqual(half.normal, { x: 0, y: 0, z: 1 });
    assert.equal(half.offset, 3);
  });

  it('falls back to world +Y for a finite face-picked normal that cannot be normalised', () => {
    // Both the zero vector and a magnitude whose SQUARE overflows (#2442) pass
    // the per-component finiteness check, so they reach the renormalisation and
    // take its documented world-+Y fallback with the distance kept.
    for (const normal of [[0, 0, 0], [1e200, 1e200, 1e200]] as const) {
      const half = resolveKeptHalfSpace(input({ custom: { normal: [...normal], distance: 7 } }));
      assert.deepEqual(half.normal, { x: 0, y: 1, z: 0 }, `normal ${normal} must take the fallback`);
      assert.equal(half.offset, 7);
    }
  });

  it('degrades a NON-FINITE face-picked plane to the cardinal preset, as the renderer does', () => {
    // A malformed IfcDirection tokenizes to `inf`; the renderer rejects the
    // explicit plane outright rather than renormalising it, and falls through
    // to the axis + slider preset — which is always a usable plane.
    const half = resolveKeptHalfSpace(
      input({ axis: 'down', position: 50, custom: { normal: [Number.POSITIVE_INFINITY, 0, 0], distance: 7 } }),
    );
    assert.deepEqual(half.normal, { x: 0, y: 1, z: 0 });
    assert.equal(half.offset, 4, 'the preset wins: 50% of the scene Y extent, not the rejected distance');
  });

  it('applies the flip to a face-picked plane too', () => {
    const half = resolveKeptHalfSpace(
      input({ flipped: true, custom: { normal: [0, 0, 1], distance: 3 } }),
    );
    assert.equal(clipKeeps({ x: 0, y: 0, z: 4 }, half), true);
    assert.equal(clipKeeps({ x: 0, y: 0, z: 2 }, half), false);
  });
});
