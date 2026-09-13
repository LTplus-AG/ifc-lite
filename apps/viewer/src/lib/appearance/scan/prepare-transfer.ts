/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { AppearanceAssetOwner } from '../assets';
import type { AppearancePlanner } from '../planner-worker-client';
import { prepareAppearanceRasterPayload } from '../raster-payload';
import { adoptBakedImages } from '../baked-images';
import type { ScanSession, ScanSource } from './session';
import type { ScanPoint, ScanRegistrationRequest, ScanRegistrationReport } from './types';
import type { MeshTransferRequest, TransferSourceMesh, TransferSourcePoints } from './transfer-types';
import { targetTransferFrame } from './transfer-frame';
import { pointSourceOrientation, pointTransferPayload } from './point-source';

export interface ScanTransferSettings {
  toleranceMetres: number; reviewed: boolean; texelsPerMetre: number;
  maxDistanceMetres: number; minNormalDot: number; ambiguityDistanceMetres: number; maxBehindMetres: number;
  /** Point-cloud sources only: local plane support around the nearest point and its accepted thickness (#4381). */
  neighborhoodRadiusMetres: number; minNeighbors: number; maxNeighbors: number; surfaceBandMetres: number;
}
export function validateTransferReview(result: { request: ScanRegistrationRequest; report: ScanRegistrationReport }, settings: ScanTransferSettings): void {
  if (result.request.fit.length < 4 || result.request.heldOut.length < 4) throw new Error('Choose at least four fit and four independent check points before transfer.');
  if (!Number.isFinite(settings.toleranceMetres) || settings.toleranceMetres <= 0) throw new Error('Enter a positive project tolerance in metres.');
  if (!settings.reviewed) throw new Error('Review the landmark spread and individual errors before transferring appearance.');
  const { fit, heldOut, sourceSpread, targetSpread } = result.report;
  if (fit.maxMetres === null || heldOut.maxMetres === null || fit.maxMetres > settings.toleranceMetres || heldOut.maxMetres > settings.toleranceMetres) throw new Error('A fit or check error exceeds the chosen project tolerance. Correct the landmarks before transferring appearance.');
  if (!Number.isFinite(sourceSpread.nonCollinearityRatio) || !Number.isFinite(targetSpread.nonCollinearityRatio)
    || sourceSpread.nonCollinearityRatio <= 0 || targetSpread.nonCollinearityRatio <= 0) throw new Error('Landmark spread is not valid for transfer.');
}
/** The request's source description; the mesh path admits only an opaque, untinted textured GLB surface. */
export function transferSource(source: ScanSource, settings: ScanTransferSettings): { source: TransferSourceMesh | TransferSourcePoints; repeat: [boolean, boolean] } {
  if (source.kind === 'points') {
    const { points } = source;
    if (!Number.isFinite(settings.neighborhoodRadiusMetres) || settings.neighborhoodRadiusMetres <= 0 || settings.neighborhoodRadiusMetres > 0.5
      || !Number.isFinite(settings.surfaceBandMetres) || settings.surfaceBandMetres <= 0 || settings.surfaceBandMetres > settings.neighborhoodRadiusMetres
      || !Number.isInteger(settings.minNeighbors) || settings.minNeighbors < 3 || !Number.isInteger(settings.maxNeighbors) || settings.maxNeighbors < settings.minNeighbors || settings.maxNeighbors > 256) throw new Error('Point fit needs a support radius within 0.5 m, a surface band within it and 3..256 neighbours.');
    // Mirrors the planner's index bound so the refusal is read here, not after
    // the payload has crossed into the worker.
    if (settings.maxDistanceMetres > 16 * settings.neighborhoodRadiusMetres) throw new Error('Keep the maximum scan distance within 16 support radii.');
    const orientation = pointSourceOrientation(points);
    return { repeat: [false, false], source: { kind: 'points', pointCount: points.count, orientation,
      neighborhoodRadiusMetres: settings.neighborhoodRadiusMetres, minNeighbors: settings.minNeighbors, maxNeighbors: settings.maxNeighbors,
      surfaceBandMetres: settings.surfaceBandMetres, viewpoints: [] } };
  }
  const { mesh, meshOrdinal } = source;
  if (mesh.color.some(value => Math.fround(value) !== 1) || !mesh.uvs || !mesh.textureRef || mesh.entityIds || mesh.geometryClass === 2) throw new Error('Transfer needs one opaque, untinted textured GLB surface. Bake material factors into its image first.');
  const count = mesh.positions.length / 3;
  if (!Number.isInteger(count) || count > 200_000 || mesh.indices.length / 3 > 200_000 || mesh.uvs.length !== count * 2) throw new Error('The scan surface exceeds the transfer geometry budget.');
  const origin = mesh.origin ?? [0, 0, 0];
  return { repeat: [mesh.textureRef.repeatS, mesh.textureRef.repeatT], source: { kind: 'mesh', meshOrdinal,
    positions: Array.from({ length: count }, (_, i): ScanPoint => [mesh.positions[i * 3] + origin[0], mesh.positions[i * 3 + 1] + origin[1], mesh.positions[i * 3 + 2] + origin[2]]),
    triangles: Array.from({ length: mesh.indices.length / 3 }, (_, i): ScanPoint => [mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2]]),
    uvs: Array.from({ length: count }, (_, i): [number, number] => [mesh.uvs![i * 2], mesh.uvs![i * 2 + 1]]),
    baseColorFactor: [1, 1, 1, 1], repeatS: mesh.textureRef.repeatS, repeatT: mesh.textureRef.repeatT } };
}

