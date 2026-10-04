/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where COPC LOD nodes land in the viewer (#6869): one keyed renderer chunk
 * per octree node, plus the side channels a whole-file stream feeds.
 *
 * - Scan cache (section scan layer, alignment workbench): fed ONCE per
 *   coarse node (levels 0-2). Coarse COPC nodes are an even subsample of
 *   the whole cloud, so the reservoir stays representative; re-feeding
 *   nodes that stream in and out would bias it and keep changing the
 *   sample under the workbench.
 * - Class histogram: each node counted once, scaled by its stride, as an
 *   estimate of the whole file's classes (an exact count would mean
 *   decoding every point).
 * - Deviation: a run only colours the chunks that existed at the time, so
 *   when one is live, each settled pass re-runs it (the BVH is cached by
 *   the renderer, so this is the per-chunk dispatch only). A completed
 *   refresh bumps `pointCloudDeviationRevision`, so the Deviation panel's
 *   statistics re-read the new run instead of describing the old chunks.
 */

import type { CopcLodNode, DecodedPointChunk } from '@ifc-lite/pointcloud';
import { useViewerStore } from '../../../store/index.js';
import { addPointsToScanCache } from '../pointCloudScanCache.js';
import { swapZupChunkToYup } from '../pointCloudFrame.js';
import type { CopcLodSink } from './copcLodController.js';
import type { CopcIngestContext } from './copcLodStream.js';

/** Deepest level fed into the scan cache. */
const SCAN_CACHE_MAX_LEVEL = 2;

export function createCopcLodSink(ctx: CopcIngestContext): CopcLodSink & { passSettled(): void } {
  const fedToScanCache = new Set<string>();
  const counted = new Set<string>();
  const classCounts = new Float64Array(256);
  let sawClasses = false;
  let deviationRun: Promise<unknown> | null = null;
  let deviationAgain = false;

  const rerunDeviation = () => {
    if (deviationRun) {
      deviationAgain = true;
      return;
    }
    deviationRun = ctx.renderer.computeDeviations({ maxRange: 1.0 })
      .then(() => useViewerStore.getState().bumpPointCloudDeviationRevision())
      .catch((err: unknown) => console.warn('[copc-lod] deviation refresh failed:', err))
      .finally(() => {
        deviationRun = null;
        if (deviationAgain) {
          deviationAgain = false;
          rerunDeviation();
        }
      });
  };

  return {
    append(node: CopcLodNode, chunk: DecodedPointChunk) {
      const yUp = swapZupChunkToYup(chunk);
      ctx.renderer.appendPointCloudChunk(ctx.handle, yUp, node.id);
      if (node.entry.key.d <= SCAN_CACHE_MAX_LEVEL && !fedToScanCache.has(node.id)) {
        fedToScanCache.add(node.id);
        addPointsToScanCache(ctx.handle.id, yUp);
      }
      if (chunk.classifications && chunk.pointCount > 0 && !counted.has(node.id)) {
        counted.add(node.id);
        sawClasses = true;
        const scale = node.pointCount / chunk.pointCount;
        for (let i = 0; i < chunk.pointCount; i++) classCounts[chunk.classifications[i]] += scale;
      }
    },
    remove(node: CopcLodNode) {
      ctx.renderer.removePointCloudChunk(ctx.handle, node.id);
    },
    passSettled() {
      if (sawClasses && ctx.onClassCounts) {
        const counts: Record<number, number> = {};
        classCounts.forEach((v, classId) => {
          if (v > 0) counts[classId] = Math.round(v);
        });
        ctx.onClassCounts(counts);
      }
      if (useViewerStore.getState().pointCloudDeviationComputed) rerunDeviation();
    },
  };
}
