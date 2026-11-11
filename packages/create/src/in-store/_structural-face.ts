/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import { vecCross, vecLen, vecNorm } from '../ifc-creator-math.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement } from './_emit-helpers.js';

/** Validate before emitting anything. Coordinates are storey-local metres. */
export function prepareStructuralFace(points: readonly Point3D[]) {
  if (points.length < 3 || points.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) {
    throw new Error('Structural Face: at least three finite boundary points are required');
  }
  const origin = points[0];
  const relative = points.map(p => p.map((v, i) => v - origin[i]) as Point3D);
  const scale = Math.max(...relative.map(vecLen));
  const tolerance = Math.max(1, scale) * 1e-9;
  const normal = relative.slice(1).map((p, i) => vecCross(p, relative[i + 2] ?? relative[1]))
    .find(n => vecLen(n) > tolerance * scale);
  if (!normal) throw new Error('Structural Face: degenerate boundary (collinear points)');
  const axis = vecNorm(normal);
  if (relative.some(p => Math.abs(p.reduce((s, v, i) => s + v * axis[i], 0)) > tolerance)) {
    throw new Error('Structural Face: boundary points must be coplanar');
  }
  if (relative.some((p, i) => relative.slice(i + 1).some(q => vecLen(p.map((v, j) => v - q[j]) as Point3D) <= tolerance))) {
    throw new Error('Structural Face: degenerate boundary (duplicate points)');
  }
  const areaVector = relative.reduce<Point3D>((sum, p, i) => {
    const cross = vecCross(p, relative[(i + 1) % relative.length]);
    return sum.map((v, j) => v + cross[j]) as Point3D;
  }, [0, 0, 0]);
  if (vecLen(areaVector) <= tolerance * scale) throw new Error('Structural Face: degenerate boundary (zero area)');
  return { origin, relative, axis };
}

/** A fresh, exclusively owned topology subgraph for each surface product. */
export function emitStructuralFace(editor: StoreEditor, anchor: SpatialAnchor, face: ReturnType<typeof prepareStructuralFace>) {
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
