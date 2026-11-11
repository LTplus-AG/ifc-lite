/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The finished scene on a primary cache hit (kill switch `perf.sceneSnapshot=0`). A hit whose
 * entry holds a snapshot draws the complete model before its metadata decodes,
 * then attaches the decoded meshes with no upload. Any other hit streams as
 * before, and leaves a snapshot behind for the next one.
 */

import { BufferReader, readInstancedShards, SectionType, type openGeometryChunksV13 } from '@ifc-lite/cache';
import { decodeSceneSnapshot, type Renderer, type SceneContents, type SceneSnapshot } from '@ifc-lite/renderer';
import { decodeInstancedShard, type CoordinateInfo, type MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { useViewerStore } from '../store/index.js';
import { noteInstancedShardModel } from '../store/instancedShardModels.js';
import { fitCameraToSnapshot, lastFinalFitBounds, sceneSnapshotKey, type SnapshotCameraFit, setPendingColdCapture, setPendingSceneSnapshot, withdrawPendingColdCapture, withdrawPendingSceneSnapshot } from '../components/viewer/sceneSnapshotOwnership.js';
import { readPerfFlag } from '../lib/perf/flags.js';
import { recordFirstVisible } from '../lib/perf/loadTrace.js';
import { clearSceneSnapshot, type CacheResult } from '../services/cacheService.js';
import { isQuantizedEnabled } from '../utils/quantizedConfig.js';
import { getGlobalRenderer } from './useBCF.js';
import type { DecodedCacheMetadata } from './ifcCacheDecode.js';
import { writeCapturedScene, type CapturedScene, type SnapshotEntry } from './sceneSnapshotWrite.js';

/** What the viewer stores beside the batches (sceneSnapshotWrite.ts): the fit they were finalized under, and where the shards are. */
interface SnapshotHostData extends SnapshotCameraFit {
  shards: { offset: number; size: number } | null;
}

export interface AdoptedSceneSnapshot {
  adoption: object;
  shards: ArrayBuffer[];
  fit: SnapshotCameraFit;
  firstVisible: Promise<void>;
}

/** On by default; `perf.sceneSnapshot=0` (or `__IFC_LITE_SCENE_SNAPSHOT = 0`) turns it off. */
function snapshotsEnabled(): boolean {
  const raw = readPerfFlag('sceneSnapshot');
  return raw === undefined || raw === null || raw === 1 || raw === true;
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
  if (!(globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) return null; // no WebGPU: no renderer is coming
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
  trace: LoadTrace,
  append: (modelId: string, meshes: MeshData[], coordinateInfo?: CoordinateInfo) => void,
): Promise<MeshData[]> {
  const chunks = await Promise.all(open.chunks.map((_, i) => trace.span('cache.chunkDecode', () => open.readChunk(i), { chunk: i })));
  if (isStale?.()) return [];
  const meshes = chunks.flat();
  setPendingSceneSnapshot(adopted.adoption, () => {
    useViewerStore.getState().appendInstancedShards(modelId, adopted.shards);
    forgetRefusedSnapshot(cacheResult, cacheKey);
  }, adopted.fit, trace);
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

/**
 * Merged flat geometry a capture may keep from the swap until it is stored.
 * Above it the capture is skipped (`over-cap`): a capture holds one more copy of
 * the merged batches across the cache write. 64 MiB is twice the largest the
 * load corpus produced (BWK, a 327 MB file: 31.8 MB), so every measured model
 * keeps its first-reopen gain, and the extra copy stays at or below about 1.3%
 * of the cold peaks measured on those models (Holter 3.7 GiB, BWK 5.0 GiB).
 */
export const SNAPSHOT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

function mergedBytes(snapshot: SceneSnapshot): number {
  let bytes = 0;
  for (const b of snapshot.batches) bytes += b.vertexData.byteLength + b.indices.byteLength + (b.lod1Indices?.byteLength ?? 0) + b.expressIds.byteLength + b.ordinals.byteLength;
  return bytes;
}

/**
 * Arm the capture of the next finalize. At the swap, keep the scene with the
 * fit and type-visibility key it was built under, or nothing when it is not
 * the cached geometry. Synchronous at the swap; all later work is deferred.
 */
function armSceneCapture(renderer: Renderer, isStale: () => boolean, trace: LoadTrace, onCaptured: (captured: CapturedScene) => void,
  loadFailed: () => boolean = () => false): void {
  renderer.getScene().captureNextFinalize((snapshot: SceneSnapshot, sources: readonly MeshData[], sceneUnchanged: () => boolean) => {
    const camera = renderer.getCamera();
    const sceneBounds = camera.getSceneBounds();
    const fitBounds = lastFinalFitBounds();
    const skipped = isStale() ? 'superseded' : loadFailed() ? 'load-failed' : mergedBytes(snapshot) > SNAPSHOT_CAPTURE_MAX_BYTES ? 'over-cap'
      : !sceneBounds ? 'no-scene-bounds' : !fitBounds ? 'no-fit-bounds' : !sceneMatchesCachedGeometry() ? 'level-offsets' : null;
    if (skipped || !sceneBounds || !fitBounds) return noteSnapshotSkip(trace, 'not-captured', skipped ?? 'no-bounds');
    onCaptured({ snapshot, sources, key: snapshotKey(renderer.getScene()), fit: { fitBounds, sceneBounds, orbitAnchorBounds: camera.getOrbitAnchorBounds() },
      policyNow: () => renderer.getScene().sceneSnapshotPolicy(), loadFailed,
      // The entry is serialized from the live meshes after the swap: an edit since then would make it disagree.
      changedSince: () => (!sceneUnchanged() ? 'scene-changed' : !sceneMatchesCachedGeometry() ? 'level-offsets' : null) });
  }, (dropped) => noteSnapshotSkip(trace, 'not-captured', dropped));
}

/**
 * A load that could have left a snapshot but will not, and why: one zero-length
 * `cache.writeSceneSnapshot` span, so every eligible load ends with that span
 * and an outcome. `not-armed` reasons: snapshots-off, level-offsets,
 * superseded (another load registered first), no-geometry (the load wrote its
 * entry without its geometry ever reaching the viewport). `not-captured`
 * reasons: a renderer drop (cleared, ephemeral, replaced, not-exact, failed)
 * or a swap-time guard (superseded, load-failed, over-cap, no-scene-bounds,
 * no-fit-bounds, level-offsets).
 */
function noteSnapshotSkip(trace: LoadTrace, outcome: 'not-armed' | 'not-captured', reason: string): void {
  const now = performance.now();
  trace.record('cache.writeSceneSnapshot', now, now, { outcome, reason });
}

/** Begin the pending write's span at the swap and hand the capture to the deferred writer. */
function writeWhenSettled(captured: CapturedScene, entry: Promise<SnapshotEntry | null>, isStale: () => boolean, trace: LoadTrace): void {
  const span = trace.begin('cache.writeSceneSnapshot', { batches: captured.snapshot.batches.length });
  void writeCapturedScene(captured, entry, isStale, trace, span);
}

/** Store the scene this hit is about to finalize, once it has. Resolves true when the load was superseded while it waited. */
export async function captureSceneSnapshotOfHit(
  cacheResult: CacheResult,
  cacheKey: string | undefined,
  decoded: Pick<DecodedCacheMetadata, 'headerInfo'>,
  isStale: (() => boolean) | undefined,
  trace: LoadTrace,
): Promise<boolean> {
  const { createdAt, fullSourceHash, buffer: entry } = cacheResult;
  if (!snapshotsEnabled() || !cacheKey || createdAt === undefined || !(entry instanceof Blob) || !sceneMatchesCachedGeometry()) return false;
  const renderer = await rendererReady(isStale);
  if (!renderer) return isStale?.() ?? false;
  // Batches built before admission stay f32, and a snapshot would keep them that way for good.
  if (isQuantizedEnabled()) await renderer.enableQuantizedBatches();
  if (isStale?.()) return true;
  const section = decoded.headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
  const target: SnapshotEntry = { cacheKey, write: { createdAt, fullSourceHash }, shards: section ? { offset: section.offset, size: section.size } : null };
  const stale = isStale ?? (() => false);
  armSceneCapture(renderer, stale, trace, (captured) => writeWhenSettled(captured, Promise.resolve(target), stale, trace));
  return false;
}

/** A cold load's capture: the entry it belongs to is known only once the load's cache write committed. */
export interface ColdSceneCapture {
  /** The committed entry, or null when nothing was written; the first call wins. */
  entryWritten(entry: SnapshotEntry | null): void;
}

/** Which loads keep their finished scene (W2): primary loads the cache plan writes, without textures the format cannot hold. */
export function coldCaptureEligible(load: { primary: boolean; shouldCache: boolean; textured: boolean }): boolean {
  return load.primary && load.shouldCache && !load.textured;
}

/**
 * Capture the scene a primary cold load is about to stream, so the first reopen
 * adopts it instead of streaming the hit (W2). Never awaits on the load's path.
 * The capture is registered here and armed by the viewport's first sync of
 * this load's geometry, before any piece is queued (sceneSnapshotOwnership.ts).
 * A load that fails releases it: `modelId`'s `loadState` turning `error`.
 */
export function armColdSceneCapture(isStale: () => boolean, trace: LoadTrace, modelId: string): ColdSceneCapture {
  let settleEntry!: (entry: SnapshotEntry | null) => void;
  const entry = new Promise<SnapshotEntry | null>((resolve) => { settleEntry = resolve; });
  if (!snapshotsEnabled() || !sceneMatchesCachedGeometry()) {
    noteSnapshotSkip(trace, 'not-armed', snapshotsEnabled() ? 'level-offsets' : 'snapshots-off');
    return { entryWritten: (written) => settleEntry(written) };
  }
  const loadFailed = () => useViewerStore.getState().models.get(modelId)?.loadState === 'error';
  const pending = {
    arm: (renderer: Renderer) => {
      if (isStale()) return noteSnapshotSkip(trace, 'not-armed', 'superseded');
      armSceneCapture(renderer, isStale, trace, (captured) => writeWhenSettled(captured, entry, isStale, trace), loadFailed);
    },
    replaced: () => noteSnapshotSkip(trace, 'not-armed', 'superseded'),
  };
  setPendingColdCapture(pending);
  return {
    entryWritten: (written) => {
      if (withdrawPendingColdCapture(pending)) noteSnapshotSkip(trace, 'not-armed', 'no-geometry');
      settleEntry(written);
    },
  };
}
