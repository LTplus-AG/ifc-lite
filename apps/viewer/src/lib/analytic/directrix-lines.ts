/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { directrixPointEvaluator } from './directrix-point';

type Segment = SweptDiskDescriptions['elements'][string][number]['Directrix'][number];

/** Render-only approximation. Measurements and snapping use the exact source curve. */
export function directrixLineVertices(
  segments: readonly Segment[],
  maxEdges = 100_000,
): number[] {
  const vertices: number[] = [];
  let edges = 0;
  const append = (a: readonly number[], b: readonly number[]) => {
    if (++edges > maxEdges) throw new RangeError('selected directrix exceeds display edge budget');
    if (![...a, ...b].every(Number.isFinite)) throw new RangeError('selected directrix has non-finite coordinates');
    vertices.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };
  for (const segment of segments) {
    if (segment.type === 'line') {
      append(segment.start, segment.end);
      continue;
    }
    const { radius, start_angle: start, sweep_angle: sweep } = segment;
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(start) || !Number.isFinite(sweep)) {
      throw new RangeError('selected arc has invalid radius or parameter');
    }
    // Bound the chord error to 0.5 mm where practical, with a 15-degree
    // ceiling for small circles and an explicit limit for hostile files.
    const sagitta = Math.min(0.0005 / radius, 1);
    const step = Math.min(Math.PI / 12, 2 * Math.acos(1 - sagitta));
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    if (!Number.isFinite(count) || count > 4096) {
      throw new RangeError('selected arc exceeds display precision budget');
    }
    if (edges + count > maxEdges) throw new RangeError('selected directrix exceeds display edge budget');
    const pointAt = directrixPointEvaluator(segment);
    let previous = pointAt(0);
    for (let index = 1; index <= count; index++) {
      const next = pointAt(index / count);
      append(previous, next);
      previous = next;
    }
  }
  return vertices;
}
