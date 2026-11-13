/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene's side of a finished-scene snapshot. Capture keeps one finalize's
 * merged arrays and reports them; adoption draws a snapshot's batches at once,
 * with buckets that stay pieceless until hydration attaches the source meshes.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { perfTally, type LoadTrace } from '@ifc-lite/load-trace';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh, Mesh } from './types.js';
import type { SpatialChunkingConfig } from './chunk-grid.js';
import type { ModelTranslations } from './model-translation.js';
import { assignSnapshotPieces, FinishedBatchCapture, stageSnapshotBatches, type MergedBatchBytes } from './scene-snapshot-batches.js';
import { sceneSnapshotPolicy, type SceneCaptureCallback, type SceneCaptureDrop, type SceneSnapshot } from './scene-snapshot.js';

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

  captureNextFinalize(onCaptured: SceneCaptureCallback, onDropped?: (reason: SceneCaptureDrop) => void): void {
    this.drop('replaced');
    this.capture = new FinishedBatchCapture(onCaptured, onDropped);
  }

  /** End the pending capture without a snapshot, telling its owner why. */
  private drop(reason: SceneCaptureDrop, capture = this.capture): void {
    if (capture === this.capture) this.capture = null;
    try {
      capture?.onDropped?.(reason);
    } catch (err) {
      console.warn('[Scene] capture drop handler failed', err);
    }
  }

  /**
   * A finalize is starting: tally its fragments (#6957) and return the capture
   * armed before it, the only one it may complete. A capture armed while it
   * runs (a retry's or the next file's) belongs to a later finalize.
   */
  beginFinalize(fragments: number): object | null {
    perfTally('render.finalize', fragments, 'fragments');
    return this.capture;
  }

  notePiece(piece: MeshData, source: MeshData): void { this.capture?.notePiece(piece, source); }

  /** A capture waits for this finalize: streamed fragments keep their bytes for its assembled batches. */
  get capturing(): boolean { return this.capture !== null; }

  /** The upload's callback for a bucket batch while capturing; fragments and derived batches have no key. */
  mergedSink(bucketKey: string | undefined, batchId: number): ((bytes: MergedBatchBytes) => void) | undefined {
    const capture = this.capture;
    return capture && bucketKey !== undefined ? (bytes) => capture.noteMerged(bucketKey, batchId, bytes) : undefined;
  }

  dropCapture(): void { this.drop('ephemeral'); }

  /**
   * After the finalize swap: report the scene if it is exactly what was queued;
   * `scene.finalize.capture` times it. `claimed` is what `beginFinalize`
   * returned. The capture is optional, so nothing in it can fail the finalize
   * whose swap already happened: a throw drops it with reason `failed`.
   */
  completeCapture(claimed: object | null, trace?: LoadTrace, parent?: number): void {
    const capture = this.capture;
    if (!capture || capture !== claimed) return;
    this.capture = null;
    const start = performance.now();
    let outcome: 'captured' | SceneCaptureDrop = 'not-exact';
    try {
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
      if (snapshot) {
        capture.onCaptured(snapshot, capture.sources, this.sceneUnchangedSince(snapshot));
        outcome = 'captured';
      } else {
        console.warn('[Scene] finished scene not captured: it is not exactly the pieces queued');
      }
    } catch (err) {
      console.warn('[Scene] finished scene not captured: the capture failed', err);
      outcome = 'failed';
    }
    if (outcome !== 'captured') this.drop(outcome, capture);
    if (trace?.enabled) trace.record('scene.finalize.capture', start, performance.now(), { captured: outcome === 'captured', outcome }, parent);
  }

  /** Whether the flat scene still draws the batches `snapshot` was built from; see {@link SceneCaptureCallback}. */
  private sceneUnchangedSince(snapshot: SceneSnapshot): () => boolean {
    const scene = this.scene;
    const batchIds = snapshot.batches.map((b) => [b.key, scene.buckets.get(b.key)?.batchedMesh?.id] as const);
    return () => scene.dirtyBuckets.size === 0 && batchIds.every(([key, id]) => scene.buckets.get(key)?.batchedMesh?.id === id);
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
    if (this.capture?.hasPieces) this.drop('cleared');
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
