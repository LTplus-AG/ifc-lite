/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { pointInPolygon } from './polygon-2d.js';
import type { Point3D } from '../types.js';
import { vecCross, vecLen, vecNorm } from '../ifc-creator-math.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement } from './_emit-helpers.js';

type Flat = readonly [number, number];
const orient = (p: Flat, q: Flat, r: Flat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
/** `r` lies within `tol` of segment p-q. */
function touches(p: Flat, q: Flat, r: Flat, tol: number): boolean {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const t = Math.max(0, Math.min(1, ((r[0] - p[0]) * dx + (r[1] - p[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(r[0] - p[0] - t * dx, r[1] - p[1] - t * dy) <= tol;
}
/** Segments p and q cross, or come within `tol` of each other. */
function segmentsMeet([p1, p2]: readonly [Flat, Flat], [q1, q2]: readonly [Flat, Flat], tol: number): boolean {
  if (orient(q1, q2, p1) * orient(q1, q2, p2) < 0 && orient(p1, p2, q1) * orient(p1, p2, q2) < 0) return true;
  return touches(q1, q2, p1, tol) || touches(q1, q2, p2, tol) || touches(p1, p2, q1, tol) || touches(p1, p2, q2, tol);
}

function isFiniteRing(points: unknown): points is Point3D[] {
  return Array.isArray(points) && points.length >= 3 && points.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite));
}

/** Validate before emitting anything. Coordinates are storey-local metres. */
export function prepareStructuralFace(points: readonly Point3D[], openings: readonly Point3D[][] | null = []) {
  // JSON callers send null for no openings.
  openings ??= [];
  if (!Array.isArray(openings)) throw new Error('Structural Face: Openings must be an array');
  if (!isFiniteRing(points)) {
    throw new Error('Structural Face: at least three finite boundary points are required');
  }
  const origin = points[0];
  const relative = points.map(p => p.map((v, i) => v - origin[i]) as Point3D);
  const scale = Math.max(...relative.map(vecLen));
  // Loose enough for float32 picks (about 1e-7 relative), far below modelling precision.
  const tolerance = Math.max(1, scale) * 1e-6;
  for (let i = 0; i < relative.length; i++) {
    for (let j = i + 1; j < relative.length; j++) {
      const p = relative[i], q = relative[j];
      if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 <= tolerance ** 2) {
        throw new Error(i === 0 && j === relative.length - 1
          ? 'Structural Face: the boundary closes itself; do not repeat the first point at the end'
          : 'Structural Face: degenerate boundary (duplicate points)');
      }
    }
  }
  // The plane normal is the loop's area vector, so the outer bound (Orientation
  // .T.) runs counter-clockwise about it. A single vertex triple points the
  // other way when its middle corner is reflex.
  const areaVector = relative.reduce<Point3D>((sum, p, i) => {
    const cross = vecCross(p, relative[(i + 1) % relative.length]);
    return sum.map((v, j) => v + cross[j]) as Point3D;
  }, [0, 0, 0]);
  if (vecLen(areaVector) <= tolerance * scale) throw new Error('Structural Face: degenerate boundary (collinear points or zero area)');
  const axis = vecNorm(areaVector);
  const offsets = relative.map(p => p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]);
  if (offsets.some(d => Math.abs(d) > tolerance)) throw new Error('Structural Face: boundary points must be coplanar');
  // Snap onto the plane, so the written loop lies exactly on the IfcPlane.
  const planar = relative.map((p, i) => p.map((v, k) => v - offsets[i] * axis[k]) as Point3D);
  // Self-intersection in 2D, dropping the axis the plane is most nearly facing.
  const drop = [0, 1, 2].reduce((m, k) => (Math.abs(axis[k]) > Math.abs(axis[m]) ? k : m), 0);
  const [a, b] = [0, 1, 2].filter(k => k !== drop);
  const n = planar.length;
  const edges = planar.map((p, k): [Flat, Flat] => [[p[a], p[b]], [planar[(k + 1) % n][a], planar[(k + 1) % n][b]]]);
  for (let i = 0; i < n - 2; i++) {
    // Edges i and j are adjacent when j = i + 1, or when i = 0 and j = n - 1.
    for (let j = i + 2; j < (i === 0 ? n - 1 : n); j++) {
      if (segmentsMeet(edges[i], edges[j], tolerance)) throw new Error('Structural Face: boundary must not self-intersect');
    }
  }
  const u = vecNorm(planar[1]);
  const v = vecCross(axis, u);
  const project = (p: Point3D): [number, number] => [p.reduce((s, x, k) => s + x * u[k], 0), p.reduce((s, x, k) => s + x * v[k], 0)];
  const face = { origin, relative: planar, axis, tolerance, project, outer: planar.map(project), openings: [] as Point3D[][] };
  for (const [index, opening] of openings.entries()) {
    try { face.openings.push(checkOpening(face, opening, face.openings, { clearance: 0, index })); }
    catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/^Structural Face: (?:opening \d+: )?/, '');
      throw new Error(`Structural Face: opening ${index + 1}: ${detail}`);
    }
  }
  return face;
}

