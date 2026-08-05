/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `math.ts` had no test file. Everything the 2D drawing pipeline puts on
 * paper goes through the plane/projection/polygon helpers below, so a wrong
 * answer here is silent: the SVG/PDF/DXF still renders, just mirrored,
 * rotated, or with inverted hole winding.
 *
 * The projection cases (`getProjectionAxes` / `projectTo2D`) were only ever
 * pinned from `apps/viewer/src/hooks/scanSectionMath.test.ts`, i.e. from a
 * consumer two packages downstream — publishing `@ifc-lite/drawing-2d` on
 * its own carried no check at all. `getAxisNormal`'s `flipped: true` branch
 * had no in-repo caller (every call site passes `false` literally) and no
 * test anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsEmpty,
  boundsValid,
  ensureCCW,
  ensureCW,
  getAxisNormal,
  getProjectionAxes,
  isCounterClockwise,
  polygonSignedArea,
  projectPointOnLine,
  projectTo2D,
} from './math.js';
import type { Point2D } from './types.js';

describe('getProjectionAxes', () => {
  // The Rust `projection_outline::project` mirrors this mapping (see the
  // JSDoc on getProjectionAxes); swapping u/v here silently transposes
  // every elevation and plan.
  it('maps each section axis to a distinct, ordered in-plane pair', () => {
    expect(getProjectionAxes('x')).toEqual({ u: 'z', v: 'y' });
    expect(getProjectionAxes('y')).toEqual({ u: 'x', v: 'z' });
    expect(getProjectionAxes('z')).toEqual({ u: 'x', v: 'y' });
  });

  it('never maps the section axis onto itself', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const { u, v } = getProjectionAxes(axis);
      expect(u).not.toBe(axis);
      expect(v).not.toBe(axis);
      expect(u).not.toBe(v);
    }
  });
});

describe('projectTo2D', () => {
  const p = { x: 2, y: 3, z: 5 };

  it('takes (u, v) from getProjectionAxes for every axis, unflipped', () => {
    expect(projectTo2D(p, 'x', false)).toEqual({ x: 5, y: 3 }); // (z, y)
    expect(projectTo2D(p, 'y', false)).toEqual({ x: 2, y: 5 }); // (x, z)
    expect(projectTo2D(p, 'z', false)).toEqual({ x: 2, y: 3 }); // (x, y)
  });

  it('mirrors ONLY the U axis when the section is flipped', () => {
    // The V component must be untouched — the drawing is mirrored
    // left-to-right, never turned upside down.
    for (const axis of ['x', 'y', 'z'] as const) {
      const straight = projectTo2D(p, axis, false);
      const flipped = projectTo2D(p, axis, true);
      expect(flipped.x).toBe(-straight.x);
      expect(flipped.y).toBe(straight.y);
    }
  });

  it('is not the identity in the flipped case (a non-zero U is required to show it)', () => {
    // Guards the fixture itself: a point on the U=0 line would make the
    // flip unobservable and the assertion above vacuous.
    expect(projectTo2D(p, 'z', false).x).not.toBe(0);
  });
});

