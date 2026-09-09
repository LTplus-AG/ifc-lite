/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Raycaster, type Renderer, type Intersection } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { resolveEntityRef, useViewerStore } from '@/store';
import { placedMesh } from '@/lib/model-placement/placed-geometry';
import { placementFor } from '@/lib/model-placement/state';
import { placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { fromRenderTranslation } from '@/lib/model-placement/translation';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import type { ScanSession } from './session';
import type { ScanLandmark, ScanPoint, ScanRegistrationReport } from './types';

/** Raycaster weights are A:w, B:u, C:v (Möller–Trumbore convention). */
export function sourceLandmark(mesh: MeshData, hit: Intersection, meshOrdinal: number): ScanLandmark {
  const triangle = hit.triangleIndex, weights: ScanPoint = [hit.barycentricCoord.w, hit.barycentricCoord.u, hit.barycentricCoord.v];
  if (!Number.isInteger(triangle) || triangle < 0 || triangle * 3 + 2 >= mesh.indices.length) throw new Error('The picked scan triangle is no longer available.');
  const point: ScanPoint = [0, 0, 0];
  for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) point[axis] += mesh.positions[mesh.indices[triangle * 3 + corner] * 3 + axis] * weights[corner];
  for (let axis = 0; axis < 3; axis++) point[axis] += mesh.origin?.[axis] ?? 0;
  return { point, triangle, barycentric: weights, observation: `surface:${meshOrdinal}:triangle:${triangle}:bary:${weights.join(',')}` };
}

/** Resolve the visible owner, then query its retained raw pieces in stable order.
 * A BVH-filtered renderer meshIndex is not an original source-piece identity. */
export function targetLandmark(session: ScanSession, renderer: Renderer, x: number, y: number): { point: ScanPoint; feature: string } {
  session.validate();
  const state = useViewerStore.getState();
  const visible = renderer.raycastScene(x, y, { hiddenIds: state.hiddenEntities, isolatedIds: state.isolatedEntities });
  if (!visible) throw new Error('Pick a visible IFC surface.');
  const ref = resolveEntityRef(visible.intersection.expressId);
  if (ref.modelId !== session.targetModelId) throw new Error('Pick a surface in the chosen IFC model.');
  const target = state.models.get(ref.modelId)!;
  const raw = target.geometryResult?.meshes.filter(mesh => mesh.expressId === visible.intersection.expressId) ?? [];
  if (!raw.length || raw.some(mesh => mesh.entityIds || (mesh.geometryClass ?? 0) === 2)
    || raw.reduce((n, mesh) => n + mesh.indices.length / 3, 0) > 200_000) throw new Error('Choose an IFC object with at most 200,000 retained concrete triangles.');
  const canvas = renderer.getCanvas();
  const ray = renderer.getCamera().unprojectToRay(x * canvas.width / canvas.clientWidth, y * canvas.height / canvas.clientHeight, canvas.width, canvas.height);
  const meshes = raw.map(mesh => placedMesh(mesh, placementFor(state.modelPlacement, ref.modelId).translation));
  const hit = new Raycaster().raycast(ray, meshes);
  if (!hit || Math.hypot(hit.point.x - visible.intersection.point.x, hit.point.y - visible.intersection.point.y, hit.point.z - visible.intersection.point.z) > 1e-4) throw new Error('The picked surface changed. Pick again.');
  const guid = target.ifcDataStore?.entities.getGlobalId(ref.expressId);
  if (!guid) throw new Error('The IFC object needs a stable GlobalId.');
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  const point = fromRenderTranslation({ x: hit.point.x + offset.x, y: hit.point.y + offset.y, z: hit.point.z + offset.z });
  const mesh = raw[hit.meshIndex];
  const weights = hit.barycentricCoord;
  session.retainTargetMesh(mesh);
  session.validate();
  return { point: [...point], feature: `${guid}:piece:${hit.meshIndex}:item:${mesh.geometryItemId ?? 'body'}:triangle:${hit.triangleIndex}:bary:${weights.w},${weights.u},${weights.v}` };
}

/** Evaluate the native fitted transform. This performs no fitting or solving. */
export function registeredPoint(report: ScanRegistrationReport, point: ScanPoint): ScanPoint {
  const delta = point.map((v, i) => v - report.sourceAnchor[i]);
  return report.targetAnchor.map((v, i) => v + report.rotation[i].reduce((sum, value, j) => sum + value * delta[j], 0)) as ScanPoint;
}