export async function prepareMeshTransfer(session: ScanSession,
  registration: { request: ScanRegistrationRequest; report: ScanRegistrationReport }, productIds: readonly number[],
  settings: ScanTransferSettings, planner: AppearancePlanner, owner: AppearanceAssetOwner, signal: AbortSignal) {
  session.validate(); signal.throwIfAborted(); validateTransferReview(registration, settings);
  if (!productIds.length || productIds.length > 10_000) throw new Error('Choose 1..10000 explicit IFC target objects.');
  if (JSON.stringify(registration.request.sourceFrame) !== JSON.stringify(session.sourceFrame)
    || JSON.stringify(registration.request.targetFrame) !== JSON.stringify(session.targetFrame)) throw new Error('The alignment belongs to an older IFC snapshot. Revalidate it before transfer.');
  const { source } = transferSource(session.source, settings);
  const targetState = useViewerStore.getState(), selected = new Set(productIds.map(id => targetState.toGlobalId(session.targetModelId, id)));
  for (const piece of targetState.models.get(session.targetModelId)?.geometryResult?.meshes ?? []) {
    if (selected.has(piece.expressId)) session.retainTargetMesh(piece);
  }
  const assetId = session.source.kind === 'mesh' ? session.source.assetId : null;
  const pixels = await prepareAppearanceRasterPayload(session.targetModelId, productIds, assetId, owner, signal, session.validate);
  session.validate();
  const request: MeshTransferRequest = {
    schema: session.schema, sourceRevision: session.revision, nextExpressId: session.nextExpressId, productIds: [...productIds],
    registration: registration.request, registrationSha256: registration.report.requestSha256,
    targetFromIfcWorld: targetTransferFrame(useViewerStore.getState(), session.targetModelId), source,
    ...(source.kind === 'mesh' && pixels.sourceImage ? { sourceImage: pixels.sourceImage } : {}), sourceImages: pixels.sourceImages,
    texelsPerMetre: settings.texelsPerMetre, maxDistanceMetres: settings.maxDistanceMetres,
    minNormalDot: settings.minNormalDot, ambiguityDistanceMetres: settings.ambiguityDistanceMetres, maxBehindMetres: settings.maxBehindMetres,
  };
  const output = session.source.kind === 'points'
    ? await planner.pointTransfer(session.bytes, request, pixels.rgba, { ...pointTransferPayload(session.source.points), stations: new Uint32Array(0) }, { signal })
    : await planner.meshTransfer(session.bytes, request, pixels.rgba, { signal });
  session.validate(); signal.throwIfAborted();
  const images = await adoptBakedImages(session.targetModelId, output, owner, signal);
  session.validate();
  return { ...output, ...images };
}
