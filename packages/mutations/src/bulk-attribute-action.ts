/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkQueryEngine`'s `SET_ATTRIBUTE` action (#5867).
 *
 * The action used to return `null` for every entity ("for now, we'll skip
 * these"), so a run reported success with nothing written. It now writes
 * through `MutablePropertyView.setAttribute`, the path the Properties panel
 * uses, under the exact EXPRESS attribute name. An attribute the entity's
 * class does not declare (`ObjectType` on a type object, `Tag` on a spatial
 * element) would be dropped at export without a word, so it is refused per
 * entity instead: the run then reports the failure rather than a success.
 */

import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4_EXPRESS,
  ENTITIES_IFC4X3,
  exactTypeName,
  type EntityTable,
  type IfcEntityInfo,
} from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation } from './types.js';

/**
 * The root attributes a bulk run may write: the ones the overlay stores
 * as plain strings and the exporter rewrites by name. `GlobalId` is left
 * out on purpose, since one value across a selection duplicates it.
 */
export const BULK_WRITABLE_ATTRIBUTES: readonly string[] = ['Name', 'Description', 'ObjectType', 'Tag'];

let declaredAttributes: Map<string, Set<string>> | null = null;

/** Class (UPPERCASE) -> every attribute it declares or inherits, in any bundled schema. */
function attributesByClass(): Map<string, Set<string>> {
  if (declaredAttributes) return declaredAttributes;
  const map = new Map<string, Set<string>>();
  const tables: ReadonlyArray<readonly IfcEntityInfo[]> = [ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3];
  for (const table of tables) {
    for (const entity of table) {
      const key = entity.name.toUpperCase();
      let attrs = map.get(key);
      if (!attrs) map.set(key, attrs = new Set());
      for (const attr of entity.attributes) attrs.add(attr);
    }
  }
  declaredAttributes = map;
  return map;
}

/** The entity's class this session: a created entity's, a retype's, else the parsed one. */
function effectiveClass(entities: EntityTable, view: MutablePropertyView, entityId: number): string {
  return view.getNewEntity(entityId)?.type
    ?? view.getEntityTypeMutation(entityId)?.newType
    ?? exactTypeName(entities, entityId);
}

/**
 * Write `attribute = value` on one entity, recording the overlay value it
 * replaces (if any) so undo restores it; undoing a first edit removes the
 * override and the entity reads its parsed value again. Throws, with a
 * message naming the entity's class, when the attribute cannot be written.
 */
export function applyBulkAttribute(
  entities: EntityTable,
  view: MutablePropertyView,
  entityId: number,
  attribute: string,
  value: string,
): Mutation {
  if (!BULK_WRITABLE_ATTRIBUTES.includes(attribute)) {
    throw new Error(`"${attribute}" is not an attribute a bulk edit can set (${BULK_WRITABLE_ATTRIBUTES.join(', ')})`);
  }
  const ifcClass = effectiveClass(entities, view, entityId);
  if (!attributesByClass().get(ifcClass.toUpperCase())?.has(attribute)) {
    throw new Error(`${ifcClass} has no ${attribute} attribute`);
  }
  const previous = view.getAttributeMutationsForEntity(entityId).find((edit) => edit.name === attribute);
  return view.setAttribute(entityId, attribute, value, previous?.value);
}
