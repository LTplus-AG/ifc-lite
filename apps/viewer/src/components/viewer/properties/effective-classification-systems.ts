/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { EntityExtractor, extractClassificationSystemsOnDemand, type IfcDataStore } from '@ifc-lite/parser';

/** The classification systems visible in one model's current edit session. */
export function effectiveClassificationSystems(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): { names: string[]; unresolved: boolean } {
  if (!view) return extractClassificationSystemsOnDemand(store);

  const names = new Set<string>();
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  let unresolved = false;

  for (const entity of iterateEffectiveEntityIds(store, view, ['IfcClassification'])) {
    const authored = entity.overlayCreated ? view.getNewEntity(entity.expressId) : null;
    const positionalName = view.getPositionalMutationsForEntity(entity.expressId)?.get(3);
    const editedName = view.getAttributeMutationsForEntity(entity.expressId)
      .find((attribute) => attribute.name === 'Name');
    let name: unknown = authored?.attributes[3];
    if (!authored && positionalName === undefined && !editedName) {
      // @raw-entity-enumeration-ok Point read for one effective source row; membership and retypes were resolved above.
      const ref = store.entityIndex.byId.get(entity.expressId);
      if (!extractor) {
        unresolved = true;
      } else if (ref) {
        name = extractor.extractEntity(ref)?.attributes?.[3];
      }
    }

    if (positionalName !== undefined) name = positionalName;
    // Named edits win over positional edits, as in the STEP effective reader.
    if (editedName) name = editedName.value;
    if (typeof name === 'string' && name.length > 0) names.add(name);
  }

  return { names: [...names].sort(), unresolved };
}
