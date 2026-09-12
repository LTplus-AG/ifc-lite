/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { computeFullSourceHash, computeFullSourceHashFromBlob } from '@/utils/sourceContentHash';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { appearanceRevision, captureAppearanceSource } from '../command';
import { prepareAppearanceSerialization } from '../serialization';
import { scanTargetGlobalId } from './landmarks';
import { sameLandmarkGeometry } from './geometry-proof';
import { snapshotScanSource, type ScanSource, type ScanSourceSelector } from './session-source';
import type { ScanFrame } from './types';

export type { ScanSource, ScanSourceSelector } from './session-source';
export interface ScanSession {
  sourceModelId: string; targetModelId: string; selector: ScanSourceSelector;
  source: ScanSource;
  sourceFrame: ScanFrame; targetFrame: ScanFrame;
  bytes: Uint8Array; schema: 'IFC4' | 'IFC4X3'; revision: string; nextExpressId: number;
  appearanceSource: ReturnType<typeof captureAppearanceSource>;
  retainTargetMesh(mesh: MeshData): void;
  afterAppearance(): (next: ScanSession) => void;
  validate(): void;
}
function equal(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** The source is an immutable snapshot (decoded GLB scene, or the retained
 * point sample), never a placed view copy. */
export async function prepareScanSession(sourceModelId: string, selector: ScanSourceSelector, targetModelId: string, signal: AbortSignal): Promise<ScanSession> {
  const initial = useViewerStore.getState(), model = initial.models.get(sourceModelId), target = initial.models.get(targetModelId);
  const view = target?.ifcDataStore && !/\.glb$/i.test(target.sourceFile?.name ?? '') ? getOrCreateMutationView(useViewerStore, targetModelId) : null;
  if (!model?.sourceFile || !target?.ifcDataStore || !view || sourceModelId === targetModelId) throw new Error('Choose a loaded textured GLB surface or point cloud and an editable IFC destination.');
  if (target.ifcDataStore.source.byteLength > 128 * 1024 * 1024) throw new Error('Choose a destination IFC below 128 MiB.');
  if (initial.modelPlacement.preview || initial.collabRoomId) throw new Error('Finish repositioning and leave the shared room before aligning a scan.');
  const snapshot = snapshotScanSource(model, sourceModelId, selector);
  const frame = placementFrameKey(initial), placement = initial.modelPlacement;
  new StoreEditor(target.ifcDataStore, view);
  const guard = captureAppearanceSource(view), revision = appearanceRevision(targetModelId), nextExpressId = view.peekNextExpressId();
  const schema = target.schemaVersion.startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4';
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
    if (now.sectionPlane.enabled || (now.cesiumEnabled && now.cesiumTerrainClipY !== null) || getGlobalRenderer()?.hasActiveClipping()) throw new Error('Turn off section, terrain and box clipping before picking scan alignment landmarks.');
    const currentSource = now.models.get(sourceModelId), currentTarget = now.models.get(targetModelId);
    if (currentSource?.sourceFile !== model.sourceFile || currentSource?.geometryResult !== model.geometryResult
      || currentTarget?.ifcDataStore !== target.ifcDataStore || currentTarget?.geometryResult !== target.geometryResult
      || now.mutationVersion !== initial.mutationVersion || now.modelPlacement !== placement || placementFrameKey(now) !== frame
      || now.collabRoomId || now.modelPlacement.preview) throw new Error('The scan, IFC model or coordinate frame changed. Restart alignment.');
    snapshot.validate(currentSource);
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
  const exported = await new StepExporter(target.ifcDataStore, serialized.view).exportAsync({ schema, applyMutations: true, includeGeometry: true, visibleOnly: false, onProgress: validate });
  validate();
  const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
  const targetHash = await computeFullSourceHash(bytes);
  const frameHash = await computeFullSourceHash(new TextEncoder().encode(JSON.stringify({ frame, placement: [...placement.placements], revision: placement.revision, targetModelId })));
  validate();
  if (!sourceHash || !targetHash || !frameHash) throw new Error('Secure content hashing is unavailable. Open the viewer in a secure browser context.');
  const sourceFrameKey = snapshot.frameKey(sourceHash);
  return { sourceModelId, targetModelId, selector, source: snapshot.source, retainTargetMesh, afterAppearance() {
      validate();
      const paired = [...targetMeshes].map(([piece, saved]) => ({ guid: scanTargetGlobalId(piece.expressId), ordinal: target.geometryResult!.meshes.indexOf(piece), mesh: { ...piece, positions: saved.positions, indices: saved.indices, origin: saved.origin } }));
      const untouched = target.geometryResult!.meshes.map((piece, ordinal) => ({ piece, ordinal })).filter(({ piece }) => !targetMeshes.has(piece));
      return next => {
        const now = useViewerStore.getState();
        if (next.sourceModelId !== sourceModelId || next.targetModelId !== targetModelId
          || next.sourceFrame.assetSha256 !== sourceHash || next.sourceFrame.frameKey !== sourceFrameKey
          || next.targetFrame.frameKey !== `workspace-ifc-z-up-metres:${frameHash}`
          || now.models.get(targetModelId)?.ifcDataStore !== target.ifcDataStore) throw new Error('Geometry or coordinate frames changed. Restart alignment.');
        const current = now.models.get(targetModelId)?.geometryResult?.meshes ?? [];
        if (untouched.some(({ piece, ordinal }) => current[ordinal] !== piece) || current.length !== target.geometryResult!.meshes.length) throw new Error('Unrelated IFC geometry changed. Restart alignment.');
        for (const previous of paired) {
          const match = current[previous.ordinal];
          if (!match || scanTargetGlobalId(match.expressId) !== previous.guid || !sameLandmarkGeometry(previous.mesh, match)) throw new Error('A paired IFC surface changed. Restart alignment.');
          next.retainTargetMesh(match);
        }
        next.validate();
      };
    }, bytes, schema, revision, nextExpressId, appearanceSource: guard,
    sourceFrame: { assetSha256: sourceHash, frameKey: sourceFrameKey },
    targetFrame: { assetSha256: targetHash, frameKey: `workspace-ifc-z-up-metres:${frameHash}` }, validate };
}
