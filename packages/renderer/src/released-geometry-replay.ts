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
 * nothing: one that errors, is cancelled or is superseded removes every
 * fragment it uploaded, and the entity and placement bounds it unioned,
 * before closing the ephemeral pass, so the scene stays
 * consistent and released and a retry never draws a batch twice.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from './renderer.js';
import { destroyGpuResources } from './scene-geometry.js';

type BatchedFragment = Parameters<typeof destroyGpuResources>[0];
/** The scene's own fragment lists (friend access, as device recovery uses). */
interface FragmentHost {
  streamingFragments: BatchedFragment[]; batchedMeshes: BatchedFragment[];
  boundingBoxes: Map<number, unknown>; modelTranslations: { releasedEntities: Map<number, Map<number, unknown>> };
}

/** The per-entity world boxes and released placement groups a replay unions into, as they were before it. */
function snapshotBounds(host: FragmentHost) {
  return { boxes: new Map(host.boundingBoxes),
    groups: new Map([...host.modelTranslations.releasedEntities].map(([id, groups]) => [id, new Map(groups)])) };
}
function restoreBounds(host: FragmentHost, snapshot: ReturnType<typeof snapshotBounds>): void {
  host.boundingBoxes.clear();
  for (const [id, box] of snapshot.boxes) host.boundingBoxes.set(id, box);
  host.modelTranslations.releasedEntities.clear();
  for (const [id, groups] of snapshot.groups) host.modelTranslations.releasedEntities.set(id, groups);
}

/** Destroy and remove fragments a replay created; idempotent. */
function rollBack(host: FragmentHost, created: readonly BatchedFragment[]): void {
  const gone = new Set(created.filter((fragment) => host.batchedMeshes.includes(fragment) || host.streamingFragments.includes(fragment)));
  if (gone.size === 0) return;
  for (const fragment of gone) destroyGpuResources(fragment);
  host.streamingFragments = host.streamingFragments.filter((fragment) => !gone.has(fragment));
  host.batchedMeshes = host.batchedMeshes.filter((fragment) => !gone.has(fragment));
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
  const before = new Set(host.streamingFragments);
  const bounds = snapshotBounds(host); // a rolled-back replay must leave no entity or placement bounds either
  let created: BatchedFragment[] = [];
  let ok = false;
  scene.setEphemeralStreamingMode(true);
  try {
    for await (const batch of batches) {
      if (options.signal?.aborted) { stopped = 'cancelled'; break; }
      if (!current()) { stopped = 'superseded'; break; }
      if (batch.length === 0) continue;
      scene.appendToBatches([...batch], device, pipeline, true);
      count++; meshes += batch.length;
      renderer.requestRender();
    }
    // The iterator's final next() is asynchronous too: re-check before committing.
    if (!stopped) {
      if (options.signal?.aborted) stopped = 'cancelled';
      else if (!current()) stopped = 'superseded';
    }
    ok = !stopped;
  } finally {
    created = host.streamingFragments.filter((fragment) => !before.has(fragment));
    // All or nothing: a replay that does not complete removes what it uploaded, so a retry
    // never draws a batch twice. Then the pass is always closed, leaving a released scene.
    if (!ok) { rollBack(host, created); restoreBounds(host, bounds); }
    if (scene.isEphemeralStreaming()) await scene.finalizeStreamingAsync(device, pipeline);
    renderer.requestRender();
  }
  // Finalization is asynchronous: a change during it must not report (or keep) a complete replay.
  if (options.signal?.aborted) stopped = 'cancelled';
  else if (!current()) stopped = 'superseded';
  if (stopped) { rollBack(host, created); restoreBounds(host, bounds); renderer.requestRender(); }
  return stopped ? { status: stopped, batches: count, meshes } : { status: 'complete', batches: count, meshes };
}
