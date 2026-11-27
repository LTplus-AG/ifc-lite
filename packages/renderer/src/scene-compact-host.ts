/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the compact page code (scene-compact.ts) asks of the Scene, and the
 * small rules it applies per mesh: which meshes an operation selects, and
 * whether a mesh still matches the records it was encoded with.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { compactRow, COMPACT_RECORD_BYTES, type CompactRef } from '@ifc-lite/geometry/compact';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

/** Which paged meshes an operation needs on the bucket path: every one (`undefined`), some entities', or one model's. */
export type CompactSelection = { ids: Iterable<number> } | { modelIndex: number } | undefined;

/** The Scene members this module works through (the Scene passes itself, as it does to its snapshot lifecycle). */
export interface SceneCompactHost {
  ephemeralStreamingMode: boolean;
  geometryReleased: boolean;
  /** The quantized pipelines exist: without them a 12-byte page cannot be drawn. */
  quantizedBatchesEnabled: boolean;
  /** The quantized pipelines are being probed: queued compact meshes wait for the outcome. */
  quantizedBatchesPending: boolean;
  finalizeInProgress: boolean;
  nextBatchId: number;
  streamingFragments: readonly BatchedMesh[];
  streamedBucketKeys: ReadonlySet<string>;
  meshQueue: MeshData[];
  meshDataMap: Map<number, MeshData[]>;
  modelTranslations: { isPlaced(modelIndex: number): boolean; placeMesh(mesh: MeshData): MeshData };
  triangleCounts: { uploaded(meshes: readonly MeshData[]): void };
  colorKey(color: readonly [number, number, number, number], material?: MeshData['material']): string;
  addMeshData(mesh: MeshData): void;
  splitMeshForStreaming(mesh: MeshData): MeshData[];
  appendToBatches(meshes: MeshData[], device: GPUDevice, pipeline: RenderPipeline, isStreaming: boolean, sourceCounted: boolean): void;
  /** `appendToBatches`' own per-mesh validation: whether it would refuse `mesh` (no topology-safe f32 frame). */
  refusesBucketPath(mesh: MeshData): boolean;
  bumpPickGeometryRevision(): void;
}

/** A selection with its ids read once (an iterator can be walked only once). */
export type Selection = { ids: ReadonlySet<number> } | { modelIndex: number } | undefined;

export function normalize(selection: CompactSelection): Selection {
  return selection === undefined || 'modelIndex' in selection ? selection : { ids: new Set(selection.ids) };
}

/** The mesh still has the origin its records were adopted under (records hold world positions and cannot follow a new one). */
export function unmoved(mesh: MeshData, ref: CompactRef): boolean {
  const now = mesh.origin, then = ref.origin;
  return (now?.[0] ?? 0) === (then?.[0] ?? 0) && (now?.[1] ?? 0) === (then?.[1] ?? 0) && (now?.[2] ?? 0) === (then?.[2] ?? 0);
}

export function recordedLane(ref: CompactRef): number {
  const { records } = ref.payload;
  const at = records.byteOffset + compactRow(ref).vertexStart * COMPACT_RECORD_BYTES + 8;
  return new DataView(records.buffer, at, 4).getUint32(0, true);
}

/**
 * Why a queued compact mesh went to the bucket path decoded: the scene had no quantized pipelines
 * (`pipelines`) or keeps no CPU geometry (`no-cpu-geometry`), or the mesh no longer matches its
 * records (`written`: its geometry was replaced) or needs what a page cannot draw.
 */
export type CompactDecodeReason = 'pipelines' | 'no-cpu-geometry' | 'written' | 'id' | 'texture' | 'placed' | 'moved' | 'lane';

/** What `Scene.getCompactStats` reports: meshes drawn from pages, and those a load decoded to buckets by reason. */
export interface CompactSceneStats { paged: number; decodes: Readonly<Partial<Record<CompactDecodeReason, number>>> }

/** Pages now, wait for the probe in flight, or the scene-wide reason every compact mesh decodes. */
export type PageMode = 'pages' | 'wait' | Extract<CompactDecodeReason, 'pipelines' | 'no-cpu-geometry'>;

/**
 * Whether eligible meshes draw from pages now (`'pages'`), wait queued for the quantized pipeline
 * probe in flight (`'wait'`), or decode to the bucket path (the reason). A scene that keeps no CPU
 * geometry (ephemeral streaming, released) has no bucket path to fall back to.
 */
export function pageMode(scene: SceneCompactHost): PageMode {
  if (scene.ephemeralStreamingMode || scene.geometryReleased) return 'no-cpu-geometry';
  return scene.quantizedBatchesEnabled ? 'pages' : scene.quantizedBatchesPending ? 'wait' : 'pipelines';
}

/** Why `mesh` cannot draw from a page (null when it can); `laneOf` is the lane the bucket path would stamp. */
export function pageRefusal(scene: SceneCompactHost, laneOf: (mesh: MeshData) => number, mesh: MeshData): CompactDecodeReason | null {
  const ref = mesh.compact;
  if (!ref) return 'written';
  if (!(mesh.expressId >= 0 && mesh.expressId <= 0x00ffffff) || mesh.entityIds) return 'id';
  if (mesh.uvs || mesh.texture || mesh.textureRef) return 'texture';
  if (scene.modelTranslations.isPlaced(mesh.modelIndex ?? 0)) return 'placed';
  if (!unmoved(mesh, ref)) return 'moved';
  return recordedLane(ref) === laneOf(mesh) ? null : 'lane';
}
