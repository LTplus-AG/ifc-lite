/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveSpatialAnchor } from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { CostStoreModelResolution } from './cost-store-backend.js';

/** `resolveSpatialAnchor` on `model`'s store, carrying the model's seeded GlobalId source (#10963). */
export function seededSpatialAnchor(
  model: Pick<CostStoreModelResolution, 'store' | 'guidRandom'>,
  storeyExpressId: number,
  view?: MutablePropertyView | null,
): ReturnType<typeof resolveSpatialAnchor> {
  return { ...resolveSpatialAnchor(model.store, storeyExpressId, view), guidRandom: model.guidRandom };
}
