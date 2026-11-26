/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonArea } from '../index.js';

const L_SHAPE: ReadonlyArray<readonly [number, number]> = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];

describe('package polygon helpers (#10964)', () => {
  it('measures the shoelace area of a ring in either winding', () => {
    expect(polygonArea(L_SHAPE)).toBe(6);
    expect(polygonArea([...L_SHAPE].reverse())).toBe(6);
    expect(polygonArea([[0, 0], [1, 0]])).toBe(0);
  });

  it('tests containment against a concave ring with a ray cast', () => {
    expect(pointInPolygon(0.5, 2, L_SHAPE)).toBe(true);
    expect(pointInPolygon(3, 0.5, L_SHAPE)).toBe(true);
    expect(pointInPolygon(2, 2, L_SHAPE)).toBe(false);
    expect(pointInPolygon(5, 0.5, L_SHAPE)).toBe(false);
    expect(pointInPolygon(0.5, 0.5, [[0, 0], [1, 1]])).toBe(false);
  });
});
