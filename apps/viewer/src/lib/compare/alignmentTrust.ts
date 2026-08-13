/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which stored geometry facts survive federation alignment (#1993).
 *
 * Its own module rather than a member of `buildFingerprints.ts` because every
 * consumer of `MeshData.geometryVolume` needs this question answered, not just
 * Compare — the Measure tool (#2199) and Zones (#2508) read the same field —
 * and reaching into `buildFingerprints` for one predicate would drag
 * `@ifc-lite/diff` into chunks that have no diff in them. `buildFingerprints`
 * re-exports it, so the existing import path is unchanged.
 */

import type { FederatedModel } from '@/store/types';

/**
 * Do a model's proved volumes (#1993) still describe its geometry after
 * federation alignment put it where it now is?
 *
 * `'same-crs'` and `'reprojected'` re-bake every vertex through a map that
 * carries a SCALE, so a volume measured before it is a volume of geometry at a
 * size that is no longer on screen — and unlike the world box, it cannot be
 * re-measured on this side. Every other status left the vertices alone:
 * `'anchor'` and `'none'` never transformed anything, `'identity'` computed a
 * transform and found nothing to apply, and `'failed'` gave up before applying
 * one.
 *
 * An unset status is a model that predates federation entirely — trusted.
 */
export function geometryVolumesSurviveAlignment(
  status: FederatedModel['federationAlignmentStatus'],
): boolean {
  return status !== 'same-crs' && status !== 'reprojected';
}