/** Validate an opening in the boundary's frame (storey-local for the builder, world
 * for the planner); return a snapped, oriented ring relative to the face origin.
 * Accepted rings use the same relative coordinates. */
export function checkOpening(face: ReturnType<typeof prepareStructuralFace>, opening: readonly Point3D[], accepted: readonly Point3D[][], { clearance, index = 0 }: { clearance: number; index?: number }): Point3D[] {
  const { origin, axis, tolerance, project, outer } = face;
  if (!isFiniteRing(opening)) throw new Error('Structural Face: opening requires at least three finite boundary points');
  const relativeRing = opening.map(p => p.map((x, k) => x - origin[k]) as Point3D);
  const offsets = relativeRing.map(p => p.reduce((s, x, k) => s + x * axis[k], 0));
  if (offsets.some(d => Math.abs(d) > tolerance)) throw new Error('Structural Face: opening must be coplanar with boundary');
  const ring = relativeRing.map((p, i) => p.map((x, k) => x - offsets[i] * axis[k]) as Point3D);
  let prepared: ReturnType<typeof prepareStructuralFace>;
  try { prepared = prepareStructuralFace(ring); }
  catch (error) { throw new Error(`Structural Face: opening ${index + 1}: ${(error instanceof Error ? error.message : String(error)).replace(/^Structural Face: /, '')}`); }
  const flat = ring.map(project);
  const edgesOf = (points: Flat[]) => points.map((p, i): [Flat, Flat] => [p, points[(i + 1) % points.length]]);
  const edges = edgesOf(flat);
  const padding = Math.max(tolerance, clearance);
  const boundsOf = (points: Flat[]) => [0, 1].map(k => [Math.min(...points.map(p => p[k])), Math.max(...points.map(p => p[k]))]);
  const bounds = boundsOf(flat);
  const meet = (other: Flat[]) => {
    const otherBounds = boundsOf(other);
    if (bounds.some(([min, max], k) => max + padding < otherBounds[k][0] || otherBounds[k][1] + padding < min)) return false;
    const otherEdges = edgesOf(other);
    return edges.some(e => otherEdges.some(f => segmentsMeet(e, f, padding)));
  };
  if (!flat.every(p => pointInPolygon(p[0], p[1], outer)) || meet(outer)) throw new Error('Structural Face: opening must lie strictly inside boundary');
  if (accepted.some(r => {
    const other = r.map(project);
    return meet(other) || pointInPolygon(flat[0][0], flat[0][1], other) || pointInPolygon(other[0][0], other[0][1], flat);
  })) throw new Error('Structural Face: openings must not overlap or touch');
  return prepared.axis.reduce((sum, x, k) => sum + x * axis[k], 0) > 0 ? ring.reverse() : ring;
}

