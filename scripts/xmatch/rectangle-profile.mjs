/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading a 4-corner rectangle out of an `IfcArbitraryClosedProfileDef`'s
 * curve. Split out of `rectangle-edits.mjs` for the module-size house rule
 * (AGENTS.md); `ownedRectangleExtrusion` there is the only caller.
 */

import { referencesIn, splitArgs } from './step-file.mjs';
import { refAt } from './edits.mjs';

/** Coordinates of a point / direction statement. */
export function coordinates(statement) {
  const inner = statement.args.trim().replace(/^\(/, '').replace(/\)$/, '');
  return splitArgs(inner).map((value) => Number.parseFloat(value));
}

/** Relative tolerance for "these four points are a rectangle". */
const RECTANGLE_EPSILON = 1e-6;

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) <= RECTANGLE_EPSILON && Math.abs(a[1] - b[1]) <= RECTANGLE_EPSILON;
}

/**
 * Read a 4-corner rectangle out of a closed 2D curve — an `IfcPolyline` or an
 * `IfcIndexedPolyCurve` over an `IfcCartesianPointList2D` with straight
 * segments only — as `{ centre, u, v, a, b }`: centre, unit axes along the
 * first two edges, and half-extents. Undefined for anything else.
 *
 * Authoring tools export a wall's rectangle as an arbitrary closed profile
 * far more often than as an `IfcRectangleProfileDef` (rvt01 has 2 of the
 * latter and several hundred of the former), so a fixture that only knew the
 * named profile would have no split population on two of three models.
 */
export function rectangleOfCurve(index, curveId) {
  const curve = index.byId.get(curveId);
  if (!curve) return undefined;
  let points;
  if (curve.type === 'IFCPOLYLINE') {
    points = referencesIn(curve.args).map((id) => coordinates(index.byId.get(id)));
  } else if (curve.type === 'IFCINDEXEDPOLYCURVE') {
    const parts = splitArgs(curve.args);
    const list = index.byId.get(refAt(curve, 0));
    if (list?.type !== 'IFCCARTESIANPOINTLIST2D') return undefined;
    // `((x,y),(x,y),...)`: strip the outer pair, split the tuples, then each.
    const outer = list.args.trim();
    if (!outer.startsWith('(') || !outer.endsWith(')')) return undefined;
    points = splitArgs(outer.slice(1, -1)).map((tuple) =>
      splitArgs(tuple.trim().replace(/^\(/, '').replace(/\)$/, '')).map(Number.parseFloat),
    );
    // Segments: `$` means "straight lines between consecutive points". An
    // explicit list is accepted only when it is exactly that walk spelled out
    // in `IFCLINEINDEX`es — an arc index, or a reordering, is not a rectangle.
    if (parts[1] !== '$') {
      if (/IFCARCINDEX/.test(parts[1])) return undefined;
      const lineIndex = /IFCLINEINDEX\s*\(\s*\(([^()]*)\)\s*\)/g;
      const segments = [...parts[1].matchAll(lineIndex)].map((match) =>
        match[1].split(',').map((value) => {
          const index = value.trim();
          return /^\d+$/.test(index) ? Number.parseInt(index, 10) : Number.NaN;
        }),
      );
      // Reject unsupported segment syntax instead of silently extracting its
      // digits. Parentheses and commas are only the aggregate wrappers around
      // the IfcLineIndex values matched above.
      const residue = parts[1].replace(lineIndex, '').replace(/[(),\s]/g, '');
      if (segments.length === 0 || residue || segments.some((segment) =>
        segment.length < 2 || segment.some((value) => !Number.isInteger(value)))) {
        return undefined;
      }
      const walk = [...segments[0]];
      for (const segment of segments.slice(1)) {
        if (segment[0] !== walk.at(-1)) return undefined;
        walk.push(...segment.slice(1));
      }
      const expected = Array.from({ length: points.length }, (_, i) => i + 1);
      expected.push(1);
      const open = expected.slice(0, -1);
      if (walk.join(',') !== expected.join(',') && walk.join(',') !== open.join(',')) {
        return undefined;
      }
    }
  } else return undefined;
  if (points.some((point) => point.length < 2 || point.some((value) => !Number.isFinite(value)))) {
    return undefined;
  }
  // A closed polyline repeats its first point; drop the repeat.
  if (points.length === 5 && samePoint(points[0], points[4])) points = points.slice(0, 4);
  if (points.length !== 4) return undefined;
  const [p0, p1, p2, p3] = points;
  const e1 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e3 = [p3[0] - p2[0], p3[1] - p2[1]];
  const e4 = [p0[0] - p3[0], p0[1] - p3[1]];
  const l1 = Math.hypot(e1[0], e1[1]);
  const l2 = Math.hypot(e2[0], e2[1]);
  if (l1 <= 0 || l2 <= 0) return undefined;
  const scale = Math.max(l1, l2);
  const near = (a, b) => Math.abs(a - b) <= RECTANGLE_EPSILON * scale;
  if (!near(e1[0] * e2[0] + e1[1] * e2[1], 0)) return undefined;
  if (!near(e3[0], -e1[0]) || !near(e3[1], -e1[1])) return undefined;
  if (!near(e4[0], -e2[0]) || !near(e4[1], -e2[1])) return undefined;
  return {
    centre: [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2],
    u: [e1[0] / l1, e1[1] / l1],
    v: [e2[0] / l2, e2[1] / l2],
    a: l1 / 2,
    b: l2 / 2,
    closed: curve.type === 'IFCPOLYLINE' && referencesIn(curve.args).length === 5,
    curveType: curve.type,
  };
}
