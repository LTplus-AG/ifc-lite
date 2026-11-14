/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The options every exact-kernel load passes to `GeometryProcessor.processAdaptive`.
 * One builder for both callers: the loader on the main thread
 * (`geometryEventSource.ts`) and the small-file fast path's spare worker
 * (`workers/fast-geometry.worker.ts`). Because both build them here, a fast run
 * takes the same engine path as the load would (the single-session branch below
 * {@link ADAPTIVE_SYNC_THRESHOLD_BYTES}, the worker pool with GPU instancing at
 * and above it) and emits the same events.
 */

import { DEFAULT_HUNG_JOB_TIMEOUT_MS, type GeometryProcessor } from '@ifc-lite/geometry';
import { getDynamicBatchConfig } from '../../utils/ifcConfig.js';

export type AdaptiveGeometryOptions = NonNullable<Parameters<GeometryProcessor['processAdaptive']>[1]>;

/** Below this the single-session branch meshes the file; at and above it, the worker pool. */
export const ADAPTIVE_SYNC_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** Per-load inputs; everything else is fixed for every load. */
export type AdaptiveGeometryInputs = Pick<AdaptiveGeometryOptions,
  'signal' | 'stallPhaseHandle' | 'existingSab' | 'sharedRtcOffset' | 'onEntityIndex' | 'sourceFingerprint' | 'workerCountOverride' | 'trace'> & {
  fileSizeMB: number;
};

export function adaptiveGeometryOptions(inputs: AdaptiveGeometryInputs): AdaptiveGeometryOptions {
  const { fileSizeMB, ...rest } = inputs;
  return {
    ...rest,
    hungJobTimeoutMs: DEFAULT_HUNG_JOB_TIMEOUT_MS, // the loader reads skippedHungElements
    sizeThreshold: ADAPTIVE_SYNC_THRESHOLD_BYTES,
    // Dynamic batches: small first, then large.
    batchSize: getDynamicBatchConfig(fileSizeMB),
  };
}
