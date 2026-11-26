/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readPerfFlag } from '../lib/perf/flags.js';

/**
 * Whether a load asks its geometry workers for compact GPU records
 * (`?compactGeom=1`, OFF by default).
 *
 * Only a primary load does. A federated model's ids are re-homed after its
 * workers ran, so its records would carry the wrong ids: the renderer would
 * decode every one of them onto its f32 path again.
 */
export function compactGeometryRequested(kind: 'primary' | 'federated'): boolean {
  if (kind !== 'primary') return false;
  const raw = readPerfFlag('compactGeom');
  return raw === 1 || raw === '1' || raw === true || raw === 'true';
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
 */
export async function compactCellSizeForLoad(kind: 'primary' | 'federated'): Promise<number | undefined> {
  if (!compactGeometryRequested(kind)) return undefined;
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
