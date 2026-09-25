/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  type IfcDataStore,
} from '@ifc-lite/parser';

/**
 * Resolve an entity's BASE (pre-overlay) value for one of the IfcRoot /
 * IfcElement attributes editable via `setAttribute` — GlobalId, Name,
 * Description, ObjectType, Tag. Backs `MutablePropertyView.getEffectiveChanges()`'s
 * `previousValue` for attribute edits (issue #1915), reading the columnar
 * entity table directly rather than the overlay's own `oldValue`, which
 * undo can leave stale (see `MutablePropertyView.getEffectiveChanges()` doc).
 * Returns `null` for an attribute the table doesn't expose a base reader for
 * (e.g. `Tag` on a store without `getTag`), or an empty base value.
 */
export function resolveBaseAttributeValue(
  dataStore: IfcDataStore,
  entityId: number,
  attrName: string,
): string | null {
  const entities = dataStore.entities;
  if (!entities) return null;
  switch (attrName) {
    case 'GlobalId':
      return entities.getGlobalId(entityId) || null;
    case 'Name':
      return entities.getName(entityId) || null;
    case 'Description':
      return entities.getDescription(entityId) || null;
    case 'ObjectType':
      return entities.getObjectType(entityId) || null;
    case 'Tag':
      return entities.getTag ? entities.getTag(entityId) || null : null;
    default:
      return null;
  }
}

const typeObjectByClass = new Map<string, boolean>();

/**
 * Whether `typeName` is an IfcTypeObject subtype, whose own sets sit in
 * `HasPropertySets`. By schema ancestry, not by an "ends in Type" name test,
 * which missed IFC2X3's `IfcDoorStyle` / `IfcWindowStyle` (#5966).
 */
function isTypeObjectClass(typeName: string): boolean {
  let known = typeObjectByClass.get(typeName);
  if (known === undefined) {
    known = getInheritanceChainAcrossSchemas(typeName).includes('IfcTypeObject');
    typeObjectByClass.set(typeName, known);
  }
  return known;
}

/**
 * The store each view's base readers were last pointed at by
 * {@link configureMutationView}. Weak, so it never keeps a view or a store
 * alive. Read by the store-swap rebinding in
 * `store/mutation-view-store-binding.ts` (#5672).
 */
const baseStoreByView = new WeakMap<MutablePropertyView, IfcDataStore>();

/** The store `view`'s base readers currently read, or `undefined` if it was never configured here. */
export function mutationViewBaseStore(view: MutablePropertyView): IfcDataStore | undefined {
  return baseStoreByView.get(view);
}

/**
 * Configure a mutation view so its base reads match the viewer's property panel.
 * Type entities need a dedicated extraction path because their own HasPropertySets
 * are not exposed through the regular occurrence property extractor.
 *
 * Safe to call again on the same view with a newer store that has source bytes
 * (the loader's partial -> full swap): the property, quantity and attribute
 * readers are all replaced, so the view then reads the new store's base data
 * (#5672). The constructor's base property table cannot be re-pointed, so a
 * sourceless (table-backed) store is not a valid rebind target.
 */
export function configureMutationView(
  mutationView: MutablePropertyView,
  dataStore: IfcDataStore
): void {
  baseStoreByView.set(mutationView, dataStore);
  if (dataStore.source?.length > 0) {
    mutationView.setOnDemandExtractor((entityId: number) => {
      const typeName = dataStore.entities?.getTypeName(entityId) ?? '';
      if (isTypeObjectClass(typeName)) {
        return extractTypeEntityOwnProperties(dataStore, entityId);
      }
      return extractPropertiesOnDemand(dataStore, entityId);
    });
  }

  if (dataStore.onDemandQuantityMap && dataStore.source?.length > 0) {
    mutationView.setQuantityExtractor((entityId: number) => {
      return extractQuantitiesOnDemand(dataStore, entityId);
    });
  }

  mutationView.setAttributeExtractor((entityId: number, attrName: string) =>
    resolveBaseAttributeValue(dataStore, entityId, attrName));
}
