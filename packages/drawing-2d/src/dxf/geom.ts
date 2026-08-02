/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry helpers for DXF import: arc/bulge tessellation and 2D affine
 * transforms. Shared by the parser (HATCH edge paths) and the converter
 * (entity tessellation, block expansion).
 */

import type { DxfVertex } from './types.js';

/** Angular resolution for tessellated arcs (radians). ~5 degrees. */
const ARC_STEP = Math.PI / 36;
const MIN_ARC_SEGMENTS = 4;
const MAX_ARC_SEGMENTS = 128;

export function arcSegmentCount(sweepRad: number): number {
  const n = Math.ceil(Math.abs(sweepRad) / ARC_STEP);
  return Math.min(MAX_ARC_SEGMENTS, Math.max(MIN_ARC_SEGMENTS, n));
}

/**
 * Sample a circular arc from `startDeg` to `endDeg` (degrees, CCW from +X).
 * When `endDeg <= startDeg` the arc wraps through 360 (DXF convention).
 * Includes both endpoints.
 */
export function sampleArc(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): Array<{ x: number; y: number }> {
  const start = (startDeg * Math.PI) / 180;
  let end = (endDeg * Math.PI) / 180;
  if (end <= start) end += Math.PI * 2;
  const sweep = end - start;
  const n = arcSegmentCount(sweep);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Sample a full circle (closed loop; last point NOT repeated). */
export function sampleCircle(cx: number, cy: number, r: number): Array<{ x: number; y: number }> {
  const n = arcSegmentCount(Math.PI * 2);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/**
 * Sample an elliptical arc. `startParam`/`endParam` are parametric angles in
 * radians; the point at parameter t is `c + major·cos(t) + minor·sin(t)`
 * where `minor = ratio · perp(major)`.
 */
export function sampleEllipse(
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  ratio: number,
  startParam: number,
  endParam: number,
): Array<{ x: number; y: number }> {
  let end = endParam;
  if (end <= startParam) end += Math.PI * 2;
  const sweep = end - startParam;
  const n = arcSegmentCount(sweep);
  const minorX = -majorY * ratio;
  const minorY = majorX * ratio;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i++) {
    const t = startParam + (sweep * i) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push({ x: cx + majorX * c + minorX * s, y: cy + majorY * c + minorY * s });
  }
  return pts;
}

/**
 * Expand a polyline vertex loop with bulges into a flat point list.
 * A bulge b = tan(sweep/4) describes the arc from a vertex to the next one
 * (positive = CCW). Closed loops also expand the bulge of the last vertex
 * (arc back to the first). Includes the first point; for closed loops the
 * first point is not repeated at the end.
 */
export function expandBulgedVertices(
  vertices: DxfVertex[],
  closed: boolean,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const count = vertices.length;
  if (count === 0) return out;

  const segments = closed ? count : count - 1;
  out.push({ x: vertices[0].x, y: vertices[0].y });

  for (let i = 0; i < segments; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % count];
    const isLast = i === segments - 1;

    if (!a.bulge || !isFinite(a.bulge)) {
      if (!(closed && isLast)) out.push({ x: b.x, y: b.y });
      continue;
    }

    // Arc through a→b with included angle 4·atan(bulge).
    const sweep = 4 * Math.atan(a.bulge);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12 || Math.abs(sweep) < 1e-9) {
      if (!(closed && isLast)) out.push({ x: b.x, y: b.y });
      continue;
    }

    const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
    // Centre is offset from the chord midpoint along the perpendicular;
    // sign of the bulge picks the side.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
    const side = (sweep > 0 ? 1 : -1) * (Math.abs(sweep) > Math.PI ? -1 : 1);
    const ux = -dy / chord;
    const uy = dx / chord;
    const ccx = mx + ux * h * side;
    const ccy = my + uy * h * side;

    const startAngle = Math.atan2(a.y - ccy, a.x - ccx);
    const n = arcSegmentCount(sweep);
    for (let k = 1; k <= n; k++) {
      if (closed && isLast && k === n) break; // do not repeat the first point
      const t = startAngle + (sweep * k) / n;
      out.push({ x: ccx + radius * Math.cos(t), y: ccy + radius * Math.sin(t) });
    }
  }
  return out;
}

/**
 * Sample a SPLINE entity as a polyline. Fit points win when present (they
 * lie on the curve); otherwise a clamped B-spline is evaluated with de
 * Boor's algorithm. Degenerate knot vectors fall back to the control
 * polygon.
 */
export function tessellateSpline(
  degree: number,
  knots: number[],
  controlPoints: Array<{ x: number; y: number }>,
  fitPoints: Array<{ x: number; y: number }>,
  segmentsPerSpan = 8,
): Array<{ x: number; y: number }> {
  if (fitPoints.length >= 2) return fitPoints.map((p) => ({ x: p.x, y: p.y }));
  const deg = Math.max(1, degree);
  const expectedKnots = controlPoints.length + deg + 1;
  if (controlPoints.length < deg + 1 || knots.length !== expectedKnots) {
    return controlPoints.map((p) => ({ x: p.x, y: p.y }));
  }
  const tMin = knots[deg];
  const tMax = knots[knots.length - 1 - deg];
  if (!(tMax > tMin)) {
    return controlPoints.map((p) => ({ x: p.x, y: p.y }));
  }
  const samples = Math.min(1024, Math.max(8, (controlPoints.length - deg) * segmentsPerSpan));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples;
    points.push(deBoor(t, deg, controlPoints, knots));
  }
  return points;
}

/** de Boor's algorithm for a clamped B-spline at parameter t. */
function deBoor(
  t: number,
  degree: number,
  ctrl: Array<{ x: number; y: number }>,
  knots: number[],
): { x: number; y: number } {
  let k = degree;
  const maxSpan = knots.length - degree - 2;
  while (k < maxSpan && t >= knots[k + 1]) k++;

  const d: Array<{ x: number; y: number }> = [];
  for (let j = 0; j <= degree; j++) {
    const p = ctrl[Math.min(ctrl.length - 1, Math.max(0, j + k - degree))];
    d.push({ x: p.x, y: p.y });
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > 0 ? (t - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
      };
    }
  }
  return d[degree];
}

// ═══════════════════════════════════════════════════════════════════════════
// 2D AFFINE TRANSFORMS
// ═══════════════════════════════════════════════════════════════════════════

/** Column-major 2D affine: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export type Mat2d = [number, number, number, number, number, number];

export const MAT_IDENTITY: Mat2d = [1, 0, 0, 1, 0, 0];

/** Compose so that `m2` is applied first, then `m1`. */
export function matMultiply(m1: Mat2d, m2: Mat2d): Mat2d {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function matApply(m: Mat2d, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** translate(tx,ty) ∘ rotate(deg CCW) ∘ scale(sx,sy). */
export function matTRS(tx: number, ty: number, rotationDeg: number, sx: number, sy: number): Mat2d {
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c * sx, s * sx, -s * sy, c * sy, tx, ty];
}

export function matTranslate(tx: number, ty: number): Mat2d {
  return [1, 0, 0, 1, tx, ty];
}
