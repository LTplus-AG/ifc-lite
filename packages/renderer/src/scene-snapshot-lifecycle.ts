/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene's side of a finished-scene snapshot. Capture keeps one finalize's
 * merged arrays and reports them; adoption draws a snapshot's batches at once,
 * with buckets that stay pieceless until hydration attaches the source meshes.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh, Mesh } from './types.js';
import type { SpatialChunkingConfig } from './chunk-grid.js';
import type { ModelTranslations } from './model-translation.js';
import { assignSnapshotPieces, FinishedBatchCapture, stageSnapshotBatches, type MergedBatchBytes } from './scene-snapshot-batches.js';
import { sceneSnapshotPolicy, type SceneSnapshot } from './scene-snapshot.js';

interface SnapshotBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
  frameOrigin?: [number, number, number];
}

/** The Scene state this module reads and publishes. */
export interface SceneSnapshotHost {
  quantizedBatchesEnabled: boolean;
  lodBuildsEnabled: boolean;
  spatialChunking: SpatialChunkingConfig | null;
  modelTranslations: ModelTranslations;
  dirtyBuckets: Set<string>;
  coldBuckets: Set<string>;
  texturedMeshes: unknown[];
  meshes: Mesh[];
  nextSplitId: number;
  nextBatchId: number;
  cachedMaxBufferSize: number;
  sharedFrameOrigins: Map<number, [number, number, number]>;
  activeBucketKey: Map<string, string>;
  buckets: Map<string, SnapshotBucket>;
  batchedMeshes: BatchedMesh[];
  meshDataBucket: Map<MeshData, SnapshotBucket>;
  getMaxBufferSize(device: GPUDevice): number;
  clearFlatGeometry(): void;
  removeInstancedTemplatesForModel(modelIndex: number): void;
  addMeshData(meshData: MeshData): void;
  splitMeshForStreaming(meshData: MeshData): MeshData[];
}

export class SceneSnapshotLifecycle {
  private capture: FinishedBatchCapture | null = null;
  private hydration: { snapshot: SceneSnapshot } | null = null;

  constructor(private readonly scene: SceneSnapshotHost) {}

  get hydrating(): boolean { return this.hydration !== null; }

  policy(): string {
    const { quantizedBatchesEnabled, lodBuildsEnabled, spatialChunking } = this.scene;
    return sceneSnapshotPolicy(quantizedBatchesEnabled, lodBuildsEnabled, spatialChunking);
  }

  captureNextFinalize(onCaptured: (snapshot: SceneSnapshot) => void): void {
    this.capture = new FinishedBatchCapture(onCaptured);
  }

  notePiece(piece: MeshData): void { this.capture?.notePiece(piece); }

  /** The upload's callback for a bucket batch while capturing; fragments and derived batches have no key. */
  mergedSink(bucketKey: string | undefined, batchId: number): ((bytes: MergedBatchBytes) => void) | undefined {
    const capture = this.capture;
    return capture && bucketKey !== undefined ? (bytes) => capture.noteMerged(bucketKey, batchId, bytes) : undefined;
  }

  dropCapture(): void { this.capture = null; }

  /** After the finalize swap: report the scene if it is exactly what was queued. */
  completeCapture(): void {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    const scene = this.scene;
    const [x, y, z] = scene.modelTranslations.get(0);
    const snapshot = capture.build({
      policy: this.policy(),
      nextSplitId: scene.nextSplitId,
      sourceOf: (piece) => scene.modelTranslations.sourceMesh(piece),
      pristine: scene.dirtyBuckets.size === 0 && scene.coldBuckets.size === 0 && scene.texturedMeshes.length === 0
        && scene.meshes.length === 0 && x === 0 && y === 0 && z === 0,
      sharedFrameOrigins: scene.sharedFrameOrigins,
      activeBuckets: scene.activeBucketKey,
      buckets: scene.buckets.values(),
    });
    if (snapshot) capture.onCaptured(snapshot);
    else console.warn('[Scene] finished scene not captured: it is not exactly the pieces queued');
  }

  /**
   * A reshape before the first queued piece is the load's own clear, so a
   * capture survives it. A clear during hydration means the adopting load lost
   * the scene, and its shards go with its batches. Hydration ends first on a
   * mismatch, whose fallback uploads the flat meshes and keeps the shards.
   */
  onFlatCleared(): void {
    if (this.hydration) this.scene.removeInstancedTemplatesForModel(0);
    this.hydration = null;
    if (this.capture?.hasPieces) this.capture = null;
  }

  /** Recovery rebuilds batches from pieces; pieceless ones cannot follow, so hydration reports failure. */
  onDeviceLost(): void { this.hydration = null; }

  adopt(snapshot: SceneSnapshot, device: GPUDevice, pipeline: RenderPipeline): object | null {
    const scene = this.scene;
    if (snapshot.policy !== this.policy()) return null;
    const maxBuffer = scene.getMaxBufferSize(device);
    if (snapshot.batches.some((b) => b.vertexData.byteLength > maxBuffer || b.indices.byteLength > maxBuffer)) return null;
    let staged: BatchedMesh[];
    try {
      staged = stageSnapshotBatches(snapshot, device, pipeline, scene.nextBatchId);
    } catch (err) {
      console.warn('[Scene] snapshot batches could not be staged', err);
      return null;
    }
    scene.clearFlatGeometry();
    scene.nextBatchId += staged.length;
    scene.cachedMaxBufferSize = maxBuffer;
    scene.nextSplitId = Math.max(scene.nextSplitId, snapshot.nextSplitId);
    for (const [model, origin] of snapshot.sharedFrameOrigins) scene.sharedFrameOrigins.set(model, origin);
    for (const [base, active] of snapshot.activeBuckets) scene.activeBucketKey.set(base, active);
    staged.forEach((batch, i) => {
      scene.buckets.set(batch.colorKey, { key: batch.colorKey, meshData: [], batchedMesh: batch, vertexBytes: snapshot.batches[i].vertexBytes, frameOrigin: batch.origin });
      scene.modelTranslations.registerDrawable(batch, snapshot.batches[i].modelIndex ?? 0);
    });
    scene.batchedMeshes = staged;
    this.hydration = { snapshot };
    return this.hydration;
  }

  hydrate(adoption: object, meshes: readonly MeshData[]): boolean {
    const scene = this.scene;
    if (this.hydration !== adoption || !this.hydration) return false;
    const assigned = assignSnapshotPieces(this.hydration.snapshot, meshes.flatMap((mesh) => scene.splitMeshForStreaming(mesh)));
    this.hydration = null;
    if (!assigned) {
      scene.clearFlatGeometry();
      return false;
    }
    for (const [key, parts] of assigned) {
      const bucket = scene.buckets.get(key)!;
      bucket.meshData = parts.map((part) => scene.modelTranslations.placeMesh(part));
      for (const part of bucket.meshData) {
        scene.meshDataBucket.set(part, bucket);
        scene.addMeshData(part);
      }
    }
    return true;
  }

  abandon(adoption: object): void {
    if (this.hydration === adoption) this.scene.clearFlatGeometry();
  }
}
