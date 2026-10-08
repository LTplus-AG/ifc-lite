/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractAllMaterialsOnDemand, extractMaterialPropertiesOnDemand, type IfcDataStore, type MaterialInfo } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { overlayMaterialProperties, overlayMaterials } from '@/lib/authoring/association-overlay';

/** The native panel's complete material assignment reader, shared with evidence (#7119). */
export function effectiveMaterials(store: IfcDataStore | null | undefined, expressId: number,
  view: MutablePropertyView | null | undefined): MaterialInfo[] {
  if (!store) return [];
  const baseId = view?.resolveBaseEntityId(expressId) ?? expressId;
  const session = overlayMaterials(view, [expressId, baseId], store.schemaVersion, store);
  return [...extractAllMaterialsOnDemand(store, baseId, session.length === 0), ...session];
}

/** Generic material sets from the same native reader, including live property edits. */
export function effectiveMaterialProperties(store: IfcDataStore | null | undefined, expressId: number,
  view: MutablePropertyView | null | undefined, revision: number) {
  if (!store) return [];
  const baseId = view?.resolveBaseEntityId(expressId) ?? expressId;
  const session = overlayMaterials(view, [expressId, baseId], store.schemaVersion, store);
  const groups = [...extractMaterialPropertiesOnDemand(store, baseId, view, revision, session.length === 0),
    ...overlayMaterialProperties(view, [expressId, baseId], store, revision)];
  return [...new Map(groups.map(group => [group.materialId, group])).values()];
}
