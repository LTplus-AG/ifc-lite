/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryProcessor } from '@ifc-lite/geometry';
import { getPerfFlagDefinition, resolvePerfFlag } from '../lib/perf/flags.js';
import { recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { isPerfFlagOn } from './hugeGeometryConfig.js';

/**
 * Out-of-core geometry ingest (`@ifc-lite/geometry` geometry-parallel-sparse.ts), OFF by default, for one exact
 * load's processor. The geometry host reads only the global and `?perf.ooc`; the `perf-ooc` PostHog ramp reaches a
 * load only through `processor.outOfCore`, set here, so it never reaches exports or other processors.
 *
 * The ramp applies to a first attempt of a primary load only. A federated add and a retry (resource or tier) follow the
 * explicit global or URL param alone: a retry then takes the whole-file path the file opened with before the ramp,
 * and the arm (one per session) stays the primary's. The primary records whether its pool meshed out of core as the
 * telemetry arm, while it is still the current load (`isCurrent`), so a superseded load cannot label the next one.
 * {@link resetOutOfCoreArm} starts every primary load from the default, so a small file (fast path), a cache reopen,
 * a server load or a file the arena cannot serve reports off.
 */
export function configureOutOfCore(
  processor: Pick<GeometryProcessor, 'outOfCore' | 'onOutOfCoreDecision'>,
  { primary, retry, isCurrent }: { primary: boolean; retry: boolean; isCurrent: () => boolean },
  readFeatureFlag?: (key: string) => unknown,
): void {
  const ramp = primary && !retry ? readFeatureFlag : () => undefined;
  // Only an "on" is handed over: unset, the pool reads the explicit flag itself when the load starts.
  processor.outOfCore = isPerfFlagOn(resolvePerfFlag(getPerfFlagDefinition('outOfCore'), ramp)) ? true : undefined;
  processor.onOutOfCoreDecision = primary ? (ran) => { if (isCurrent()) recordAppliedPerfFlag('outOfCore', ran); } : undefined;
}

/** A primary load starts from the default arm until its pool reports. */
export function resetOutOfCoreArm(): void {
  recordAppliedPerfFlag('outOfCore', false);
}