/** Placement, plane, face and representation ids, plus point/vertex/edge/oriented-edge
 * ids from all loops. loopId and boundId identify only the outer loop and bound;
 * innerLoopIds and innerBoundIds identify the opening loops and bounds. */
export interface StructuralFaceIds {
  placementId: number;
  pointIds: number[];
  vertexIds: number[];
  edgeIds: number[];
  orientedEdgeIds: number[];
  loopId: number;
  boundId: number;
  innerLoopIds: number[];
  innerBoundIds: number[];
  planePointId: number;
  normalId: number;
  refDirectionId: number;
  planePlacementId: number;
  planeId: number;
  faceId: number;
  topologyRepId: number;
  productShapeId: number;
}

/** Emit one exclusively owned edge loop. */
function emitLoop(editor: StoreEditor, anchor: SpatialAnchor, points: readonly Point3D[]) {
  const pointIds = points.map(p => editor.addEntity('IfcCartesianPoint', [toNativePoint3(anchor, p)]).expressId);
  const vertexIds = pointIds.map(id => editor.addEntity('IfcVertexPoint', [`#${id}`]).expressId);
  const edgeIds = vertexIds.map((id, i) => editor.addEntity('IfcEdge', [`#${id}`, `#${vertexIds[(i + 1) % vertexIds.length]}`]).expressId);
  const orientedEdgeIds = edgeIds.map(id => editor.addEntity('IfcOrientedEdge', ['*', '*', `#${id}`, '.T.']).expressId);
  const loopId = editor.addEntity('IfcEdgeLoop', [orientedEdgeIds.map(id => `#${id}`)]).expressId;
  return { pointIds, vertexIds, edgeIds, orientedEdgeIds, loopId };
}

/** A fresh, exclusively owned topology subgraph for each surface product. */
export function emitStructuralFace(editor: StoreEditor, anchor: SpatialAnchor, face: ReturnType<typeof prepareStructuralFace>): StructuralFaceIds {
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, toNativePoint3(anchor, face.origin));
  const { pointIds, vertexIds, edgeIds, orientedEdgeIds, loopId } = emitLoop(editor, anchor, face.relative);
  const boundId = editor.addEntity('IfcFaceOuterBound', [`#${loopId}`, '.T.']).expressId;
  const innerBoundIds: number[] = [];
  const innerLoopIds: number[] = [];
  for (const ring of face.openings) {
    const inner = emitLoop(editor, anchor, ring);
    innerLoopIds.push(inner.loopId);
    pointIds.push(...inner.pointIds);
    vertexIds.push(...inner.vertexIds);
    edgeIds.push(...inner.edgeIds);
    orientedEdgeIds.push(...inner.orientedEdgeIds);
    innerBoundIds.push(editor.addEntity('IfcFaceBound', [`#${inner.loopId}`, '.T.']).expressId);
  }
  const planePointId = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const normalId = editor.addEntity('IfcDirection', [face.axis]).expressId;
  const refDirectionId = editor.addEntity('IfcDirection', [vecNorm(face.relative[1])]).expressId;
  const planePlacementId = editor.addEntity('IfcAxis2Placement3D', [`#${planePointId}`, `#${normalId}`, `#${refDirectionId}`]).expressId;
  const planeId = editor.addEntity('IfcPlane', [`#${planePlacementId}`]).expressId;
  const faceId = editor.addEntity('IfcFaceSurface', [[boundId, ...innerBoundIds].map(id => `#${id}`), `#${planeId}`, '.T.']).expressId;
  const topologyRepId = editor.addEntity('IfcTopologyRepresentation', [`#${anchor.bodyContextId}`, 'Reference', 'Face', [`#${faceId}`]]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${topologyRepId}`]]).expressId;
  return { placementId, pointIds, vertexIds, edgeIds, orientedEdgeIds, loopId, boundId, innerLoopIds, innerBoundIds, planePointId, normalId, refDirectionId, planePlacementId, planeId, faceId, topologyRepId, productShapeId };
}
