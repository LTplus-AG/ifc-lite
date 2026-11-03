/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { trackCaptureDevice, trackCaptureLoad } from '@/lib/analytics';
import {
  captureSizeBucket, captureSplatBucket, type CaptureDeviceProperties, type CaptureFailureCode,
  type CaptureFormat, type CaptureLoadOutcome,
} from '@/lib/analytics-capture-events';

/** One settled capture load. Only the file size and header count are read, and both are bucketed. */
export interface CaptureLoadReport {
  outcome: CaptureLoadOutcome;
  code?: CaptureFailureCode;
  format: CaptureFormat;
  bytes: number;
  count?: number;
}

/** Diagnostics must never break a load. */
export function reportCaptureLoad(report: CaptureLoadReport): void {
  try {
    trackCaptureLoad({
      outcome: report.outcome,
      ...(report.code && (report.outcome === 'failed' || report.outcome === 'refused') ? { code: report.code } : {}),
      format: report.format,
      size_bucket: captureSizeBucket(report.bytes),
      splat_bucket: captureSplatBucket(report.count),
    });
  } catch (error) {
    console.warn('[gaussian] capture load telemetry failed:', error);
  }
}

const counts = { loss: 0, recovery: 0 };

/**
 * A device loss or recovery while at least one capture is loaded (#8568).
 * Called from the viewport's single loss/recovery report, once per episode.
 */
export function noteGaussianDeviceEvent(phase: CaptureDeviceProperties['phase']): void {
  try {
    const loaded = [...useViewerStore.getState().models.values()].some((model) => model.gaussianSplat);
    if (!loaded) return;
    if (phase === 'lost') counts.loss++;
    else if (phase === 'recovered') counts.recovery++;
    trackCaptureDevice({ phase, loss_count: counts.loss, recovery_count: counts.recovery });
  } catch (error) {
    console.warn('[gaussian] capture device telemetry failed:', error);
  }
}
