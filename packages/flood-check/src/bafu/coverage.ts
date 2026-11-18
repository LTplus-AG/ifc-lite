/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the BAFU map has data: Switzerland and Liechtenstein. Outside that
 * perimeter the WMS answers transparent pixels too, which must read as "no
 * data", not as "no runoff". The perimeter is a simplified copy of the
 * national boundary (see `coverage-data.ts` and `scripts/build-coverage.mjs`)
 * known to {@link BAFU_COVERAGE_TOLERANCE} metres, so a point within that
 * distance of it is answered `null` (too close to tell) and treated as
 * outside by the check.
 */

import { closestBoundaryPoint, insideRing } from '../geom.js';
import type { CoverageTest, MapPoint } from '../types.js';
import { BAFU_COVERAGE_RINGS, BAFU_COVERAGE_TOLERANCE } from './coverage-data.js';

export { BAFU_COVERAGE_TOLERANCE };

let decoded: MapPoint[][] | null = null;

function rings(): MapPoint[][] {
  if (decoded) return decoded;
  decoded = BAFU_COVERAGE_RINGS.map((encoded) => {
    const v = encoded.split(',').map(Number);
    const ring: MapPoint[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < v.length; i += 2) {
      x = i === 0 ? v[0] : x + v[i];
      y = i === 0 ? v[1] : y + v[i + 1];
      ring.push({ x, y });
    }
    return ring;
  });
  return decoded;
}

/** `true` inside Switzerland or Liechtenstein, `false` outside, `null` within the tolerance of the border. */
export const bafuCovers: CoverageTest = (p: MapPoint) => {
  const all = rings();
  const nearest = closestBoundaryPoint(p, all);
  if (!nearest || nearest.distance <= BAFU_COVERAGE_TOLERANCE) return null;
  let inside = false;
  for (const ring of all) if (insideRing(p, ring)) inside = !inside;
  return inside;
};
