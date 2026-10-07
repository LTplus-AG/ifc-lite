/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Engine warm-up around a load (#7036).
 *
 * The loader used to start the main-thread engine init and the geometry
 * workers only after the file read, unwrap and cache lookup; on a cold load
 * both sat on the critical path in front of the first pre-pass event. Here
 * they start the moment a load is requested, beside the file read: the
 * workers wait, engine instantiated, in `@ifc-lite/geometry`'s pool until the
 * load leases them (and are terminated after a minute if it never does, e.g.
 * on a cache hit).
 *
 * Everything is fire-and-forget: a failure here only means the load does the
 * same work itself, as before. The `warmPool` perf flag (`?perf.warmPool=0`)
 * switches all of it off.
 */

import { prewarmGeometryWorkers, prewarmMainThreadEngine, releaseWarmGeometryWorkers } from '@ifc-lite/geometry';
import { peekGeomWorkerOverride } from '../store/geomWorkerOverride.js';
import { readPerfFlag } from './perf/flags.js';

const MB = 1024 * 1024;
/** Below this the loader meshes on the main thread (`processAdaptive`'s sync threshold): no workers. */
const PARALLEL_MIN_BYTES = 2 * MB;

export function isWarmPoolEnabled(): boolean {
  const v = readPerfFlag('warmPool');
  return !(v === 0 || v === '0' || v === false);
}

function looksLikeIfc(name: string): boolean {
  return /\.(ifc|ifczip)$/i.test(name);
}

/** Start the engine and this load's workers beside its file read. */
export function warmEngineForLoad(file: { name: string; size: number }): void {
  if (!isWarmPoolEnabled() || !looksLikeIfc(file.name)) return;
  prewarmMainThreadEngine();
  if (file.size < PARALLEL_MIN_BYTES) return;
  prewarmGeometryWorkers({ fileSizeMB: file.size / MB, workerCountOverride: peekGeomWorkerOverride() })
    .catch((error: unknown) => console.warn('[engine-warmup] worker prewarm failed; the load spawns its own:', error));
}

/** Drain idle workers before a resource retry and issue its best-effort notice. */
export function prepareResourceRetry(fileName: string): void {
  releaseWarmGeometryWorkers('resource-retry');
  void import('@/components/ui/toast')
    .then(({ toast }) => toast.info(`"${fileName}" was too detailed for this device — retrying at lower detail…`))
    .catch((error: unknown) => console.warn('[engine-warmup] resource retry notice unavailable:', error));
}
