/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState, Vec3 } from './types.js';
import type { SourceSnapCurve } from './source-curve-snap.js';
import { pointClipped } from './scene-raycaster.js';

type Interval = readonly [number, number];
type Plane = { n: readonly [number, number, number]; limit: number };
const TAU = 2 * Math.PI;
const NON_AFFINE_CLIP_SAMPLES = 32;

function planesFor(clip: PickClipState): Plane[] {
  const planes: Plane[] = [];
  const section = clip.sectionPlane;
  if (section) {
    const side = section.flipped ? -1 : 1;
    planes.push({ n: [section.normal[0] * side, section.normal[1] * side, section.normal[2] * side],
      limit: section.distance * side });
  }
  const box = clip.clipBox;
  if (box?.enabled) for (let axis = 0; axis < 3; axis++) {
    const positive: [number, number, number] = [0, 0, 0];
    const negative: [number, number, number] = [0, 0, 0];
    positive[axis] = 1;
    negative[axis] = -1;
    planes.push({ n: positive, limit: box.max[axis] }, { n: negative, limit: -box.min[axis] });
  }
  return planes;
}

function dot(p: Vec3, n: readonly number[]): number { return p.x * n[0] + p.y * n[1] + p.z * n[2]; }

/** Liang-Barsky in parameter space: catches a narrow interior even when both endpoints are clipped. */
function lineIntervals(curve: SourceSnapCurve, planes: readonly Plane[]): Interval[] {
  const a = curve.pointAt(0), b = curve.pointAt(1);
  if (!a || !b) return [];
  let low = 0, high = 1;
  for (const plane of planes) {
    const start = dot(a, plane.n) - plane.limit;
    const slope = dot(b, plane.n) - dot(a, plane.n);
    if (Math.abs(slope) < 1e-15) { if (start > 0) return []; continue; }
    const root = -start / slope;
    if (slope > 0) high = Math.min(high, root);
    else low = Math.max(low, root);
    if (low > high) return [];
  }
  return [[Math.max(0, low), Math.min(1, high)]];
}

/** Roots of a clip plane against C + U cos(theta) + V sin(theta), theta=sweep*t. */
function arcPlaneRoots(
  plane: Plane, center: Vec3, u: Vec3, v: Vec3, sweep: number,
): number[] {
  const a = dot(center, plane.n) - plane.limit;
  const b = dot(u, plane.n), c = dot(v, plane.n);
  const magnitude = Math.hypot(b, c);
  if (!(magnitude > 0) || Math.abs(a) > magnitude) return [];
  const phase = Math.atan2(c, b);
  const offset = Math.acos(Math.max(-1, Math.min(1, -a / magnitude)));
  const roots: number[] = [];
  const lower = Math.min(0, sweep), upper = Math.max(0, sweep);
  for (const base of [phase - offset, phase + offset]) {
    const first = Math.ceil((lower - base) / TAU);
    const last = Math.floor((upper - base) / TAU);
    if (last - first > 512) continue;
    for (let k = first; k <= last; k++) {
      const t = (base + TAU * k) / sweep;
      if (t > 0 && t < 1) roots.push(t);
    }
  }
  return roots;
}

function visibleIntervals(curve: SourceSnapCurve, roots: number[], clip: PickClipState): Interval[] {
  roots.sort((a, b) => a - b);
  const intervals: Interval[] = [];
  for (let i = 0; i + 1 < roots.length; i++) {
    const a = roots[i], b = roots[i + 1];
    if (b - a <= 1e-14) continue;
    const middle = curve.pointAt((a + b) / 2);
    if (middle && !pointClipped(clip, middle.x, middle.y, middle.z)) intervals.push([a, b]);
  }
  return intervals;
}

/** Bracket clip-plane crossings along a smooth cross-CRS display curve.
 * A fold entirely between adjacent samples remains below this bounded search's resolution.
 */
function nonAffineIntervals(curve: SourceSnapCurve, planes: readonly Plane[], clip: PickClipState): Interval[] {
  const samples = Array.from({ length: NON_AFFINE_CLIP_SAMPLES + 1 }, (_, i) =>
    curve.pointAt(i / NON_AFFINE_CLIP_SAMPLES));
  const roots = [0, 1];
  for (const plane of planes) {
    for (let i = 0; i < NON_AFFINE_CLIP_SAMPLES; i++) {
      const a = samples[i], b = samples[i + 1];
      if (!a || !b) continue;
      let fa = dot(a, plane.n) - plane.limit;
      const fb = dot(b, plane.n) - plane.limit;
      if (!Number.isFinite(fa) || !Number.isFinite(fb)) continue;
      const start = i / NON_AFFINE_CLIP_SAMPLES;
      const end = (i + 1) / NON_AFFINE_CLIP_SAMPLES;
      if (fa === 0) roots.push(start);
      if (fb === 0) roots.push(end);
      if (fa === 0 || fb === 0 || Math.sign(fa) === Math.sign(fb)) continue;
      let low = start, high = end;
      let valid = true;
      for (let step = 0; step < 40; step++) {
        const middle = (low + high) / 2;
        const point = curve.pointAt(middle);
        if (!point) { valid = false; break; }
        const fm = dot(point, plane.n) - plane.limit;
        if (!Number.isFinite(fm)) { valid = false; break; }
        if (Math.sign(fm) === Math.sign(fa)) { low = middle; fa = fm; }
        else high = middle;
      }
      if (valid) roots.push((low + high) / 2);
    }
  }
  return visibleIntervals(curve, roots, clip);
}

function arcIntervals(curve: SourceSnapCurve, planes: readonly Plane[], clip: PickClipState): Interval[] {
  const sweep = curve.sweepAngle;
  if (!sweep || !Number.isFinite(sweep)) return [];
  // Relative to the source start angle. A transformed circular arc remains
  // C + U cos(theta) + V sin(theta) under translation, rotation and mirroring.
  const p0 = curve.pointAt(0), p90 = curve.pointAt(Math.PI / (2 * sweep));
  const p180 = curve.pointAt(Math.PI / sweep);
  if (!p0 || !p90 || !p180) return [];
  const center = { x: (p0.x + p180.x) / 2, y: (p0.y + p180.y) / 2, z: (p0.z + p180.z) / 2 };
  const u = { x: p0.x - center.x, y: p0.y - center.y, z: p0.z - center.z };
  const v = { x: p90.x - center.x, y: p90.y - center.y, z: p90.z - center.z };
  const roots = [0, 1, ...planes.flatMap((plane) => arcPlaneRoots(plane, center, u, v, sweep))];
  return visibleIntervals(curve, roots, clip);
}

/** Feasible source-parameter intervals for the renderer's current clip. */
export function sourceCurveClipIntervals(curve: SourceSnapCurve, clip?: PickClipState | null): Interval[] {
  if (!clip || (!clip.sectionPlane && !clip.clipBox?.enabled)) return [[0, 1]];
  const planes = planesFor(clip);
  // Cross-CRS curves have no analytic clip roots. Numerically bracket crossings
  // so a thin visible interval is not lost between snap-distance samples.
  if (curve.affineDisplayFrame === false) return nonAffineIntervals(curve, planes, clip);
  return curve.kind === 'line' ? lineIntervals(curve, planes) : arcIntervals(curve, planes, clip);
}
