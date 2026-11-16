/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Curves and profiles in their own 2D coordinates: point lists, polylines, indexed poly curves (arcs traced), profile outlines. */

import { arcPoints, type Pt2 } from './arc.js';
import { applyFrame, axisPlacementFrame } from './placement.js';
import { asNumber, asRef, asRefList, type ModelReader } from './reader.js';

function pointList(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCCARTESIANPOINTLIST2D' || e.type === 'IFCCARTESIANPOINTLIST3D') {
    const list = e.attributes[0];
    if (!Array.isArray(list)) return null;
    const out: Pt2[] = [];
    for (const row of list) {
      if (!Array.isArray(row)) return null;
      const x = asNumber(row[0]);
      const y = asNumber(row[1]);
      if (x === null || y === null) return null;
      out.push([x, y]);
    }
    return out;
  }
  return null;
}

/** Points of a planar bounded curve in its own coordinates; null when it cannot be read. */
/** Per-item primitive (one curve: points, or null when that item cannot be read); production callers use the readers below. */
export function curvePoints(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCPOLYLINE') {
    const out: Pt2[] = [];
    for (const pid of asRefList(e.attributes[0])) {
      const p = reader.entity(pid);
      const c = p && Array.isArray(p.attributes[0]) ? p.attributes[0].map(asNumber) : null;
      if (!c || c[0] === null || c[1] === null) return null;
      out.push([c[0] as number, c[1] as number]);
    }
    return out.length >= 2 ? out : null;
  }
  if (e.type === 'IFCINDEXEDPOLYCURVE') {
    const pts = pointList(reader, asRef(e.attributes[0]));
    if (!pts || pts.length < 2) return null;
    const segments = e.attributes[1];
    if (segments === null || segments === undefined) return pts; // no Segments: the points in list order
    // Segments name the points of the curve and their order (1-based; a line, or an arc through three points, traced along
    // its length so that its extent holds in any frame, see arcPoints). A point the segments omit is not on the curve, and a malformed segment makes the whole outline unreadable.
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const out: Pt2[] = [];
    let last = -1;
    for (const seg of segments) {
      const indices = Array.isArray(seg) && typeof seg[0] === 'string' && Array.isArray(seg[1]) ? seg[1] : null;
      if (!indices || indices.length < 2) return null;
      if (indices.some((i) => typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i > pts.length)) return null;
      const arc = seg[0] === 'IFCARCINDEX';
      if (arc && indices.length !== 3) return null;
      if (last !== indices[0]) out.push(pts[indices[0] - 1]);
      const rest = arc ? arcPoints(pts[indices[0] - 1], pts[indices[1] - 1], pts[indices[2] - 1]) : indices.slice(1).map((i: number) => pts[i - 1]);
      if (!rest) return null; // an arc that cannot be traced makes the outline unreadable
      for (const p of rest) {
        const prev = out[out.length - 1];
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
      }
      last = indices[indices.length - 1];
    }
    return out.length >= 2 ? out : null;
  }
  return null;
}

/** Outer boundary of a profile definition, in the profile's own 2D coordinates. */
export function profilePoints(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCARBITRARYCLOSEDPROFILEDEF' || e.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
    return curvePoints(reader, asRef(reader.attr(e, 'OuterCurve')));
  }
  if (e.type === 'IFCRECTANGLEPROFILEDEF') {
    const x = asNumber(reader.attr(e, 'XDim'));
    const y = asNumber(reader.attr(e, 'YDim'));
    if (x === null || y === null) return null;
    const frame = axisPlacementFrame(reader, reader.attr(e, 'Position'));
    const corners: Pt2[] = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
    if (!frame) return reader.attr(e, 'Position') == null ? corners : null;
    return corners.map(([cx, cy]) => {
      const p = applyFrame(frame, [cx, cy, 0]);
      return [p[0], p[1]];
    });
  }
  return null;
}
