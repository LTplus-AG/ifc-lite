/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractAllMaterialsOnDemand, extractMaterialPropertiesOnDemand, type IfcDataStore, type MaterialInfo } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** The native panel's complete material assignment reader, shared with evidence (#7119). */
export function effectiveMaterials(store: IfcDataStore | null | undefined, expressId: number,
  view: MutablePropertyView | null | undefined): MaterialInfo[] {
  if (!store) return [];
  return extractAllMaterialsOnDemand(store, expressId, view);
}

/** Generic material sets from the same native reader, including live property edits. */
export function effectiveMaterialProperties(store: IfcDataStore | null | undefined, expressId: number,
  view: MutablePropertyView | null | undefined, revision: number) {
  if (!store) return [];
  return extractMaterialPropertiesOnDemand(store, expressId, view, revision);
}
