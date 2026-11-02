/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The finished scene on a primary cache hit (`perf.sceneSnapshot`). A hit whose
 * entry holds a snapshot draws the complete model before its metadata decodes,
 * then attaches the decoded meshes with no upload. Any other hit streams as
 * before, and leaves a snapshot behind for the next one.
 */

import { BufferReader, readInstancedShards, SectionType, type openGeometryChunksV13 } from '@ifc-lite/cache';
import { decodeSceneSnapshot, encodeSceneSnapshot, type Renderer, type SceneContents, type SceneSnapshot } from '@ifc-lite/renderer';
import { decodeInstancedShard, type CoordinateInfo, type MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { useViewerStore } from '../store/index.js';
import { noteInstancedShardModel } from '../store/instancedShardModels.js';
import { fitCameraToSnapshot, lastFinalFitBounds, sceneSnapshotKey, type SnapshotCameraFit, setPendingSceneSnapshot, withdrawPendingSceneSnapshot } from '../components/viewer/sceneSnapshotOwnership.js';
import { readPerfFlag } from '../lib/perf/flags.js';
import { recordFirstVisible } from '../lib/perf/loadTrace.js';
import { clearSceneSnapshot, putSceneSnapshot, type CacheResult } from '../services/cacheService.js';
import { isQuantizedEnabled } from '../utils/quantizedConfig.js';
import { getGlobalRenderer } from './useBCF.js';
import type { DecodedCacheMetadata } from './ifcCacheDecode.js';

/** What the viewer stores beside the batches: the fit they were finalized under, and where the shards are. */
interface SnapshotHostData extends SnapshotCameraFit {
  shards: { offset: number; size: number } | null;
}

export interface AdoptedSceneSnapshot {
  adoption: object;
  shards: ArrayBuffer[];
  fit: SnapshotCameraFit;
  firstVisible: Promise<void>;
}

/** Same spellings as every other boolean perf flag: the URL reads as a number, a console global as either. */
function snapshotsEnabled(): boolean {
  const raw = readPerfFlag('sceneSnapshot');
  return raw === 1 || raw === true;
}

function snapshotKey(scene: SceneContents): string {
  const { typeVisibility, typeViewMode } = useViewerStore.getState();
  return sceneSnapshotKey(scene.sceneSnapshotPolicy(), typeViewMode, typeVisibility);
}

/** Level display moves pieces at arrival, so the batches would not be the cached geometry. */
function sceneMatchesCachedGeometry(): boolean {
  return useViewerStore.getState().appliedEntityLevelOffsets.size === 0;
}

async function readSnapshotShards(entry: Blob, shards: SnapshotHostData['shards']): Promise<ArrayBuffer[]> {
  if (!shards) return [];
  return readInstancedShards(new BufferReader(await entry.slice(shards.offset, shards.offset + shards.size).arrayBuffer()));
}

/** A load mounts the viewport, so a first file can reach its hit while the renderer is still starting. */
async function rendererReady(isStale: (() => boolean) | undefined, timeoutMs = 3000): Promise<Renderer | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const renderer = getGlobalRenderer();
    if (renderer?.getGPUDevice() && renderer.getPipeline()) return renderer;
    if (isStale?.() || performance.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

/** Direct, unlike a stream's store-queued shards: the first frame is complete, and an abandoned adoption can remove them. */
function uploadSnapshotShards(scene: SceneContents, device: GPUDevice, modelId: string, shards: ArrayBuffer[]): void {
  if (shards.length > 0) noteInstancedShardModel(modelId);
  for (const bytes of shards) {
    try {
      const shard = decodeInstancedShard(new Uint8Array(bytes));
      if (shard) scene.addInstancedShard(device, shard, 0);
    } catch (err) {
      console.warn('[useIfcCache] snapshot shard upload failed (device lost?), skipping:', err);
    }
  }
}

/** Draw the entry's finished scene, or return null so the hit streams. */
export async function adoptCachedSceneSnapshot(
  cacheResult: CacheResult,
  modelId: string,
  isStale: (() => boolean) | undefined,
  trace: LoadTrace,
): Promise<AdoptedSceneSnapshot | null> {
  const { sceneSnapshot, sceneSnapshotKey, buffer: entry } = cacheResult;
  if (!snapshotsEnabled() || !sceneSnapshot || !(entry instanceof Blob) || !sceneMatchesCachedGeometry()) return null;
  const renderer = await rendererReady(isStale);
  const device = renderer?.getGPUDevice();
  const pipeline = renderer?.getPipeline();
  if (!renderer || !device || !pipeline) return null;
  const scene = renderer.getScene();
  // Admission is asynchronous after viewport init, and a reload can get here first.
  if (snapshotKey(scene) !== sceneSnapshotKey && isQuantizedEnabled()) await renderer.enableQuantizedBatches();
  if (snapshotKey(scene) !== sceneSnapshotKey) return null;
  const bytes = await trace.span('cache.snapshotRead', () => sceneSnapshot.arrayBuffer());
  const snapshot = decodeSceneSnapshot(bytes);
  const host = snapshot?.hostData as SnapshotHostData | undefined;
  if (!snapshot || !host?.fitBounds || !host.sceneBounds || isStale?.()) return null;
  const shards = await readSnapshotShards(entry, host.shards);
  if (isStale?.()) return null;
  const adoption = trace.span('scene.snapshotAdopt', () => scene.adoptSceneSnapshot(snapshot, device, pipeline), { batches: snapshot.batches.length });
  if (!adoption) return null;
  trace.milestone('scene.snapshotAdopted');
  uploadSnapshotShards(scene, device, modelId, shards);
  const camera = renderer.getCamera();
  camera.reset();
  fitCameraToSnapshot(renderer, host);
  renderer.clearCaches();
  renderer.requestRender();
  return { adoption, shards, fit: host, firstVisible: recordFirstVisible(trace, trace.milestone('geometry.firstAppend')) };
}

/** Decode every mesh and publish it; Scene sync hydrates the adopted batches with what it receives. */
export async function publishAdoptedSceneMeshes(
  adopted: AdoptedSceneSnapshot,
  open: ReturnType<typeof openGeometryChunksV13>,
  modelId: string,
  cacheResult: CacheResult,
  cacheKey: string | undefined,
  isStale: (() => boolean) | undefined,
  append: (modelId: string, meshes: MeshData[], coordinateInfo?: CoordinateInfo) => void,
): Promise<MeshData[]> {
  const chunks = await Promise.all(open.chunks.map((_, i) => open.readChunk(i)));
  if (isStale?.()) return [];
  const meshes = chunks.flat();
  setPendingSceneSnapshot(adopted.adoption, () => {
    useViewerStore.getState().appendInstancedShards(modelId, adopted.shards);
    forgetRefusedSnapshot(cacheResult, cacheKey);
  }, adopted.fit);
  append(modelId, meshes, open.coordinateInfo);
  return meshes;
}

/** It would be refused on every open: drop it so the next hit streams and captures a new one. */
function forgetRefusedSnapshot({ createdAt, fullSourceHash }: CacheResult, cacheKey: string | undefined): void {
  if (!cacheKey || createdAt === undefined) return;
  void clearSceneSnapshot(cacheKey, { createdAt, fullSourceHash }).catch((err: unknown) => {
    console.warn('[useIfcCache] Refused scene snapshot was not cleared:', err);
  });
}

/** The load is over without serving its snapshot: the adopted batches must not outlive it. */
export function abandonAdoptedSceneSnapshot(adopted: AdoptedSceneSnapshot | null): void {
  if (!adopted) return;
  withdrawPendingSceneSnapshot(adopted.adoption);
  getGlobalRenderer()?.getScene().abandonSceneSnapshot(adopted.adoption);
}

/** Store the scene this hit is about to finalize, once it has. */
export async function captureSceneSnapshotOfHit(
  cacheResult: CacheResult,
  cacheKey: string | undefined,
  decoded: Pick<DecodedCacheMetadata, 'headerInfo'>,
  isStale: (() => boolean) | undefined,
): Promise<void> {
  const { createdAt, fullSourceHash, buffer: entry } = cacheResult;
  if (!snapshotsEnabled() || !cacheKey || createdAt === undefined || !(entry instanceof Blob) || !sceneMatchesCachedGeometry()) return;
  const renderer = await rendererReady(isStale);
  if (!renderer) return;
  // Batches built before admission stay f32, and a snapshot would keep them that way for good.
  if (isQuantizedEnabled()) await renderer.enableQuantizedBatches();
  if (isStale?.()) return;
  renderer.getScene().captureNextFinalize((snapshot: SceneSnapshot) => {
    const camera = renderer.getCamera();
    const sceneBounds = camera.getSceneBounds();
    const fitBounds = lastFinalFitBounds();
    const key = snapshotKey(renderer.getScene());
    if (isStale?.() || !sceneBounds || !fitBounds || !sceneMatchesCachedGeometry()) return;
    const section = decoded.headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
    const hostData: SnapshotHostData = { fitBounds, sceneBounds, orbitAnchorBounds: camera.getOrbitAnchorBounds(),
      shards: section ? { offset: section.offset, size: section.size } : null };
    // Off the finalize's completion, which the first frame of the finished scene waits on.
    setTimeout(() => {
      void putSceneSnapshot(cacheKey, { createdAt, fullSourceHash }, encodeSceneSnapshot({ ...snapshot, hostData }), key).catch((err: unknown) => {
        console.warn('[useIfcCache] Scene snapshot was not stored:', err);
      });
    }, 0);
  });
}
