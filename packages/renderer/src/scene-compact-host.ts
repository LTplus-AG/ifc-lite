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
