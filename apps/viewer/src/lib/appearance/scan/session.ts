/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { computeFullSourceHash, computeFullSourceHashFromBlob } from '@/utils/sourceContentHash';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { captureAppearanceSource } from '../command';
import { prepareAppearanceSerialization } from '../serialization';
import { modelAppearanceAssets } from '../model-assets';
import type { ScanFrame } from './types';

export interface ScanSession {
  sourceModelId: string; targetModelId: string; sourceMeshOrdinal: number;
  source: MeshData; assetId: string;
  sourceFrame: ScanFrame; targetFrame: ScanFrame;
  retainTargetMesh(mesh: MeshData): void;
  validate(): void;
}
function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** The source is an immutable decoded GLB-scene snapshot, not a placed view copy. */
export async function prepareScanSession(sourceModelId: string, meshOrdinal: number, targetModelId: string, signal: AbortSignal): Promise<ScanSession> {
  const initial = useViewerStore.getState(), model = initial.models.get(sourceModelId), target = initial.models.get(targetModelId);
  const mesh = model?.geometryResult?.meshes[meshOrdinal], view = initial.mutationViews.get(targetModelId);
  if (!model?.sourceFile || !/\.glb$/i.test(model.sourceFile.name) || !mesh?.textureRef || !mesh.uvs
    || !target?.ifcDataStore || !view || sourceModelId === targetModelId) throw new Error('Choose a loaded textured GLB surface and an editable IFC destination.');
  if (mesh.indices.length / 3 > 200_000 || mesh.positions.length / 3 > 200_000
    || model.sourceFile.size > 128 * 1024 * 1024 || target.ifcDataStore.source.byteLength > 128 * 1024 * 1024) throw new Error('Choose a source surface below 200,000 triangles/vertices and source files below 128 MiB.');
  if (initial.modelPlacement.preview || initial.collabRoomId) throw new Error('Finish repositioning and leave the shared room before aligning a scan.');
  const positions = mesh.positions, indices = mesh.indices, uvs = mesh.uvs;
  const source: MeshData = { ...mesh, positions: positions.slice(), indices: indices.slice(), normals: mesh.normals.slice(), uvs: uvs.slice(), origin: mesh.origin?.slice() as MeshData['origin'] };
  const origin = mesh.origin?.slice(), frame = placementFrameKey(initial), placement = initial.modelPlacement;
  const assetId = modelAppearanceAssets.resolveImageAsset(sourceModelId, mesh.textureRef.url);
  new StoreEditor(target.ifcDataStore, view);
  const guard = captureAppearanceSource(view);
  const targetMeshes = new Map<MeshData, { positions: Float32Array; indices: Uint32Array; origin?: MeshData['origin'] }>();
  let retainedVertices = 0, retainedTriangles = 0;
  const retainTargetMesh = (piece: MeshData) => {
    if (targetMeshes.has(piece)) return;
    if (!target.geometryResult?.meshes.includes(piece)) throw new Error('The IFC surface is no longer part of the chosen model.');
    if (retainedVertices + piece.positions.length / 3 > 200_000 || retainedTriangles + piece.indices.length / 3 > 200_000) throw new Error('Landmarks span too much target geometry. Use IFC objects totalling at most 200,000 triangles and vertices.');
    targetMeshes.set(piece, { positions: piece.positions.slice(), indices: piece.indices.slice(), origin: piece.origin?.slice() as MeshData['origin'] });
    retainedVertices += piece.positions.length / 3; retainedTriangles += piece.indices.length / 3;
  };
  const validate = () => {
    signal.throwIfAborted();
    const now = useViewerStore.getState();
    if (now.models.get(sourceModelId) !== model || now.models.get(targetModelId) !== target
      || now.mutationVersion !== initial.mutationVersion || now.modelPlacement !== placement || placementFrameKey(now) !== frame
      || now.collabRoomId || now.modelPlacement.preview || model.geometryResult?.meshes[meshOrdinal] !== mesh
      || mesh.positions !== positions || mesh.indices !== indices || mesh.uvs !== uvs
      || !equal(positions, source.positions) || !equal(indices, source.indices) || !equal(uvs, source.uvs!)
      || (origin ? !mesh.origin || !equal(mesh.origin, origin) : mesh.origin !== undefined)
      || modelAppearanceAssets.resolveImageAsset(sourceModelId, mesh.textureRef!.url) !== assetId) throw new Error('The scan, IFC model or coordinate frame changed. Restart alignment.');
    guard.validate(now.mutationViews.get(targetModelId));
    for (const [piece, snapshot] of targetMeshes) {
      if (!target.geometryResult?.meshes.includes(piece) || !equal(piece.positions, snapshot.positions) || !equal(piece.indices, snapshot.indices)
        || (snapshot.origin ? !piece.origin || !equal(piece.origin, snapshot.origin) : piece.origin !== undefined)) throw new Error('A paired IFC surface changed. Restart alignment.');
    }
  };
  validate();
  const sourceHash = await computeFullSourceHashFromBlob(model.sourceFile); validate();
  if (!target.schemaVersion.startsWith('IFC4')) throw new Error('Choose an IFC4 or IFC4X3 destination.');
  const serialized = prepareAppearanceSerialization(targetModelId, target.ifcDataStore, view);
  const exported = await new StepExporter(target.ifcDataStore, serialized.view).exportAsync({ schema: target.schemaVersion.startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4', applyMutations: true, includeGeometry: true, visibleOnly: false, onProgress: validate });
  validate();
  const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
  const targetHash = await computeFullSourceHash(bytes);
  const frameHash = await computeFullSourceHash(new TextEncoder().encode(JSON.stringify({ frame, placement: [...placement.placements], revision: placement.revision, targetModelId })));
  validate();
  if (!sourceHash || !targetHash || !frameHash) throw new Error('Secure content hashing is unavailable. Open the viewer in a secure browser context.');
  return { sourceModelId, targetModelId, sourceMeshOrdinal: meshOrdinal, source, assetId, retainTargetMesh,
    sourceFrame: { assetSha256: sourceHash, frameKey: `glb-scene-y-up-metres-v1:${sourceHash}:${meshOrdinal}` },
    targetFrame: { assetSha256: targetHash, frameKey: `workspace-ifc-z-up-metres:${frameHash}` }, validate };
}
