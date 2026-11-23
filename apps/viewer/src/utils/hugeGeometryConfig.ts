/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getPerfFlagDefinition, readPerfFlag, resolvePerfFlag, type PerfFlagId } from '../lib/perf/flags.js';

/** A boolean perf flag as globals, URL params and PostHog spell it. */
export function isPerfFlagOn(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

/**
 * Huge-geometry umbrella, OFF by default: `?perf.huge=1` or
 * `globalThis.__IFC_LITE_HUGE = 1` turns on the recommended render paths
 * together, the draw stream with shared arenas, far-field HLOD and the
 * highlight index (`drawStreamConfig.ts`) and GPU-driven instancing
 * (`gpuInstancingConfig.ts`). Read once at renderer init.
 *
 * Precedence for each path: its own global or URL param, then this
 * umbrella, then its PostHog ramp, then off. An explicit `?perf.huge=1`
 * therefore beats a ramp that is not (yet) on for this user, and
 * `?perf.huge=1&m6.hlod=0` or `&perf.gpuInstancing=0` turns one part off.
 */
export function isHugeGeometryEnabled(): boolean {
  return isPerfFlagOn(readPerfFlag('hugeGeometry'));
}

/**
 * A path's ramp flag with the umbrella's precedence: PostHog is consulted
 * only while the umbrella is off. `readFeatureFlag` is injectable for tests.
 */
export function readRampFlag(id: PerfFlagId, umbrellaOn: boolean, readFeatureFlag?: (key: string) => unknown): unknown {
  return resolvePerfFlag(getPerfFlagDefinition(id), umbrellaOn ? () => undefined : readFeatureFlag);
}
