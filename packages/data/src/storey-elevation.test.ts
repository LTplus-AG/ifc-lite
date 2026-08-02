/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contract tests for the shared storey-elevation resolver (issue #1841).
 *
 * `getStoreyByElevation` was implemented twice: the parser applied a 1m
 * tolerance and returned null beyond it, while the viewer's server-loaded path
 * always snapped to the nearest storey. Same model, same Z, different answer.
 * Both now call `findStoreyByElevation`, so these tests pin the one behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  findStoreyByElevation,
  STOREY_ELEVATION_MATCH_TOLERANCE_M,
  IFC_BUILDING_STOREY_ELEVATION_INDEX,
  IFC_BUILDING_STOREY_PLACEMENT_INDEX,
} from './storey-elevation.js';

/** storeyId -> elevation in metres. */
const storeys = new Map<number, number>([
  [10, 0],
  [20, 3],
  [30, 6.5],
]);

describe('findStoreyByElevation', () => {
  it('returns the storey at an exact elevation', () => {
    expect(findStoreyByElevation(storeys, 3)).toBe(20);
  });

  it('returns the nearest storey within the tolerance', () => {
    expect(findStoreyByElevation(storeys, 3.4)).toBe(20);
    expect(findStoreyByElevation(storeys, 6.1)).toBe(30);
  });

  it('returns null beyond the tolerance instead of snapping to the nearest', () => {
    // 40m up is above every storey. Snapping it to the roof silently corrupts
    // storey grouping — this is exactly what the viewer path used to do.
    expect(findStoreyByElevation(storeys, 40)).toBeNull();
    expect(findStoreyByElevation(storeys, -25)).toBeNull();
  });

  it('treats the tolerance as exclusive at the boundary', () => {
    const justInside = 3 + STOREY_ELEVATION_MATCH_TOLERANCE_M - 1e-9;
    const atBoundary = 3 + STOREY_ELEVATION_MATCH_TOLERANCE_M;
    expect(findStoreyByElevation(storeys, justInside)).toBe(20);
    expect(findStoreyByElevation(storeys, atBoundary)).toBeNull();
  });

  it('picks the closer of two candidates that are both in range', () => {
    // Both within 1m of z=0.8, so this rejects a resolver that returns the
    // first eligible storey rather than the nearest one.
    const nearby = new Map<number, number>([
      [10, 0],
      [20, 1.5],
    ]);
    expect(findStoreyByElevation(nearby, 0.8)).toBe(20);
    expect(findStoreyByElevation(nearby, 0.7)).toBe(10);
  });

  it('returns null for an empty set (the cache-restore path)', () => {
    expect(findStoreyByElevation(new Map(), 0)).toBeNull();
    expect(findStoreyByElevation([], 0)).toBeNull();
  });

  it('accepts any iterable of [storeyId, elevation] pairs', () => {
    expect(
      findStoreyByElevation(
        [
          [1, 100],
          [2, 200],
        ],
        200.5
      )
    ).toBe(2);
  });

  it('handles a negative elevation (basement)', () => {
    expect(findStoreyByElevation(new Map([[5, -3.5]]), -3.2)).toBe(5);
  });

  it('breaks an exact-distance tie by lower storeyId, not iteration order', () => {
    // z=0.5 sits exactly between storeys at 0 and 1 (both 0.5m away, both inside
    // the 1m band). The answer must not depend on which order the pairs are
    // iterated, or the parser and server paths could still disagree despite
    // sharing this fn.
    const forward: Array<[number, number]> = [
      [10, 0],
      [20, 1],
    ];
    const reversed: Array<[number, number]> = [
      [20, 1],
      [10, 0],
    ];
    expect(findStoreyByElevation(forward, 0.5)).toBe(10);
    expect(findStoreyByElevation(reversed, 0.5)).toBe(10);
  });
});

describe('IfcBuildingStorey attribute indices', () => {
  /**
   * These pin the slots the server's `extract_elevation_if_storey` (Rust) reads.
   * Reading slot 8 (CompositionType) or 7 (LongName) yields no number, so an
   * off-by-one is silent: elevation becomes 0 in the UI rather than failing.
   */
  it('places Elevation at 9 and ObjectPlacement at 5', () => {
    expect(IFC_BUILDING_STOREY_ELEVATION_INDEX).toBe(9);
    expect(IFC_BUILDING_STOREY_PLACEMENT_INDEX).toBe(5);
  });
});
