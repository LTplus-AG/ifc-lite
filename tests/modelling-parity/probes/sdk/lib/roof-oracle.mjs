/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry oracle for roof-by-footprint (#9296): does a meshed roof really slope?
 *
 * The expected top surface over a CONVEX footprint with a slope per edge is the
 * lower envelope of one plane per sloped edge, each rising from its eave at its
 * slope. Edges with slope 0 are gable ends and constrain nothing. That one rule
 * gives hip (all edges sloped), gable (two opposite edges) and mono-pitch (one
 * edge) roofs, exactly as Revit's Roof by Footprint and Archicad's multi-plane
 * roof derive them.
 *
 * The roof passes only if:
 *   - at every sampled plan point (a grid from the eaves to the ridge, kept off
 *     the footprint edge), a point just BELOW the expected top (-0.12 m) is
 *     inside the solid and a point just ABOVE it (+0.15 m) is outside. The
 *     margins absorb the vertical-thickness difference between a plate measured
 *     perpendicular to its slope and one measured vertically (under 0.04 m at
 *     30°);
 *   - its enclosed volume is within 10 % of the analytic volume, either as a
 *     plate of thickness T on the slopes (T x sloped area, as Revit and Archicad
 *     build roofs) or as a mass from the eave plane up to the sloped top;
 *   - for a hip, its corners are low and its centre high.
 * A flat slab or a prism extruded to the full ridge height fails all of these.
 */

import { bboxOfParts, containsPoint, volumeOfParts } from './parity.mjs';

const BELOW = 0.12, ABOVE = 0.15, EDGE_MARGIN = 0.6, VOLUME_TOL = 0.1;

/** Distance from plan point p to the infinite line through edge a->b. */
function lineDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  return Math.abs((px - ax) * dy - (py - ay) * dx) / Math.hypot(dx, dy);
}

/** Height of the expected top surface above the eaves at plan point p, and the active slope. */
export function roofSurface(footprint, slopes, p) {
  let h = Infinity, slope = 0;
  for (let i = 0; i < footprint.length; i++) {
    if (!(slopes[i] > 0)) continue;
    const z = Math.tan(slopes[i]) * lineDistance(p, footprint[i], footprint[(i + 1) % footprint.length]);
    if (z < h) { h = z; slope = slopes[i]; }
  }
  return { h: Number.isFinite(h) ? h : 0, slope };
}

/** Analytic volumes of the two accepted conventions, by midpoint integration over the footprint's bounds. */
export function analyticVolumes(footprint, slopes, thickness, steps = 200) {
  const xs = footprint.map((p) => p[0]), ys = footprint.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const dx = (x1 - x0) / steps, dy = (y1 - y0) / steps;
  let plate = 0, mass = 0;
  for (let i = 0; i < steps; i++) for (let j = 0; j < steps; j++) {
    const p = [x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy];
    const { h, slope } = roofSurface(footprint, slopes, p);
    plate += (thickness / Math.cos(slope)) * dx * dy;
    mass += (thickness + h) * dx * dy;
  }
  return { plate, mass };
}

/** Sample plan points: a grid kept EDGE_MARGIN inside the footprint's bounds (rectangular footprints). */
function samples(footprint) {
  const xs = footprint.map((p) => p[0]), ys = footprint.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs) + EDGE_MARGIN, Math.max(...xs) - EDGE_MARGIN, Math.min(...ys) + EDGE_MARGIN, Math.max(...ys) - EDGE_MARGIN];
  const out = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 5; j++) out.push([x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * j) / 5]);
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Judge meshed roof parts against the footprint and per-edge slopes (radians).
 * Returns true, or a string naming what is wrong (the probe check's failure detail).
 */
export function judgeRoof(parts, { footprint, slopes, thickness, hip = false }) {
  const box = bboxOfParts(parts);
  if (!box) return 'the roof has no geometry';
  const base = box.min[2];
  const top = (p) => base + thickness + roofSurface(footprint, slopes, p).h;
  const wrong = [];
  for (const p of samples(footprint)) {
    const z = top(p);
    if (!containsPoint(parts, [p[0], p[1], z - BELOW])) wrong.push(`no roof just below the expected surface at (${r2(p[0])}, ${r2(p[1])}, ${r2(z - BELOW)})`);
    if (containsPoint(parts, [p[0], p[1], z + ABOVE])) wrong.push(`solid above the expected surface at (${r2(p[0])}, ${r2(p[1])}, ${r2(z + ABOVE)})`);
  }
  if (hip) {
    const xs = footprint.map((p) => p[0]), ys = footprint.map((p) => p[1]);
    const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const corner = [Math.min(...xs) + EDGE_MARGIN, Math.min(...ys) + EDGE_MARGIN];
    if (!containsPoint(parts, [...centre, top(centre) - BELOW])) wrong.push('the hip centre is not high');
    if (containsPoint(parts, [...corner, top(corner) + ABOVE])) wrong.push('the hip corner is not low');
  }
  const v = volumeOfParts(parts), { plate, mass } = analyticVolumes(footprint, slopes, thickness);
  const volumeOk = Math.abs(v - plate) / plate <= VOLUME_TOL || Math.abs(v - mass) / mass <= VOLUME_TOL;
  if (!volumeOk) wrong.push(`volume ${r2(v)} m³, expected ${r2(plate)} (plate) or ${r2(mass)} (mass) within ${VOLUME_TOL * 100} %`);
  if (!wrong.length) return true;
  return `${wrong.length} oracle point(s) failed, e.g. ${wrong.slice(0, 3).join('; ')} (box ${box.size.map(r2).join(' x ')} m)`;
}
