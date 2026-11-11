/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import { vecCross, vecLen, vecNorm } from '../ifc-creator-math.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement } from './_emit-helpers.js';

type Flat = readonly [number, number];
const orient = (p: Flat, q: Flat, r: Flat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const within = (p: Flat, q: Flat, r: Flat) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
function segmentsMeet(p1: Flat, p2: Flat, q1: Flat, q2: Flat): boolean {
  const [d1, d2, d3, d4] = [orient(q1, q2, p1), orient(q1, q2, p2), orient(p1, p2, q1), orient(p1, p2, q2)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(q1, q2, p1)) || (d2 === 0 && within(q1, q2, p2)) || (d3 === 0 && within(p1, p2, q1)) || (d4 === 0 && within(p1, p2, q2));
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
      const [p, q] = [relative[i], relative[j]];
      if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 <= tolerance ** 2) {
        throw new Error('Structural Face: degenerate boundary (duplicate points)');
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
  if (relative.some(p => Math.abs(p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]) > tolerance)) {
    throw new Error('Structural Face: boundary points must be coplanar');
  }
  // Snap onto the plane, so the written loop lies exactly on the IfcPlane.
  const planar = relative.map(p => {
    const d = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
    return [p[0] - d * axis[0], p[1] - d * axis[1], p[2] - d * axis[2]] as Point3D;
  });
  const drop = [0, 1, 2].reduce((m, k) => (Math.abs(axis[k]) > Math.abs(axis[m]) ? k : m), 0);
  const flat = planar.map(p => p.filter((_, k) => k !== drop) as unknown as Flat);
  const n = flat.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsMeet(flat[i], flat[i + 1], flat[j], flat[(j + 1) % n])) {
        throw new Error('Structural Face: boundary must not self-intersect');
      }
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
