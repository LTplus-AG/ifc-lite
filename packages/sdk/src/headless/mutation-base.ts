/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypeEntityOwnQuantities,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';

/** Mutation overlays must include the full source set before rewriting it (#8056). */
export function configureSourceMutationView(store: IfcDataStore, view: MutablePropertyView): void {
  if (!store.source?.length) return;
  const typeClasses = new Map<string, boolean>();
  const isTypeObject = (id: number): boolean => {
    const name = store.entityIndex.byId.get(id)?.type;
    if (!name) return false;
    let result = typeClasses.get(name);
    if (result === undefined) {
      // IFC2X3 IfcWindowStyle carries HasPropertySets too; a Type suffix
      // test misses it and incorrectly includes IfcRelDefinesByType.
      result = getInheritanceChainAcrossSchemas(name).includes('IfcTypeObject');
      typeClasses.set(name, result);
    }
    return result;
  };
  view.setOnDemandExtractor(id => isTypeObject(id)
    ? extractTypeEntityOwnProperties(store, id)
    : extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor(id => isTypeObject(id)
    ? extractTypeEntityOwnQuantities(store, id)
    : extractQuantitiesOnDemand(store, id));
}
