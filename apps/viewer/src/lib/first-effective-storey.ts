/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';

/** Select an existing storey from the same entity set that export will write. */
export function firstEffectiveStoreyId(store: IfcDataStore, view: MutablePropertyView): number | null {
  return iterateEffectiveEntityIds(store, view, ['IFCBUILDINGSTOREY']).next().value?.expressId ?? null;
}
