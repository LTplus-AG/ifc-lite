/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PickClipState, Vec3 } from './types.js';
import type { Ray } from './raycaster.js';
import { SnapType, type SnapOptions, type SnapTarget } from './snap-detector.js';
import { sourceCurveClipIntervals } from './source-curve-clipping.js';
import { pointClipped } from './scene-raycaster.js';
import { screenToWorldRadius } from './snap-geometry-utils.js';

/** Identity of an authored directrix segment, independent of federated picking IDs. */
export interface SourceCurveIdentity {
  modelId: string;
  expressId: number;
  solidId: number;
  occurrenceIndex: number;
  segmentIndex: number;
  directrixId: number;
  mappingPath: readonly number[];
}

/** Evaluates the authored line or signed arc in f64 after its display-frame transform. */
export interface SourceSnapCurve {
  identity: SourceCurveIdentity;
  globalId: number;
  kind: 'line' | 'arc';
  length: number;
  /** The signed source sweep in radians; only arcs have one. */
  sweepAngle?: number;
  /** False when cross-CRS reprojection makes the display map non-affine. */
  affineDisplayFrame?: boolean;
  /** Conservative displayed-world sphere; absent for non-affine reprojections. */
  bounds?: { center: Vec3; radius: number };
  pointAt(t: number): Vec3 | null;
}

export interface SourceCurveSnapCandidate {
  target: SnapTarget;
  screenDistance: number;
}

type Project = (point: Vec3) => { x: number; y: number } | null;

/** Cull distant curves before expensive f64 evaluation/projection on hover. */
export function sourceCurveMayReachRay(
  curve: SourceSnapCurve, ray: Ray, radiusPx: number, fov: number, heightPx: number,
  orthoHalfHeight: number | null,
): boolean {
  const bounds = curve.bounds;
  if (!bounds) return true;
  const delta = { x: bounds.center.x - ray.origin.x, y: bounds.center.y - ray.origin.y,
    z: bounds.center.z - ray.origin.z };
  const depth = delta.x * ray.direction.x + delta.y * ray.direction.y + delta.z * ray.direction.z;
  if (depth + bounds.radius < 0) return false;
  const lateral = Math.sqrt(Math.max(0, delta.x ** 2 + delta.y ** 2 + delta.z ** 2 - depth ** 2));
  const tolerance = orthoHalfHeight === null
    ? screenToWorldRadius(radiusPx, Math.max(0, depth + bounds.radius), fov, heightPx)
    : radiusPx * 2 * orthoHalfHeight / heightPx;
  return lateral <= bounds.radius + tolerance;
}

/** Prefer a mesh snap at equal cursor distance; use the source when closer. */
export function sourceWinsOverMeshSnap(
  source: SourceCurveSnapCandidate, mesh: SnapTarget | null, x: number, y: number, project: Project,
): boolean {
  if (!mesh) return true;
  // An opted-in authored edge has priority over a generic surface/face-centre
  // snap. Otherwise every ray through the rebar mesh would return its face at
  // zero screen distance and the centreline could never be picked.
  if (mesh.type === SnapType.FACE || mesh.type === SnapType.FACE_CENTER) return true;
  const screen = project(mesh.position);
  return source.screenDistance + 0.5 < (screen ? Math.hypot(screen.x - x, screen.y - y) : Infinity);
}

/** One decision for the exact source candidate against the current mesh snap. */
export function preferredSourceCurveSnap(
  curves: readonly SourceSnapCurve[], mesh: SnapTarget | null, x: number, y: number,
  radiusPx: number, project: Project,
  accepts: (curve: SourceSnapCurve, point: Vec3) => boolean,
  clip?: PickClipState | null,
  snapKinds?: Partial<Pick<SnapOptions, 'snapToVertices' | 'snapToEdges'>>,
  mayVisit?: (curve: SourceSnapCurve) => boolean,
): SnapTarget | null {
  const source = sourceCurveSnapCandidate(curves, x, y, radiusPx, project, accepts, clip, snapKinds, mayVisit);
  return source && sourceWinsOverMeshSnap(source, mesh, x, y, project) ? source.target : null;
}

