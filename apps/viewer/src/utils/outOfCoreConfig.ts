/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryProcessor } from '@ifc-lite/geometry';
import { getPerfFlagDefinition, resolvePerfFlag } from '../lib/perf/flags.js';
import { recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { isPerfFlagOn } from './hugeGeometryConfig.js';

/**
 * Out-of-core geometry ingest (`@ifc-lite/geometry` geometry-parallel-sparse.ts), OFF by default, for one exact
 * load's processor: the flag is resolved here (global, `?perf.ooc`, then the `perf-ooc` PostHog ramp), because the
 * geometry host reads only the global and URL param. The ramp therefore reaches the viewer's own loads, never
 * exports or other processors. A primary load (`recordArm`) records whether its pool meshed out of core as the
 * telemetry arm; a federated add follows the flag too but leaves the arm to its primary. {@link resetOutOfCoreArm}
 * starts every primary load from the default, so a small file (fast path), a cache reopen, a server load or a load
 * the arena cannot serve reports off.
 */
export function configureOutOfCore(
  processor: Pick<GeometryProcessor, 'outOfCore' | 'onOutOfCoreDecision'>,
  { recordArm }: { recordArm: boolean },
  readFeatureFlag?: (key: string) => unknown,
): void {
  processor.outOfCore = isPerfFlagOn(resolvePerfFlag(getPerfFlagDefinition('outOfCore'), readFeatureFlag));
  processor.onOutOfCoreDecision = recordArm ? (ran) => recordAppliedPerfFlag('outOfCore', ran) : undefined;
}

/** A primary load starts from the default arm until its pool reports. */
export function resetOutOfCoreArm(): void {
  recordAppliedPerfFlag('outOfCore', false);
}