describe('getAxisNormal', () => {
  it('returns the positive unit axis when not flipped', () => {
    expect(getAxisNormal('x', false)).toEqual({ x: 1, y: 0, z: 0 });
    expect(getAxisNormal('y', false)).toEqual({ x: 0, y: 1, z: 0 });
    expect(getAxisNormal('z', false)).toEqual({ x: 0, y: 0, z: 1 });
  });

  // Every in-repo call site passes `flipped: false` literally, so this
  // branch is reachable only through the published API.
  it('negates the unit axis when flipped', () => {
    expect(getAxisNormal('x', true)).toEqual({ x: -1, y: 0, z: 0 });
    expect(getAxisNormal('y', true)).toEqual({ x: 0, y: -1, z: 0 });
    expect(getAxisNormal('z', true)).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe('projectPointOnLine', () => {
  // t is a NORMALISED parameter (0 at start, 1 at end), not a raw dot
  // product. `line-merger.groupByLine` compares these against a distance
  // tolerance, so an un-normalised t silently scales with line length.
  it('returns 0 at the start and 1 at the end regardless of line length', () => {
    const short = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
    const long = { start: { x: 0, y: 0 }, end: { x: 40, y: 0 } };
    expect(projectPointOnLine({ x: 0, y: 0 }, short)).toBeCloseTo(0, 12);
    expect(projectPointOnLine({ x: 1, y: 0 }, short)).toBeCloseTo(1, 12);
    expect(projectPointOnLine({ x: 0, y: 0 }, long)).toBeCloseTo(0, 12);
    expect(projectPointOnLine({ x: 40, y: 0 }, long)).toBeCloseTo(1, 12);
  });

  it('is invariant to line length for the same fractional position', () => {
    const short = { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } };
    const long = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
    expect(projectPointOnLine({ x: 0.5, y: 7 }, short)).toBeCloseTo(0.25, 12);
    expect(projectPointOnLine({ x: 2.5, y: 7 }, long)).toBeCloseTo(0.25, 12);
  });

  it('extrapolates past the endpoints rather than clamping', () => {
    const line = { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } };
    expect(projectPointOnLine({ x: -2, y: 0 }, line)).toBeCloseTo(-0.5, 12);
    expect(projectPointOnLine({ x: 6, y: 0 }, line)).toBeCloseTo(1.5, 12);
  });

  it('returns 0 for a degenerate (zero-length) line', () => {
    const dot = { start: { x: 3, y: 3 }, end: { x: 3, y: 3 } };
    expect(projectPointOnLine({ x: 9, y: 9 }, dot)).toBe(0);
  });
});

describe('boundsValid', () => {
  it('rejects the empty sentinel produced by boundsEmpty()', () => {
    expect(boundsValid(boundsEmpty())).toBe(false);
  });

  it('accepts a well-ordered finite box, including a degenerate point box', () => {
    expect(boundsValid({ min: { x: 0, y: 0 }, max: { x: 1, y: 1 } })).toBe(true);
    expect(boundsValid({ min: { x: 2, y: 2 }, max: { x: 2, y: 2 } })).toBe(true);
  });

  it('rejects inverted bounds on either axis', () => {
    expect(boundsValid({ min: { x: 1, y: 0 }, max: { x: 0, y: 1 } })).toBe(false);
    expect(boundsValid({ min: { x: 0, y: 1 }, max: { x: 1, y: 0 } })).toBe(false);
  });

  // Ordered-but-infinite bounds pass the min<=max test, so each isFinite
  // guard has to be exercised on its own coordinate.
  it('rejects an infinite extent on any single coordinate', () => {
    const finite = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
    expect(boundsValid({ ...finite, min: { x: -Infinity, y: 0 } })).toBe(false);
    expect(boundsValid({ ...finite, max: { x: Infinity, y: 1 } })).toBe(false);
    expect(boundsValid({ ...finite, min: { x: 0, y: -Infinity } })).toBe(false);
    expect(boundsValid({ ...finite, max: { x: 1, y: Infinity } })).toBe(false);
  });
});

describe('polygon winding', () => {
  // CCW unit square, and its CW reverse.
  const ccw: Point2D[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const cw: Point2D[] = [...ccw].reverse();

  it('reports the true signed area (half the shoelace sum), not twice it', () => {
    expect(polygonSignedArea(ccw)).toBeCloseTo(1, 12);
    expect(polygonSignedArea(cw)).toBeCloseTo(-1, 12);
  });

  it('classifies winding by the sign of the signed area', () => {
    expect(isCounterClockwise(ccw)).toBe(true);
    expect(isCounterClockwise(cw)).toBe(false);
  });

  // polygon-builder uses ensureCCW for outer rings and ensureCW for holes.
  // Swapping the two branches of ensureCW makes every hole wind the same
  // way as its outer ring, which fills the hole in in the SVG.
  it('ensureCCW yields counter-clockwise output from BOTH inputs', () => {
    expect(isCounterClockwise(ensureCCW(ccw))).toBe(true);
    expect(isCounterClockwise(ensureCCW(cw))).toBe(true);
  });

  it('ensureCW yields clockwise output from BOTH inputs', () => {
    expect(isCounterClockwise(ensureCW(ccw))).toBe(false);
    expect(isCounterClockwise(ensureCW(cw))).toBe(false);
  });

  it('ensureCCW and ensureCW disagree on every input', () => {
    for (const poly of [ccw, cw]) {
      expect(isCounterClockwise(ensureCCW(poly))).not.toBe(
        isCounterClockwise(ensureCW(poly)),
      );
    }
  });

  it('leaves the input array untouched', () => {
    const original = [...ccw];
    ensureCW(ccw);
    ensureCCW(ccw);
    expect(ccw).toEqual(original);
  });
});
