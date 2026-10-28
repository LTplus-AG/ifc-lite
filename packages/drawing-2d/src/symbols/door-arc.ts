/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Arc and frame helpers for the door symbol generator. */

import type { Point2D, Line2D } from '../types.js';

/** Unit vector, or null for a degenerate (near-zero) one. */
export function unit(v: Point2D): Point2D | null {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? null : { x: v.x / l, y: v.y / l };
}

/** +1 when `swing` is `wall` rotated counter-clockwise (the right-handed frame), -1 when clockwise (mirrored). */
export function handedness(wall: Point2D, swing: Point2D): 1 | -1 {
  return wall.x * swing.y - wall.y * swing.x < 0 ? -1 : 1;
}

/**
 * Generate arc as line segments
 */
export function generateArc(
  segments: number,
  center: Point2D,
  radius: number,
  swingDir: Point2D,
  direction: 1 | -1,
  angleRad: number
): Line2D[] {
  const lines: Line2D[] = [];

  // The arc must terminate at the leaf's open-position tip (center + swingDir * radius) —
  // that point is the door's free edge, and the leaf line is drawn from the same swingDir.
  // Sweep backward from there by angleRad (in the same rotational sense as `direction`) to
  // find the closed-position start angle, which lands along the wall as expected.
  const swingAngle = Math.atan2(swingDir.y, swingDir.x);
  const startAngle = swingAngle - direction * angleRad;

  for (let i = 0; i < segments; i++) {
    const t1 = i / segments;
    const t2 = (i + 1) / segments;
    const angle1 = startAngle + direction * t1 * angleRad;
    const angle2 = startAngle + direction * t2 * angleRad;

    lines.push({
      start: {
        x: center.x + Math.cos(angle1) * radius,
        y: center.y + Math.sin(angle1) * radius,
      },
      end: {
        x: center.x + Math.cos(angle2) * radius,
        y: center.y + Math.sin(angle2) * radius,
      },
    });
  }

  return lines;
}

/**
 * Generate SVG arc path string
 */
export function arcSvgPath(
  center: Point2D,
  radius: number,
  swingDir: Point2D,
  direction: 1 | -1,
  angleRad: number
): string {
  // Same convention as generateArc: the arc must end at the leaf's open tip
  // (center + swingDir * radius), swept back by angleRad in `direction`'s sense.
  const endAngle = Math.atan2(swingDir.y, swingDir.x);
  const startAngle = endAngle - direction * angleRad;

  const startX = center.x + Math.cos(startAngle) * radius;
  const startY = center.y + Math.sin(startAngle) * radius;
  const endX = center.x + Math.cos(endAngle) * radius;
  const endY = center.y + Math.sin(endAngle) * radius;

  const largeArc = angleRad > Math.PI ? 1 : 0;
  const sweep = direction > 0 ? 1 : 0;

  return `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${endX} ${endY}`;
}
