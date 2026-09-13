/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { modelAppearanceAssets } from '../model-assets';
import { getPointCloudScanSample } from '@/hooks/ingest/pointCloudScanCache';
import { samePointSource, snapshotPointSource, type ScanPointSource } from './point-source';

/** Which capture of a loaded model is the alignment source: one textured GLB
 * surface by mesh ordinal, or the model's streamed RGB point cloud (#4381). */
export type ScanSourceSelector = number | 'points';
export type ScanSource =
  | { kind: 'mesh'; mesh: MeshData; meshOrdinal: number; assetId: string }
  | { kind: 'points'; points: ScanPointSource };

/** One immutable capture snapshot plus the checks that pin it: each source
 * kind owns its own admission rules, frame key and staleness test, so the
 * session never reasons about a mesh's fields while holding points. */
export interface ScanSourceSnapshot {
  source: ScanSource;
  frameKey(sourceHash: string): string;
  /** Throws when the live model no longer carries exactly this capture. */
  validate(current: FederatedModel | undefined): void;
}
const CHANGED = 'The scan, IFC model or coordinate frame changed. Restart alignment.';
function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function snapshotScanSource(model: FederatedModel, sourceModelId: string, selector: ScanSourceSelector): ScanSourceSnapshot {
  return selector === 'points' ? snapshotPointsSource(model) : snapshotMeshSource(model, sourceModelId, selector);
}
/** The decoded GLB scene's surface, never a placed view copy. */
function snapshotMeshSource(model: FederatedModel, sourceModelId: string, ordinal: number): ScanSourceSnapshot {
  const file = model.sourceFile, mesh = model.geometryResult?.meshes[ordinal];
  if (!file || !/\.glb$/i.test(file.name) || !mesh?.textureRef || !mesh.uvs) throw new Error('Choose a loaded textured GLB surface and an editable IFC destination.');
  if (mesh.indices.length / 3 > 200_000 || mesh.positions.length / 3 > 200_000 || file.size > 128 * 1024 * 1024) throw new Error('Choose a source surface below 200,000 triangles/vertices and source files below 128 MiB.');
  const { positions, indices, uvs } = mesh;
  const snapshot: MeshData = { ...mesh, positions: positions.slice(), indices: indices.slice(), normals: mesh.normals.slice(), uvs: uvs.slice(), origin: mesh.origin?.slice() as MeshData['origin'] };
  const color = [...mesh.color], textureRef = { ...mesh.textureRef }, origin = mesh.origin?.slice();
  const assetId = modelAppearanceAssets.resolveImageAsset(sourceModelId, textureRef.url);
  return {
    source: { kind: 'mesh', mesh: snapshot, meshOrdinal: ordinal, assetId },
    frameKey: sourceHash => `glb-scene-y-up-metres-v1:${sourceHash}:${ordinal}`,
    validate(current) {
      if (current?.geometryResult?.meshes[ordinal] !== mesh
        || mesh.positions !== positions || mesh.indices !== indices || mesh.uvs !== uvs
        || !mesh.color.every((v, i) => v === color[i]) || mesh.textureRef?.url !== textureRef.url
        || mesh.textureRef.repeatS !== textureRef.repeatS || mesh.textureRef.repeatT !== textureRef.repeatT
        || !equal(positions, snapshot.positions) || !equal(indices, snapshot.indices) || !equal(uvs, snapshot.uvs!)
        || (origin ? !mesh.origin || !equal(mesh.origin, origin) : mesh.origin !== undefined)
        || modelAppearanceAssets.resolveImageAsset(sourceModelId, mesh.textureRef.url) !== assetId) throw new Error(CHANGED);
    },
  };
}
/** The ingest's retained reservoir sample of a completely streamed point cloud. */
function snapshotPointsSource(model: FederatedModel): ScanSourceSnapshot {
  const file = model.sourceFile, handleId = model.pointCloudHandleId;
  if (!file || handleId === undefined || model.loadState === 'error') throw new Error('Choose a completely streamed point cloud (LAS, LAZ, E57, PLY, PCD, PTS or XYZ).');
  if (file.size > 1024 * 1024 * 1024) throw new Error('Choose a point-cloud source below 1 GiB so its identity can be hashed.');
  const retained = getPointCloudScanSample(handleId);
  if (!retained) throw new Error('The point cloud kept no retained sample. Reload it before aligning.');
  const points = snapshotPointSource(handleId, retained);
  return {
    source: { kind: 'points', points },
    frameKey: sourceHash => `pointcloud-native-z-up-metres-v1:${sourceHash}`,
    validate(current) {
      if (current?.pointCloudHandleId !== handleId || !samePointSource(points, getPointCloudScanSample(handleId))) throw new Error(CHANGED);
    },
  };
}
