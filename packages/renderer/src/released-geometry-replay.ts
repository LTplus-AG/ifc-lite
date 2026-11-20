/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounded scene replay for hosts that released CPU geometry after upload
 * (#10264). The host streams its stored flat meshes back in batches; each
 * batch is uploaded through the scene's ephemeral streaming path (GPU
 * fragments only, no CPU pieces kept) and may be dropped as soon as the call
 * for it returns. Per-entity world bounds are kept as the batches pass, so
 * picking, framing and placement keep working, and the scene finishes in the
 * released state it started from. Peak CPU memory is one batch.
 *
 * Fencing: `isCurrent` is checked between batches (a newer reload or a lost
 * device supersedes this one) and `signal` cancels. A replay is all or
 * nothing, as a transaction that owns exactly what it wrote: the fragments
 * each of its batches appended, and each entity and placement box it set.
 * One that errors, is cancelled, is superseded or fails to finalize rolls back
 * only that: a fragment still in the scene is destroyed, a box still holding
 * the value it wrote gets its prior value back, and anything a successor (or a
 * `clear()`, which moves the scene's epoch) has since replaced is left alone.
 * The ephemeral pass it opened is always closed, so the scene stays released
 * and a retry never draws a batch twice.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from './renderer.js';
import { destroyGpuResources } from './scene-geometry.js';

type BatchedFragment = Parameters<typeof destroyGpuResources>[0];
type Box = unknown;
/** The scene's own fragment lists (friend access, as device recovery uses). */
interface FragmentHost {
  streamingFragments: BatchedFragment[]; batchedMeshes: BatchedFragment[]; readonly clearEpoch: number;
  boundingBoxes: Map<number, Box>; modelTranslations: { releasedEntities: Map<number, Map<number, Box>> };
}

/** What one replay wrote, and what each written slot held before it first did. */
class ReplayTransaction {
  private readonly fragments = new Set<BatchedFragment>();
  private readonly boxes = new Map<number, { prior: Box | undefined; wrote: Box | undefined }>();
  private readonly groups = new Map<number, Map<number, { prior: Box | undefined; wrote: Box | undefined }>>();
  readonly epoch: number;
  constructor(private readonly host: FragmentHost) { this.epoch = host.clearEpoch; }

  /** Run one synchronous append and take ownership of exactly what it changed. */
  record(ids: Iterable<number>, append: () => void): void {
    const { host } = this, fresh = [...new Set(ids)];
    for (const id of fresh) {
      if (!this.boxes.has(id)) this.boxes.set(id, { prior: host.boundingBoxes.get(id), wrote: undefined });
      const slots = this.groups.get(id) ?? new Map(), current = host.modelTranslations.releasedEntities.get(id);
      for (const [index, box] of current ?? []) if (!slots.has(index)) slots.set(index, { prior: box, wrote: undefined });
      this.groups.set(id, slots);
    }
    const before = new Set(host.streamingFragments);
    try { append(); } finally {
      for (const fragment of host.streamingFragments) if (!before.has(fragment)) this.fragments.add(fragment);
      for (const id of fresh) {
        this.boxes.get(id)!.wrote = host.boundingBoxes.get(id);
        const slots = this.groups.get(id)!;
        for (const [index, box] of host.modelTranslations.releasedEntities.get(id) ?? []) {
          const slot = slots.get(index) ?? { prior: undefined, wrote: undefined };
          slot.wrote = box; slots.set(index, slot);
        }
      }
    }
  }

  /** Undo only what is still this replay's; idempotent. */
  rollBack(): void {
    const { host } = this;
    const gone = new Set([...this.fragments].filter((f) => host.batchedMeshes.includes(f) || host.streamingFragments.includes(f)));
    for (const fragment of gone) destroyGpuResources(fragment);
    if (gone.size > 0) {
      host.streamingFragments = host.streamingFragments.filter((fragment) => !gone.has(fragment));
      host.batchedMeshes = host.batchedMeshes.filter((fragment) => !gone.has(fragment));
    }
    this.fragments.clear();
    // A clear() since: every box now belongs to the scene's next era, never ours to restore.
    if (host.clearEpoch === this.epoch) {
      for (const [id, { prior, wrote }] of this.boxes) {
        if (wrote === undefined || host.boundingBoxes.get(id) !== wrote) continue; // replaced since: not ours
        if (prior === undefined) host.boundingBoxes.delete(id); else host.boundingBoxes.set(id, prior);
      }
      for (const [id, slots] of this.groups) {
        const current = host.modelTranslations.releasedEntities.get(id);
        if (!current) continue;
        for (const [index, { prior, wrote }] of slots) {
          if (wrote === undefined || current.get(index) !== wrote) continue;
          if (prior === undefined) current.delete(index); else current.set(index, prior);
        }
        if (current.size === 0) host.modelTranslations.releasedEntities.delete(id);
      }
    }
    this.boxes.clear(); this.groups.clear();
  }
}

export interface ReleasedGeometryReplayOptions {
  signal?: AbortSignal;
  /** False once this replay is superseded (newer content version, device change). */
  isCurrent?: () => boolean;
}

export type ReleasedGeometryReplayResult =
  | { status: 'complete'; batches: number; meshes: number }
  | { status: 'cancelled' | 'superseded'; batches: number; meshes: number }
  | { status: 'unavailable'; reason: 'no-device' | 'no-pipeline' };

/**
 * Upload `batches` of model-local flat meshes (as stored: the scene places them
 * in the current model frame) into `renderer`'s scene and finish released.
 */
export async function replayReleasedGeometry(
  renderer: Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>,
  batches: AsyncIterable<readonly MeshData[]>,
  options: ReleasedGeometryReplayOptions = {},
): Promise<ReleasedGeometryReplayResult> {
  const device = renderer.getGPUDevice();
  if (!device) return { status: 'unavailable', reason: 'no-device' };
  const pipeline = renderer.getPipeline();
  if (!pipeline) return { status: 'unavailable', reason: 'no-pipeline' };
  const scene = renderer.getScene();
  const startDevice = device;
  const current = () => (options.isCurrent?.() ?? true) && renderer.getGPUDevice() === startDevice;
  let count = 0, meshes = 0;
  let stopped: 'cancelled' | 'superseded' | undefined;
  const host = scene as unknown as FragmentHost;
  const tx = new ReplayTransaction(host);
  const reason = (): 'cancelled' | 'superseded' | undefined =>
    options.signal?.aborted ? 'cancelled' : !current() || host.clearEpoch !== tx.epoch ? 'superseded' : undefined;
  let ok = false;
  scene.setEphemeralStreamingMode(true);
  try {
    for await (const batch of batches) {
      stopped = reason();
      if (stopped) break;
      if (batch.length === 0) continue;
      tx.record(batch.map((mesh) => mesh.expressId), () => scene.appendToBatches([...batch], device, pipeline, true));
      count++; meshes += batch.length;
      renderer.requestRender();
    }
    // The iterator's final next() is asynchronous too: re-check before committing.
    stopped ??= reason();
    ok = !stopped;
  } finally {
    // All or nothing: a replay that does not complete removes what it owns, so a retry never
    // draws a batch twice. The pass it opened is always closed (unless a clear() already did).
    if (!ok) tx.rollBack();
    try {
      if (host.clearEpoch === tx.epoch && scene.isEphemeralStreaming()) await scene.finalizeStreamingAsync(device, pipeline);
    } catch (error) {
      tx.rollBack(); // a replay whose finalize failed is not complete either
      if (host.clearEpoch === tx.epoch) scene.setEphemeralStreamingMode(false);
      renderer.requestRender();
      throw error;
    }
    renderer.requestRender();
  }
  // Finalization is asynchronous: a change during it must not report (or keep) a complete replay.
  stopped = reason();
  if (stopped) { tx.rollBack(); renderer.requestRender(); }
  return stopped ? { status: stopped, batches: count, meshes } : { status: 'complete', batches: count, meshes };
}
