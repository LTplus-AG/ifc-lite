/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read side for the type and material builders (#6232): the authoring anchor
 * of a model that needs no storey, and the live one-to-many relationships an
 * assignment has to extend or detach from. Both read through the mutation
 * overlay, so a type or relationship authored earlier in the session counts.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SpatialAnchorSchema } from './anchor.js';
import type { ExistingRelatedList } from './cost.js';
import type { AuthoringAnchor } from './element-type.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { conformsTo, schemaRegistry } from './schema-attributes.js';

function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) return Number(value.slice(1));
  return null;
}

/** Owner history, schema and length unit of a model, with the same IFC2X3 owner-history rule as `resolveSpatialAnchor`. */
export function resolveAuthoringAnchor(store: IfcDataStore, view?: MutablePropertyView | null): AuthoringAnchor {
  const reader = new AnchorEntityReader(store, view);
  const ownerHistoryId = reader.ids('IFCOWNERHISTORY').next().value ?? null;
  const schema = (store.schemaVersion ?? 'IFC4') as SpatialAnchorSchema;
  if (schema === 'IFC2X3' && ownerHistoryId === null) {
    throw new Error('resolveAuthoringAnchor: IFC2X3 requires IfcOwnerHistory, but the store has none');
  }
  const lengthUnitScale = store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, 'resolveAuthoringAnchor') ?? 1.0
    : 1.0;
  return { ownerHistoryId, schema, lengthUnitScale };
}

/** Every live `IfcRelDefinesByType` / `IfcRelAssociatesMaterial`: RelatedObjects (slot 4) and the relating side (slot 5). */
export function readRelatedLists(
  store: IfcDataStore,
  relType: 'IfcRelDefinesByType' | 'IfcRelAssociatesMaterial',
  view?: MutablePropertyView | null,
): ExistingRelatedList[] {
  const reader = new AnchorEntityReader(store, view);
  const lists: ExistingRelatedList[] = [];
  for (const relId of reader.ids(relType.toUpperCase())) {
    const rel = reader.entity(relId);
    const related = rel?.attributes[4];
    const relatingId = refId(rel?.attributes[5]);
    if (!Array.isArray(related) || relatingId === null) continue;
    lists.push({ relId, relatingId, relatedIds: related.map(refId).filter((id): id is number => id !== null) });
  }
  return lists;
}

/** The live entity's class in `IfcPascalCase`-insensitive form (upper case), or null when it does not exist. */
export function liveEntityType(store: IfcDataStore, id: number, view?: MutablePropertyView | null): string | null {
  return new AnchorEntityReader(store, view).entity(id)?.type.toUpperCase() ?? null;
}

/**
 * Whether live entity `id` is an `expected` in the model's schema (the class or
 * a subtype, or a member of the `expected` SELECT), e.g. `'IfcTypeObject'`,
 * `'IfcObject'` or `'IfcMaterialSelect'`. False when the entity is not live.
 */
export function liveEntityConforms(
  store: IfcDataStore,
  id: number,
  expected: string,
  view?: MutablePropertyView | null,
): boolean {
  const type = liveEntityType(store, id, view);
  if (type === null) return false;
  const schema = (store.schemaVersion ?? 'IFC4') as SpatialAnchorSchema;
  return conformsTo(schemaRegistry(schema, 'liveEntityConforms'), type, expected);
}
