/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView } from '@ifc-lite/mutations';
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

/**
 * Configure a mutation view so its base reads match the viewer's property panel.
 * Type entities need a dedicated extraction path because their own HasPropertySets
 * are not exposed through the regular occurrence property extractor.
 */
export function configureMutationView(
  mutationView: MutablePropertyView,
  dataStore: IfcDataStore
): void {
  if (dataStore.source?.length > 0) {
    mutationView.setOnDemandExtractor((entityId: number) => {
      const typeName = dataStore.entities?.getTypeName(entityId) ?? '';
      if (typeName.endsWith('Type')) {
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
