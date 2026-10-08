/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How `startCopcLod` joins the LOD controller to the renderer sink (#6880).
 * Kept apart from the stream so a node-level test can build the very same
 * controller options and load sequence over a fake reader and renderer.
 */

import type { CopcLodTree, LodCamera } from '@ifc-lite/pointcloud';
import { CopcLodController, type CopcLodControllerOptions, type CopcLodReader } from './copcLodController.js';
import type { createCopcLodSink } from './copcLodSink.js';

type Sink = ReturnType<typeof createCopcLodSink>;

export interface StreamControllerOptions {
  pointBudget: number;
  onError: (err: unknown) => void;
  /** Resident points while the initial overview loads; not called after it. */
  onProgress?: (points: number) => void;
  /** True once the overview has loaded. */
  isLoaded: () => boolean;
  /** Test seams (pacer, clock, scheduler). */
  overrides?: Partial<CopcLodControllerOptions>;
}

export function createStreamController(
  tree: CopcLodTree,
  reader: CopcLodReader,
  sink: Sink,
  options: StreamControllerOptions,
): CopcLodController {
  const controller: CopcLodController = new CopcLodController(tree, reader, sink, {
    pointBudget: options.pointBudget,
    onError: options.onError,
    onPassComplete: () => {
      // Progress belongs to the load; later camera passes must not
      // rewrite the global status line.
      if (!options.isLoaded()) options.onProgress?.(controller.points);
    },
    // After the pass's evictions, and for eviction-only passes too: the
    // deviation refresh must measure what stays on screen.
    onPassSettled: () => sink.passSettled(),
    ...options.overrides,
  });
  return controller;
}

/**
 * Load the coarse overview, announce completion, then settle once more.
 * The ingest's `onComplete` re-derives the class histogram from chunks a COPC
 * stream never reports, which clears it; the closing `passSettled` sends the
 * sink's own estimate back.
 */
export async function loadOverview(args: {
  controller: CopcLodController;
  sink: Sink;
  camera: LodCamera;
  signal: AbortSignal;
  markLoaded: () => void;
  onComplete: (points: number) => void;
}): Promise<void> {
  await args.controller.update(args.camera);
  args.signal.throwIfAborted();
  args.markLoaded();
  args.onComplete(args.controller.points);
  args.sink.passSettled();
}
