/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getPerfFlagDefinition, resolvePerfFlag } from '../lib/perf/flags.js';
import { recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { isPerfFlagOn } from './hugeGeometryConfig.js';

/**
 * Whether a load asks its geometry workers for compact GPU records, OFF by
 * default: `?compactGeom=1`, else the `perf-compact-geom` PostHog ramp.
 *
 * Only a primary load does. A federated model's ids are re-homed after its
 * workers ran, so its records would carry the wrong ids: the renderer would
 * decode every one of them onto its f32 path again.
 */
export function compactGeometryRequested(kind: 'primary' | 'federated', readFeatureFlag?: (key: string) => unknown): boolean {
  if (kind !== 'primary') return false;
  return isPerfFlagOn(resolvePerfFlag(getPerfFlagDefinition('compactGeom'), readFeatureFlag));
}

/** How long a load waits for the compact code before it goes on without it. */
const COMPACT_CODE_WAIT_MS = 10_000;

/**
 * The cell size to hand `GeometryProcessor.compactCellSize` for this load, or
 * `undefined` to leave the encoder off. Nothing of the compact path is in the
 * eager bundle: a load that asks for it fetches compactGeometryConfig.ts and,
 * through it, the record decoder and the renderer's page code. A load that
 * does not ask fetches nothing, and one whose fetch fails or stalls uses f32
 * meshes.
 *
 * A primary load records its decision as the telemetry arm (`activePerfFlags`):
 * on only when the encoder is turned on, so a failed or stalled fetch reports
 * off. A load superseded meanwhile (`isCurrent` false) records nothing. Until a
 * primary load has decided, as for a cache hit, the arm is the ramp's assignment.
 */
export async function compactCellSizeForLoad(
  kind: 'primary' | 'federated',
  { readFeatureFlag, isCurrent = () => true }: { readFeatureFlag?: (key: string) => unknown; isCurrent?: () => boolean } = {},
): Promise<number | undefined> {
  if (kind !== 'primary') return undefined;
  const size = await cellSizeFor(compactGeometryRequested(kind, readFeatureFlag));
  if (isCurrent()) recordAppliedPerfFlag('compactGeom', size !== undefined);
  return size;
}

async function cellSizeFor(requested: boolean): Promise<number | undefined> {
  if (!requested) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A fetch that stalls must not hold the load: after the wait it proceeds on f32 meshes.
    const stalled = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), COMPACT_CODE_WAIT_MS); });
    return await Promise.race([import('./compactGeometryConfig.js').then((config) => config.enableCompactGeometry()), stalled]);
  } catch (error) {
    console.warn('[compactGeom] code failed to load; f32 meshes', error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
