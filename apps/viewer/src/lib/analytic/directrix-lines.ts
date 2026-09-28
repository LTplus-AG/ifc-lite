/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SweptDiskDescriptions } from '@ifc-lite/geometry';

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
    const { center, normal, x_axis, radius, start_angle: start, sweep_angle: sweep } = segment;
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(start) || !Number.isFinite(sweep)) {
      throw new RangeError('selected arc has invalid radius or parameter');
    }
    const yAxis = [
      normal[1] * x_axis[2] - normal[2] * x_axis[1],
      normal[2] * x_axis[0] - normal[0] * x_axis[2],
      normal[0] * x_axis[1] - normal[1] * x_axis[0],
    ];
    // Bound the chord error to 0.5 mm where practical, with a 15-degree
    // ceiling for small circles and an explicit limit for hostile files.
    const sagitta = Math.min(0.0005 / radius, 1);
    const step = Math.min(Math.PI / 12, 2 * Math.acos(1 - sagitta));
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    if (!Number.isFinite(count) || count > 4096) {
      throw new RangeError('selected arc exceeds display precision budget');
    }
    if (edges + count > maxEdges) throw new RangeError('selected directrix exceeds display edge budget');
    const point = (t: number) => {
      const angle = start + sweep * t;
      const c = Math.cos(angle), s = Math.sin(angle);
      return [0, 1, 2].map((axis) => center[axis] + radius * (x_axis[axis] * c + yAxis[axis] * s));
    };
    let previous = point(0);
    for (let index = 1; index <= count; index++) {
      const next = point(index / count);
      append(previous, next);
      previous = next;
    }
  }
  return vertices;
}
