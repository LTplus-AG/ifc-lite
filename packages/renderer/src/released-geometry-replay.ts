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
 * device supersedes this one) and `signal` cancels. Either way the replay
 * still finishes the ephemeral pass, so the scene is consistent and released;
 * the result says it is partial so the host replays again rather than trust it.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from './renderer.js';

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
  } finally {
    // Always leave a consistent, released scene, even after an error mid-stream.
    if (scene.isEphemeralStreaming()) await scene.finalizeStreamingAsync(device, pipeline);
    renderer.requestRender();
  }
  return stopped ? { status: stopped, batches: count, meshes } : { status: 'complete', batches: count, meshes };
}
