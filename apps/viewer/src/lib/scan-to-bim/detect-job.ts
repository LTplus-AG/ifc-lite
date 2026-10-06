/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One scan-to-BIM detection (#6894): segment the retained scan sample (Y-up,
 * decode-relative, optionally cropped to the section box), then propose IFC
 * elements in the target model's frame. Both steps are Rust; this only
 * chains them. Shared by `workers/scanDetect.worker.ts` and the in-process
 * fallback, so both return the same proposals.
 */

import { IfcAPI } from '@ifc-lite/wasm';
import {
  segmentScan,
  type ScanCylinder,
  type ScanPlane,
  type ScanRegion,
  type ScanSegmentationLimits,
  type ScanSegmentationStats,
} from '@ifc-lite/geometry/scan-segmentation';
import { proposeScanElements, type ProposalSchema, type ScanProposalReport } from '@ifc-lite/geometry/scan-proposals';

export interface ScanDetectJob {
  /** xyz, Y-up, the sample's own frame; only the first `count` points are read. */
  positions: Float32Array;
  count: number;
  /** Crop in the sample frame (the section box mapped back), or the whole sample. */
  region: ScanRegion | null;
  /** Row-major sample -> target model frame (`scanToModelMatrix`). */
  scanToModel: number[];
  schema: ProposalSchema;
}

export type ScanDetectStage = 'segmenting' | 'proposing';

export interface ScanDetectResult {
  /** Detections in the sample frame (the overlay maps them through the cloud matrix). */
  planes: ScanPlane[];
  cylinders: ScanCylinder[];
  segmentation: { stats: ScanSegmentationStats; limits: ScanSegmentationLimits };
  /** Proposals in the target model frame. */
  proposals: ScanProposalReport;
}

/** Segment and propose. The wasm module must be initialised. */
export function runScanDetectJob(job: ScanDetectJob, onStage?: (stage: ScanDetectStage) => void): ScanDetectResult {
  const api = new IfcAPI();
  try {
    onStage?.('segmenting');
    const report = segmentScan(api, { positions: job.positions, count: job.count }, { upAxis: [0, 1, 0], region: job.region });
    onStage?.('proposing');
    const proposals = proposeScanElements(api, report, { scanToModel: job.scanToModel, schema: job.schema });
    return {
      planes: report.planes,
      cylinders: report.cylinders,
      segmentation: { stats: report.stats, limits: report.limits },
      proposals,
    };
  } finally {
    api.free();
  }
}
