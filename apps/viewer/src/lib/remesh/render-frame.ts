/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Take re-meshed meshes from the worker's frame to the frame their model's
 * load-time meshes live in (#6232 WP1).
 *
 * The worker already meshed in the model's RTC frame, so what is left are
 * the steps the load path applies after meshing, in the same order:
 *
 *  1. the federation id offset (`applyFederationOffsetToMesh`, as at
 *     finalize), so express ids are global;
 *  2. the JS origin shift, when the load needed one on top of the wasm RTC
 *     (`CoordinateHandler.shiftPositions`, same outlier rule);
 *  3. for a model the federation re-aligned onto another model's CRS
 *     ('same-crs' / 'reprojected'), the same `alignGeometryToReference` the
 *     load ran, from the model's pre-alignment frame. The pre-alignment
 *     copies are returned so the model's snapshot stays restorable.
 *
 * A model-placement rotation is NOT applied here: the rotation baker bakes
 * appended meshes on its next reconcile, exactly as for a streamed batch.
 */

import { CoordinateHandler, type CoordinateInfo, type MeshData, type RtcFrame } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { applyFederationOffsetToMesh } from '@/hooks/ingest/federationOffset';
import type { PreAlignmentMeshBaseline } from '@/store/slices/data-mesh-prealign';
import type { GeorefMutationDataLike } from '@/lib/geo/effective-georef';

/** The frame the model's meshes were produced in, before any federation alignment. */
export function sourceCoordinateInfo(model: FederatedModel): CoordinateInfo | undefined {
  return model.preAlignment?.coordinateInfo ?? model.geometryResult?.coordinateInfo;
}

/** The RTC frame the model was meshed in on load, or null when it was not a wasm mesh load. */
export function loadRtcFrame(model: FederatedModel): RtcFrame | null {
  return sourceCoordinateInfo(model)?.wasmRtcFrame ?? null;
}

export type RenderFrameResult =
  | { ok: true; meshes: MeshData[]; preAligned?: PreAlignmentMeshBaseline[] }
  | { ok: false; reason: 'alignment' };

const coordinateHandler = new CoordinateHandler();

function isZero(v: { x: number; y: number; z: number } | undefined): boolean {
  return !v || (v.x === 0 && v.y === 0 && v.z === 0);
}

/** Steps 1 and 2, in place. */
export function applyLoadFrame(meshes: MeshData[], model: FederatedModel): void {
  const shift = sourceCoordinateInfo(model)?.originShift;
  for (const mesh of meshes) {
    applyFederationOffsetToMesh(mesh, model.idOffset);
    if (!isZero(shift)) coordinateHandler.shiftPositions(mesh.positions, shift!);
  }
}

export function baselineOf(mesh: MeshData): PreAlignmentMeshBaseline {
  return {
    positions: new Float32Array(mesh.positions),
    normals: mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined,
    origin: mesh.origin ? [...mesh.origin] : undefined,
    geometryAabb: mesh.geometryAabb,
  };
}

/** All three steps. Mutates `meshes`. */
export async function toRenderFrame(
  meshes: MeshData[],
  model: FederatedModel,
  store: IfcDataStore,
  georefMutations: GeorefMutationDataLike | undefined,
): Promise<RenderFrameResult> {
  applyLoadFrame(meshes, model);
  const status = model.federationAlignmentStatus;
  if (status !== 'same-crs' && status !== 'reprojected') return { ok: true, meshes };

  // Loaded on demand: it reads the viewer store, which imports the slices
  // that import this module, and only aligned federated models need it.
  const { alignGeometryToReference, extractModelSpatialPlacement, findReferenceSpatialModel } =
    await import('@/hooks/ingest/federationAlign');
  const info = sourceCoordinateInfo(model);
  const source = info ? extractModelSpatialPlacement(store, info, georefMutations) : null;
  const reference = findReferenceSpatialModel()?.placement ?? null;
  if (!model.preAlignment || !info || !source || !reference) return { ok: false, reason: 'alignment' };
  const preAligned = meshes.map(baselineOf);
  const staged = { meshes, coordinateInfo: structuredClone(info), totalTriangles: 0, totalVertices: 0 };
  const aligned = await alignGeometryToReference(staged, source, reference);
  if (aligned !== status) return { ok: false, reason: 'alignment' };
  return { ok: true, meshes: staged.meshes, preAligned };
}
