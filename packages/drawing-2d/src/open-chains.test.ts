/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The graph rules that decide which cut segments bound no area (#8664). */

import { describe, it, expect } from 'vitest';
import { findOpenChainSegments } from './open-chains.js';
import type { CutSegment } from './types.js';

type XY = [number, number];
const TOLERANCE = 1e-4;

const seg = ([ax, ay]: XY, [bx, by]: XY): CutSegment => ({
  p0: { x: ax, y: 0, z: ay },
  p1: { x: bx, y: 0, z: by },
  p0_2d: { x: ax, y: ay },
  p1_2d: { x: bx, y: by },
  entityId: 1,
  ifcType: 'IfcBuildingElementProxy',
  modelIndex: 0,
});

/** Segments joining consecutive points; closes back to the first when asked. */
const path = (points: XY[], closed = false): CutSegment[] =>
  points.slice(0, closed ? undefined : -1).map((p, i) => seg(p, points[(i + 1) % points.length]));

const open = (segments: CutSegment[]) => findOpenChainSegments(segments, TOLERANCE);
const SQUARE: XY[] = [[0, 0], [2, 0], [2, 2], [0, 2]];

describe('findOpenChainSegments', () => {
  it('leaves a closed loop alone and takes a whole open path', () => {
    expect(open(path(SQUARE, true)).size).toBe(0);
    const sheet = path([[0, 0], [2, 1], [4, 0]]);
    expect(open(sheet)).toEqual(new Set(sheet));
  });

  it('prunes a fin back to its junction, wherever it joins', () => {
    const fin = path([[2, 0], [3, 0], [4, 1]]);
    expect(open([...fin, ...path(SQUARE, true)])).toEqual(new Set(fin));
  });

  describe('duplicate segments', () => {
    it('keeps a loop with a doubled edge closed', () => {
      expect(open([...path(SQUARE, true), seg(SQUARE[1], SQUARE[0])]).size).toBe(0);
    });

    it('takes both copies of a line folded back on itself', () => {
      const fold = [seg([0, 0], [2, 0]), seg([2, 0], [0, 0])];
      expect(open(fold)).toEqual(new Set(fold));
    });

    it('takes a duplicate of a dangling edge with it', () => {
      const fin = path([[2, 0], [3, 0]]);
      const copy = seg([3, 0], [2, 0]);
      expect(open([...path(SQUARE, true), ...fin, copy])).toEqual(new Set([...fin, copy]));
    });
  });

  describe('cracks', () => {
    const cracked = (gap: number): CutSegment[] =>
      path([[1 + gap, 0], [2, 0], [2, 2], [0, 2], [0, 0], [1, 0]]);

    it('bridges one within both limits', () => {
      expect(open(cracked(0.005)).size).toBe(0);
    });

    it('does not bridge past the absolute limit, however small beside the length', () => {
      const long: XY[] = [[0, 0], [100, 0], [100, 1], [0.011, 1], [0.011, 0.1]];
      expect(open(path(long)).size).toBe(4);
      expect(open(cracked(0.011)).size).toBe(5);
    });

    it('does not bridge past the relative limit, however small absolutely', () => {
      const tiny = path([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0.005]]);
      expect(open(tiny)).toEqual(new Set(tiny));
    });

    it('does not read a lone short segment as closed across itself', () => {
      const short = [seg([0, 0], [0.005, 0])];
      expect(open(short)).toEqual(new Set(short));
    });

    it('closes across several', () => {
      const pieces = [
        ...path([[0.001, 0], [1.999, 0]]),
        ...path([[2, 0.001], [2, 1.999]]),
        ...path([[1.999, 2], [0.001, 2]]),
        ...path([[0, 1.999], [0, 0.001]]),
      ];
      expect(open(pieces).size).toBe(0);
    });

    it('stays bridged when a sheet ends nearer to one side than the other side is', () => {
      const sheet = path([[1.0005, -0.0005], [1.0005, -1]]);
      const solid = path([[1.0017, 0], [2, 0], [2, 2], [0, 2], [0, 0], [1, 0]]);
      for (const segments of [[...solid, ...sheet], [...sheet, ...solid]]) {
        expect(open(segments)).toEqual(new Set(sheet));
      }
    });
  });

  it('does not split a vertex on a weld-cell boundary, even with a fin on it', () => {
    const noise = 1e-9;
    const onBoundary = 2.00005;
    const solid = [
      seg([0, 0], [onBoundary - noise, 0]),
      seg([onBoundary + noise, 0], [onBoundary, 2]),
      seg([onBoundary, 2], [0, 2]),
      seg([0, 2], [0, 0]),
    ];
    const fin = seg([onBoundary + noise, 0], [3, 0]);
    expect(open([...solid, fin])).toEqual(new Set([fin]));
  });
});
