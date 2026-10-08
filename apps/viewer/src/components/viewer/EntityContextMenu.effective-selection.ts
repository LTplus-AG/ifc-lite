/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { type IfcDataStore } from '@ifc-lite/parser';

import { effectiveContextType } from '../../../../../packages/create/src/in-store/edit/effective-mutation-view.js';
export { effectiveContextType };

/** Source, retyped, and created ids of the clicked entity's current IFC class. */
export function sameEffectiveTypeIds(store: IfcDataStore, view: MutablePropertyView | null, expressId: number): number[] {
  const type = effectiveContextType(store, view, expressId);
  if (!type || view?.isDeleted(expressId)) return [];
  return Array.from(iterateEffectiveEntityIds(store, view, [type]), entity => entity.expressId);
}
