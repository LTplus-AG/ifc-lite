/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { insideAreaOfUse } from './area.js';

describe('insideAreaOfUse', () => {
  const swiss = { west: 5.96, south: 45.82, east: 10.49, north: 47.81 };
  it('an ordinary area: inside, and outside beyond the margin', () => {
    expect(insideAreaOfUse(swiss, 46.95, 7.44)).toBe(true);
    expect(insideAreaOfUse(swiss, 46.95, 12)).toBe(false);
    expect(insideAreaOfUse(swiss, 50, 7.44)).toBe(false);
  });
  it('an area crossing the antimeridian (west 170, east -170) contains both sides and not the far side', () => {
    const fiji = { west: 170, south: -20, east: -170, north: -10 };
    expect(insideAreaOfUse(fiji, -17.7, 179)).toBe(true);
    expect(insideAreaOfUse(fiji, -17.7, -179)).toBe(true);
    expect(insideAreaOfUse(fiji, -17.7, 0)).toBe(false);
    expect(insideAreaOfUse(fiji, -17.7, 160)).toBe(false);
    expect(insideAreaOfUse(fiji, 40, 179)).toBe(false);
  });
});
