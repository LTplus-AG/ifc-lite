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
 * device supersedes this one) and `signal` cancels. Replays of one scene run
 * one at a time: each opens, owns and closes its own ephemeral pass, so one
 * can never finalize another's. A replay is all or nothing, as a transaction:
 * it owns the fragments its own batches appended, and stages the entity and
 * placement bounds they union in private maps that reach the scene only when
 * it completes. One that errors, is cancelled, is superseded or fails to
 * finalize destroys its own fragments still in the scene and drops its staged
 * bounds, so no surviving box ever holds its extent and nothing has to be
 * recomputed. A `clear()` (the scene's epoch) since it began voids it.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from './renderer.js';
import { destroyGpuResources } from './scene-geometry.js';
import { unionBox } from './released-entity-bounds.js';
import type { BoundingBox } from './scene-raycaster.js';

type BatchedFragment = Parameters<typeof destroyGpuResources>[0];
/** The scene's own fragment lists and bounds (friend access, as device recovery uses). */
interface FragmentHost {
  streamingFragments: BatchedFragment[]; batchedMeshes: BatchedFragment[]; readonly clearEpoch: number;
  boundingBoxes: Map<number, BoundingBox>; modelTranslations: { releasedEntities: Map<number, Map<number, BoundingBox>> };
}

/** Per scene, the tail of its replay passes: the next one opens only after this settles. */
const passes = new WeakMap<object, Promise<void>>();

/** What one replay owns: its fragments, and its bounds staged until it commits. */
class ReplayTransaction {
  private readonly fragments = new Set<BatchedFragment>();
  private readonly boxes = new Map<number, BoundingBox>();
  private readonly groups = new Map<number, Map<number, BoundingBox>>();
  readonly epoch: number;
  constructor(private readonly host: FragmentHost, epoch: number) { this.epoch = epoch; }

  /** Run one synchronous append: its fragments become this replay's, its bounds land in the staging. */
  record(append: () => void): void {
    const { host } = this, translations = host.modelTranslations;
    const before = new Set(host.streamingFragments), boxes = host.boundingBoxes, groups = translations.releasedEntities;
    host.boundingBoxes = this.boxes; translations.releasedEntities = this.groups;
    try { append(); } finally {
      host.boundingBoxes = boxes; translations.releasedEntities = groups;
      for (const fragment of host.streamingFragments) if (!before.has(fragment)) this.fragments.add(fragment);
    }
  }

  /** Complete: union the staged bounds into the scene's (nothing after a clear()). */
  commit(): void {
    const { host } = this;
    if (host.clearEpoch === this.epoch) {
      for (const [id, box] of this.boxes) { const prior = host.boundingBoxes.get(id); host.boundingBoxes.set(id, prior ? unionBox(prior, box) : box); }
      for (const [id, staged] of this.groups) {
        const current = host.modelTranslations.releasedEntities.get(id) ?? new Map<number, BoundingBox>();
        for (const [index, box] of staged) { const prior = current.get(index); current.set(index, prior ? unionBox(prior, box) : box); }
        host.modelTranslations.releasedEntities.set(id, current);
      }
    }
    this.fragments.clear(); this.boxes.clear(); this.groups.clear();
  }

  /** Not complete: destroy its fragments still in the scene and drop its staged bounds; idempotent. */
  rollBack(): void {
    const { host } = this;
    const gone = new Set([...this.fragments].filter((f) => host.batchedMeshes.includes(f) || host.streamingFragments.includes(f)));
    for (const fragment of gone) destroyGpuResources(fragment);
    if (gone.size > 0) {
      host.streamingFragments = host.streamingFragments.filter((fragment) => !gone.has(fragment));
      host.batchedMeshes = host.batchedMeshes.filter((fragment) => !gone.has(fragment));
    }
    this.fragments.clear(); this.boxes.clear(); this.groups.clear();
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
  // The scene's epoch when this replay was CALLED: a clear() while it waits for the pass voids it.
  const calledAt = (scene as unknown as FragmentHost).clearEpoch;
  // One pass at a time per scene: wait for the previous replay to close its own pass.
  const prior = passes.get(scene) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => { release = done; });
  const tail = prior.then(() => mine);
  passes.set(scene, tail);
  await prior;
  try {
    return await replayOwnPass(renderer, scene, device, pipeline, batches, options, calledAt);
  } finally {
    release();
    if (passes.get(scene) === tail) passes.delete(scene);
  }
}

async function replayOwnPass(
  renderer: Pick<Renderer, 'getGPUDevice' | 'requestRender'>, scene: ReturnType<Renderer['getScene']>, device: GPUDevice,
  pipeline: NonNullable<ReturnType<Renderer['getPipeline']>>, batches: AsyncIterable<readonly MeshData[]>, options: ReleasedGeometryReplayOptions,
  calledAt: number,
): Promise<ReleasedGeometryReplayResult> {
  const startDevice = device;
  const current = () => (options.isCurrent?.() ?? true) && renderer.getGPUDevice() === startDevice;
  let count = 0, meshes = 0;
  const host = scene as unknown as FragmentHost;
  const tx = new ReplayTransaction(host, calledAt);
  const reason = (): 'cancelled' | 'superseded' | undefined =>
    options.signal?.aborted ? 'cancelled' : !current() || host.clearEpoch !== tx.epoch ? 'superseded' : undefined;
  // Superseded (or the scene cleared) while waiting for the pass: never open one.
  let stopped = reason();
  if (stopped) return { status: stopped, batches: 0, meshes: 0 };
  let ok = false;
  scene.setEphemeralStreamingMode(true);
  try {
    for await (const batch of batches) {
      stopped = reason();
      if (stopped) break;
      if (batch.length === 0) continue;
      tx.record(() => scene.appendToBatches([...batch], device, pipeline, true));
      count++; meshes += batch.length;
      renderer.requestRender();
    }
    // The iterator's final next() is asynchronous too: re-check before committing.
    stopped ??= reason();
    ok = !stopped;
  } finally {
    // All or nothing: a replay that does not complete removes what it owns, so a retry never
    // draws a batch twice. Its own pass is always closed (unless a clear() already did).
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
  if (stopped) tx.rollBack(); else tx.commit();
  renderer.requestRender();
  return stopped ? { status: stopped, batches: count, meshes } : { status: 'complete', batches: count, meshes };
}
