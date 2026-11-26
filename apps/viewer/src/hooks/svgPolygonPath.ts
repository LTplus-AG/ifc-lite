/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Path data (`d`) for a cut polygon in the two SVG exports (direct and sheet).
 *
 * `Number.prototype.toFixed` prints `NaN` and `Infinity` verbatim, and a path
 * containing either is an error in a strict SVG consumer (the whole `<path>`
 * is dropped or the file is rejected). A ring with any non-finite vertex is
 * therefore left out: a bad hole is skipped and the wall stays filled, a bad
 * outer ring drops the polygon (empty string; callers skip empty paths). The
 * PDF export treats the same input the same way (`prepareCutPolygonsPdf`).
 */

type Pt = { x: number; y: number };

/** `M x y L ... Z` for one ring, or '' when it is empty or has a non-finite vertex. */
function ringToPath(ring: readonly Pt[], map: (x: number, y: number) => Pt): string {
  if (ring.length === 0) return '';
  let path = '';
  for (let i = 0; i < ring.length; i++) {
    const p = map(ring[i].x, ring[i].y);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return '';
    path += `${i === 0 ? 'M' : ' L'} ${p.x.toFixed(4)} ${p.y.toFixed(4)}`;
  }
  return `${path} Z`;
}

export function polygonPathData(
  polygon: { outer: readonly Pt[]; holes: readonly (readonly Pt[])[] },
  map: (x: number, y: number) => Pt,
): string {
  const outer = ringToPath(polygon.outer, map);
  // Holes without a usable outer ring would fill the hole region by itself.
  if (!outer) return '';
  let path = outer;
  for (const hole of polygon.holes) {
    const ring = ringToPath(hole, map);
    if (ring) path += `${path ? ' ' : ''}${ring}`;
  }
  return path;
}
