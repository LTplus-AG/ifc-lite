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
import { collectScanBandPlaneXY, type ScanPointSample, type ScanSectionPlane } from '@/hooks/scanSectionMath';
import { traceScanOutlineLayer, type ScanOutlineLayer } from './scan-outline';

/** One point-cloud source with the transform it is drawn through. */
export interface ScanOutlineSource extends ScanPointSample {
  model?: Float32Array;
  modelOutputsRenderFrame?: boolean;
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
  const parts = job.sources.map((sample) => collectScanBandPlaneXY({
    sample,
    coordinateInfo: job.coordinateInfo,
    plane: job.plane,
    thickness: job.thickness,
    classMask: job.classMask,
    model: sample.model,
    modelOutputsRenderFrame: sample.modelOutputsRenderFrame,
  }));
  const planeXY = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    planeXY.set(p, at);
    at += p.length;
  }
  return traceScanOutlineLayer(planeXY, job.maxGap);
}
