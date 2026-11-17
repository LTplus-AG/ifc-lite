/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The plane and section measures behind `base-quantities.ts`. Metres throughout. */

import type { HostBounds } from './anchor.js';
import type { ProfileSection } from './profile.js';

type Ring = ReadonlyArray<readonly [number, number]>;

/** Shoelace area of a simple closed ring whose last point does not repeat its first. */
export function polygonArea(ring: Ring): number {
  let doubled = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    doubled += ax * by - bx * ay;
  }
  return Math.abs(doubled) / 2;
}

export function polygonPerimeter(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    sum += Math.hypot(bx - ax, by - ay);
  }
  return sum;
}

/** How much of `axis` two boxes share; zero when they do not meet. */
export function axisOverlap(a: HostBounds, b: HostBounds, axis: 0 | 1 | 2): number {
  return Math.max(0, Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]));
}

/** Keep the part of `ring` on one side of a vertical or horizontal line (one Sutherland-Hodgman pass). */
function clipToLine(ring: Array<[number, number]>, axis: 0 | 1, limit: number, keepBelow: boolean): Array<[number, number]> {
  const inside = (point: readonly [number, number]) => (keepBelow ? point[axis] <= limit : point[axis] >= limit);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) {
      const t = (limit - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * The area of `ring` inside `box`'s plan. Clipping a concave ring this way can
 * leave bridging edges along the box, but they enclose nothing, so the area holds.
 */
export function clippedPolygonArea(ring: Ring, box: HostBounds): number {
  let clipped = ring.map(([x, y]) => [x, y] as [number, number]);
  clipped = clipToLine(clipped, 0, box.min[0], false);
  clipped = clipToLine(clipped, 0, box.max[0], true);
  clipped = clipToLine(clipped, 1, box.min[1], false);
  clipped = clipToLine(clipped, 1, box.max[1], true);
  return clipped.length < 3 ? 0 : polygonArea(clipped);
}

/**
 * A section's area and outer perimeter, nominal: fillet radii are not modelled,
 * as is usual for a catalogue quantity. A hollow section's inner face is not on
 * its perimeter, because `OuterSurfaceArea` is the surface outside.
 */
export function sectionMeasures(
  section: ProfileSection | null,
  rectangleWidth: number,
  rectangleHeight: number,
): { area: number; perimeter: number } | null {
  if (section === null) {
    return { area: rectangleWidth * rectangleHeight, perimeter: 2 * (rectangleWidth + rectangleHeight) };
  }
  switch (section.Type) {
    case 'Rectangle':
      return { area: section.XDim * section.YDim, perimeter: 2 * (section.XDim + section.YDim) };
    case 'I': {
      const { OverallWidth: b, OverallDepth: d, WebThickness: tw, FlangeThickness: tf } = section;
      return { area: 2 * b * tf + (d - 2 * tf) * tw, perimeter: 4 * b + 2 * d - 2 * tw };
    }
    case 'L': {
      const { Depth: d, Width: w, Thickness: t } = section;
      return { area: (d + w - t) * t, perimeter: 2 * (d + w) };
    }
    case 'T': {
      const { Depth: d, FlangeWidth: b, WebThickness: tw, FlangeThickness: tf } = section;
      return { area: b * tf + (d - tf) * tw, perimeter: 2 * (b + d) };
    }
    case 'U': {
      const { Depth: d, FlangeWidth: b, WebThickness: tw, FlangeThickness: tf } = section;
      return { area: 2 * b * tf + (d - 2 * tf) * tw, perimeter: 4 * b + 2 * d - 2 * tw };
    }
    case 'C': {
      const { Depth: d, Width: w, WallThickness: t, Girth: g } = section;
      return { area: t * (d + 2 * w + 2 * g - 4 * t), perimeter: 2 * d + 4 * w + 4 * g - 6 * t };
    }
    case 'Circle':
      return { area: Math.PI * section.Radius ** 2, perimeter: 2 * Math.PI * section.Radius };
    case 'RectangleHollow': {
      const { XDim: x, YDim: y, WallThickness: t } = section;
      return { area: x * y - (x - 2 * t) * (y - 2 * t), perimeter: 2 * (x + y) };
    }
    case 'CircleHollow': {
      const { Radius: r, WallThickness: t } = section;
      return { area: Math.PI * (r ** 2 - (r - t) ** 2), perimeter: 2 * Math.PI * r };
    }
    default:
      return null;
  }
}
