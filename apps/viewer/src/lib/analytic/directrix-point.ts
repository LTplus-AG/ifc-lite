/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SweptDiskDescriptions } from '@ifc-lite/geometry';

type DirectrixSegment = SweptDiskDescriptions['elements'][string][number]['Directrix'][number];

/** Build one f64 evaluator for an authored IFC line or signed arc. */
export function directrixPointEvaluator(segment: DirectrixSegment): (t: number) => [number, number, number] {
  if (segment.type === 'line') {
    const { start, end } = segment;
    return (t) => [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
      start[2] + (end[2] - start[2]) * t,
    ];
  }
  const { center, normal, x_axis, radius, start_angle, sweep_angle } = segment;
  const yAxis = [
    normal[1] * x_axis[2] - normal[2] * x_axis[1],
    normal[2] * x_axis[0] - normal[0] * x_axis[2],
    normal[0] * x_axis[1] - normal[1] * x_axis[0],
  ];
  return (t) => {
    const angle = start_angle + sweep_angle * t;
    const c = Math.cos(angle), s = Math.sin(angle);
    return [
      center[0] + radius * (x_axis[0] * c + yAxis[0] * s),
      center[1] + radius * (x_axis[1] * c + yAxis[1] * s),
      center[2] + radius * (x_axis[2] * c + yAxis[2] * s),
    ];
  };
}
