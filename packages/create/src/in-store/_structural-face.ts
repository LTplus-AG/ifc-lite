/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import { vecCross, vecDot, vecLen, vecNorm } from '../ifc-creator-math.js';
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

/** Validate before emitting anything. Coordinates are storey-local metres. */
export function prepareStructuralFace(points: readonly Point3D[]) {
  if (points.length < 3 || points.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) {
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
  const offsets = relative.map(p => vecDot(p, axis));
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
  return { origin, relative: planar, axis };
}

/** Every id in a surface product's exclusively owned face subgraph. */
export interface StructuralFaceIds {
  placementId: number;
  pointIds: number[];
  vertexIds: number[];
  edgeIds: number[];
  orientedEdgeIds: number[];
  loopId: number;
  boundId: number;
  planePointId: number;
  normalId: number;
  refDirectionId: number;
  planePlacementId: number;
  planeId: number;
  faceId: number;
  topologyRepId: number;
  productShapeId: number;
}

/** A fresh, exclusively owned topology subgraph for each surface product. */
export function emitStructuralFace(editor: StoreEditor, anchor: SpatialAnchor, face: ReturnType<typeof prepareStructuralFace>): StructuralFaceIds {
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, toNativePoint3(anchor, face.origin));
  const pointIds = face.relative.map(p => editor.addEntity('IfcCartesianPoint', [toNativePoint3(anchor, p)]).expressId);
  const vertexIds = pointIds.map(id => editor.addEntity('IfcVertexPoint', [`#${id}`]).expressId);
  const edgeIds = vertexIds.map((id, i) => editor.addEntity('IfcEdge', [`#${id}`, `#${vertexIds[(i + 1) % vertexIds.length]}`]).expressId);
  const orientedEdgeIds = edgeIds.map(id => editor.addEntity('IfcOrientedEdge', ['*', '*', `#${id}`, '.T.']).expressId);
  const loopId = editor.addEntity('IfcEdgeLoop', [orientedEdgeIds.map(id => `#${id}`)]).expressId;
  const boundId = editor.addEntity('IfcFaceOuterBound', [`#${loopId}`, '.T.']).expressId;
  const planePointId = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const normalId = editor.addEntity('IfcDirection', [face.axis]).expressId;
  const refDirectionId = editor.addEntity('IfcDirection', [vecNorm(face.relative[1])]).expressId;
  const planePlacementId = editor.addEntity('IfcAxis2Placement3D', [`#${planePointId}`, `#${normalId}`, `#${refDirectionId}`]).expressId;
  const planeId = editor.addEntity('IfcPlane', [`#${planePlacementId}`]).expressId;
  const faceId = editor.addEntity('IfcFaceSurface', [[`#${boundId}`], `#${planeId}`, '.T.']).expressId;
  const topologyRepId = editor.addEntity('IfcTopologyRepresentation', [`#${anchor.bodyContextId}`, 'Reference', 'Face', [`#${faceId}`]]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${topologyRepId}`]]).expressId;
  return { placementId, pointIds, vertexIds, edgeIds, orientedEdgeIds, loopId, boundId, planePointId, normalId, refDirectionId, planePlacementId, planeId, faceId, topologyRepId, productShapeId };
}
