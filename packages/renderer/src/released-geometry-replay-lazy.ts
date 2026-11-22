/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public `replayReleasedGeometry` (#10264), with its body loaded on first use: only a host that
 * released its CPU geometry ever replays, so the replay stays out of an eager bundle. The scene's
 * replay epoch is taken HERE, at call time, so a `clear()` or recovery reset while the body loads still voids it.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from './renderer.js';
import type { ReleasedGeometryReplayOptions, ReleasedGeometryReplayResult } from './released-geometry-replay.js';

/**
 * Upload `batches` of model-local flat meshes (as stored: the scene places them
 * in the current model frame) into `renderer`'s scene and finish released.
 */
export async function replayReleasedGeometry(
  renderer: Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>,
  batches: AsyncIterable<readonly MeshData[]>,
  options: ReleasedGeometryReplayOptions = {},
): Promise<ReleasedGeometryReplayResult> {
  const calledAt = (renderer.getScene() as unknown as { replayEpoch: number }).replayEpoch;
  return (await import('./released-geometry-replay.js')).replayReleasedGeometry(renderer, batches, options, calledAt);
}
