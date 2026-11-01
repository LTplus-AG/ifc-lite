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
import { decodeSceneSnapshot, encodeSceneSnapshot, type SceneSnapshot } from '@ifc-lite/renderer';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { useViewerStore } from '../store/index.js';
import { lastFinalFitBounds, setPendingSceneSnapshot, withdrawPendingSceneSnapshot } from '../components/viewer/sceneSnapshotOwnership.js';
import { readPerfFlag } from '../lib/perf/flags.js';
import { recordFirstVisible } from '../lib/perf/loadTrace.js';
import { putSceneSnapshot, type CacheResult } from '../services/cacheService.js';
import { isQuantizedEnabled } from '../utils/quantizedConfig.js';
import { getGlobalRenderer } from './useBCF.js';
import type { DecodedCacheMetadata } from './ifcCacheDecode.js';

type CameraBounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** What the viewer stores beside the batches: the fit they were finalized under, and where the shards are. */
interface SnapshotHostData {
  fitBounds: CameraBounds;
  sceneBounds: CameraBounds;
  orbitAnchorBounds: CameraBounds | null;
  shards: { offset: number; size: number } | null;
}

export interface AdoptedSceneSnapshot {
  adoption: object;
  firstVisible: Promise<void>;
}

/** Same spellings as every other boolean perf flag: the URL reads as a number, a console global as either. */
function snapshotsEnabled(): boolean {
  const raw = readPerfFlag('sceneSnapshot');
  return raw === 1 || raw === true;
}

/** Level display moves pieces at arrival, so the batches would not be the cached geometry. */
function sceneMatchesCachedGeometry(): boolean {
  return useViewerStore.getState().appliedEntityLevelOffsets.size === 0;
}

async function readSnapshotShards(entry: Blob, shards: SnapshotHostData['shards']): Promise<ArrayBuffer[]> {
  if (!shards) return [];
  return readInstancedShards(new BufferReader(await entry.slice(shards.offset, shards.offset + shards.size).arrayBuffer()));
}

/** Draw the entry's finished scene, or return null so the hit streams. */
export async function adoptCachedSceneSnapshot(
  cacheResult: CacheResult,
  modelId: string,
  isStale: (() => boolean) | undefined,
  trace: LoadTrace,
): Promise<AdoptedSceneSnapshot | null> {
  const { sceneSnapshot, sceneSnapshotKey, buffer: entry } = cacheResult;
  const renderer = getGlobalRenderer();
  const device = renderer?.getGPUDevice();
  const pipeline = renderer?.getPipeline();
  if (!snapshotsEnabled() || !sceneSnapshot || !(entry instanceof Blob) || !renderer || !device || !pipeline || !sceneMatchesCachedGeometry()) return null;
  const scene = renderer.getScene();
  // Admission is asynchronous after viewport init, and a reload can get here first.
  if (scene.sceneSnapshotPolicy() !== sceneSnapshotKey && isQuantizedEnabled()) await renderer.enableQuantizedBatches();
  if (scene.sceneSnapshotPolicy() !== sceneSnapshotKey) return null;
  const bytes = await trace.span('cache.snapshotRead', () => sceneSnapshot.arrayBuffer());
  const snapshot = decodeSceneSnapshot(bytes);
  const host = snapshot?.hostData as SnapshotHostData | undefined;
  if (!snapshot || !host?.fitBounds || !host.sceneBounds || isStale?.()) return null;
  const shards = await readSnapshotShards(entry, host.shards);
  if (isStale?.()) return null;
  const adoption = trace.span('scene.snapshotAdopt', () => scene.adoptSceneSnapshot(snapshot, device, pipeline), { batches: snapshot.batches.length });
  if (!adoption) return null;
  if (shards.length > 0) useViewerStore.getState().appendInstancedShards(modelId, shards);
  const camera = renderer.getCamera();
  camera.reset();
  const canvas = renderer.getCanvas();
  const shortSide = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0);
  camera.fitBoundsAdaptive(host.fitBounds, { viewportShortPx: shortSide > 0 ? shortSide : undefined });
  camera.setSceneBounds(host.sceneBounds);
  camera.setOrbitAnchorBounds(host.orbitAnchorBounds);
  renderer.clearCaches();
  renderer.requestRender();
  return { adoption, firstVisible: recordFirstVisible(trace, trace.milestone('geometry.firstAppend')) };
}

/** Decode every mesh and publish it; Scene sync hydrates the adopted batches with what it receives. */
export async function publishAdoptedSceneMeshes(
  adopted: AdoptedSceneSnapshot,
  open: ReturnType<typeof openGeometryChunksV13>,
  modelId: string,
  isStale: (() => boolean) | undefined,
  append: (modelId: string, meshes: MeshData[], coordinateInfo?: CoordinateInfo) => void,
): Promise<MeshData[]> {
  const chunks = await Promise.all(open.chunks.map((_, i) => open.readChunk(i)));
  if (isStale?.()) return [];
  const meshes = chunks.flat();
  setPendingSceneSnapshot(adopted.adoption);
  append(modelId, meshes, open.coordinateInfo);
  return meshes;
}

/** The load is over without serving its snapshot: the adopted batches must not outlive it. */
export function abandonAdoptedSceneSnapshot(adopted: AdoptedSceneSnapshot | null): void {
  if (!adopted) return;
  withdrawPendingSceneSnapshot(adopted.adoption);
  getGlobalRenderer()?.getScene().abandonSceneSnapshot(adopted.adoption);
}

/** Store the scene this hit is about to finalize, once it has. */
export function captureSceneSnapshotOfHit(
  cacheResult: CacheResult,
  cacheKey: string | undefined,
  decoded: Pick<DecodedCacheMetadata, 'headerInfo'>,
  isStale: (() => boolean) | undefined,
): void {
  const { createdAt, buffer: entry } = cacheResult;
  const renderer = getGlobalRenderer();
  if (!snapshotsEnabled() || !renderer || !cacheKey || createdAt === undefined || !(entry instanceof Blob) || !sceneMatchesCachedGeometry()) return;
  renderer.getScene().captureNextFinalize((snapshot: SceneSnapshot) => {
    const camera = renderer.getCamera();
    const sceneBounds = camera.getSceneBounds();
    const fitBounds = lastFinalFitBounds();
    if (isStale?.() || !sceneBounds || !fitBounds || !sceneMatchesCachedGeometry()) return;
    const section = decoded.headerInfo.sections.find((s) => s.type === SectionType.InstancedShards);
    const hostData: SnapshotHostData = { fitBounds, sceneBounds, orbitAnchorBounds: camera.getOrbitAnchorBounds(),
      shards: section ? { offset: section.offset, size: section.size } : null };
    // Off the finalize's completion, which the first frame of the finished scene waits on.
    setTimeout(() => {
      void putSceneSnapshot(cacheKey, createdAt, encodeSceneSnapshot({ ...snapshot, hostData }), snapshot.policy).catch((err: unknown) => {
        console.warn('[useIfcCache] Scene snapshot was not stored:', err);
      });
    }, 0);
  });
}
