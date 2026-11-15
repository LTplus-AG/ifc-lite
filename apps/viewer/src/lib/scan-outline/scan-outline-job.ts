/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One scan outline job (#6871): gather the undecimated in-band points of
 * every source and trace them. Shared by the worker
 * (`workers/scanOutline.worker.ts`) and the in-process fallback, so a browser
 * without workers gets the same rings, not similar ones.
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { Point2D } from '@ifc-lite/drawing-2d';
import { collectScanBandPlaneXY, type ScanPointSample, type ScanSectionPlane } from '@/hooks/scanSectionMath';
import { traceScanOutlineLayer, type ScanOutlineLayer } from './scan-outline';

/** One point-cloud source with the transform it is drawn through. */
export interface ScanOutlineSource extends ScanPointSample {
  model?: Float32Array | Float64Array;
  modelOutputsRenderFrame?: boolean;
  /**
   * Content version of `positions` / `classifications` when their owner
   * rewrites them in place (the scan cache's reservoir: same arrays, same
   * count, new points). The worker tracer re-sends the points when it moves.
   * Omit for buffers that never change.
   */
  revision?: number;
}

export interface ScanOutlineJob {
  sources: readonly ScanOutlineSource[];
  coordinateInfo: CoordinateInfo | undefined;
  plane: ScanSectionPlane;
  thickness: number;
  classMask?: readonly number[];
  maxGap: number;
}

/** Band-collect and trace. The wasm module must be initialised. */
export function runScanOutlineJob(job: ScanOutlineJob): ScanOutlineLayer {
  const parts: Float32Array[] = [];
  let anchor: Point2D | undefined;
  for (const sample of job.sources) {
    const part = collectScanBandPlaneXY({
      sample,
      coordinateInfo: job.coordinateInfo,
      plane: job.plane,
      thickness: job.thickness,
      classMask: job.classMask,
      model: sample.model,
      modelOutputsRenderFrame: sample.modelOutputsRenderFrame,
    }, anchor);
    // Every source shares the first nonempty band's f64 anchor, so merging
    // never adds map-scale coordinates back into an f32 buffer.
    if (part.planeXY.length > 0) anchor ??= part.anchor;
    parts.push(part.planeXY);
  }
  const planeXY = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    planeXY.set(p, at);
    at += p.length;
  }
  return traceScanOutlineLayer(planeXY, job.maxGap, anchor);
}