/** Minimize screen distance while evaluating the exact curve, never display chords. */
export function sourceCurveSnapCandidate(
  curves: readonly SourceSnapCurve[], x: number, y: number, radiusPx: number,
  project: Project, accepts: (curve: SourceSnapCurve, point: Vec3) => boolean,
  clip?: PickClipState | null,
  snapKinds?: Partial<Pick<SnapOptions, 'snapToVertices' | 'snapToEdges'>>,
  mayVisit?: (curve: SourceSnapCurve) => boolean,
): SourceCurveSnapCandidate | null {
  if (!(Number.isFinite(radiusPx) && radiusPx > 0)) return null;
  const vertices = snapKinds?.snapToVertices ?? true;
  const edges = snapKinds?.snapToEdges ?? true;
  if (!vertices && !edges) return null;
  let best: SourceCurveSnapCandidate | null = null;
  for (const curve of curves) {
    if (mayVisit && !mayVisit(curve)) continue;
    const at = (t: number): { distanceSquared: number; point: Vec3 | null } => {
      const point = curve.pointAt(t);
      if (!point || ![point.x, point.y, point.z].every(Number.isFinite)
        || pointClipped(clip, point.x, point.y, point.z) || !accepts(curve, point)) {
        return { distanceSquared: Infinity, point: null };
      }
      const screen = project(point);
      if (!screen) return { distanceSquared: Infinity, point: null };
      return { distanceSquared: (screen.x - x) ** 2 + (screen.y - y) ** 2, point };
    };
    let bestT = 0;
    let curveBest: ReturnType<typeof at> = { distanceSquared: Infinity, point: null };
    for (const [low, high] of sourceCurveClipIntervals(curve, clip)) {
      if (!edges) {
        for (const t of [0, 1]) if (t >= low && t <= high) {
          const value = at(t);
          if (value.distanceSquared < curveBest.distanceSquared) { bestT = t; curveBest = value; }
        }
        continue;
      }
      // Clip boundaries are candidates even when the entire visible piece is
      // narrower than a sampling interval. Interior points use the source equation.
      // Reprojection can give a source line multiple screen-space minima even without a clip.
      const sampled = curve.kind === 'arc' || curve.affineDisplayFrame === false;
      const subdivisions = !sampled ? 1
        : Math.min(256, Math.max(32, Math.ceil(Math.abs(curve.sweepAngle ?? 0) * (high - low) / (Math.PI / 32))));
      const values: number[] = [];
      for (let i = 0; i <= subdivisions; i++) {
        const t = low + (high - low) * i / subdivisions;
        const value = at(t);
        values.push(value.distanceSquared);
        if (value.distanceSquared < curveBest.distanceSquared) { bestT = t; curveBest = value; }
      }
      for (let i = 0; i <= subdivisions; i++) {
        if (sampled && (values[i] > (values[i - 1] ?? Infinity)
          || values[i] > (values[i + 1] ?? Infinity))) continue;
        if (values[i] === Infinity) continue;
        let left = !sampled ? low : low + (high - low) * Math.max(0, i - 1) / subdivisions;
        let right = !sampled ? high : low + (high - low) * Math.min(subdivisions, i + 1) / subdivisions;
        for (let step = 0; step < 30; step++) {
          const a = left + (right - left) * 0.3819660112501051;
          const b = right - (right - left) * 0.3819660112501051;
          const distanceA = at(a).distanceSquared;
          const distanceB = at(b).distanceSquared;
          if (distanceA === Infinity && distanceB === Infinity) {
            // A line may cross the camera's near plane late in this interval.
            // Keep the half with a projectable endpoint until a probe enters it.
            if (at(right).distanceSquared < Infinity) left = b;
            else if (at(left).distanceSquared < Infinity) right = a;
            else break;
          } else if (distanceA <= distanceB) right = b;
          else left = a;
        }
        const t = (left + right) / 2;
        const value = at(t);
        if (value.distanceSquared < curveBest.distanceSquared) { bestT = t; curveBest = value; }
        if (!sampled) break;
      }
    }
    if (!curveBest.point || curveBest.distanceSquared > radiusPx * radiusPx) continue;
    const screenDistance = Math.sqrt(curveBest.distanceSquared);
    if (best && screenDistance >= best.screenDistance) continue;
    const endpoint = bestT <= 1e-7 || bestT >= 1 - 1e-7;
    if (!edges && (!endpoint || !vertices)) continue;
    best = {
      screenDistance,
      target: {
        type: endpoint && vertices ? SnapType.VERTEX : SnapType.EDGE,
        position: curveBest.point,
        expressId: curve.globalId,
        confidence: 1 - screenDistance / radiusPx,
        metadata: {
          sourceCurve: { ...curve.identity, kind: curve.kind, length: curve.length, t: bestT },
        },
      },
    };
  }
  return best;
}
