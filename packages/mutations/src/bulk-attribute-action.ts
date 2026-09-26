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

import { exactTypeName, type EntityTable } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation } from './types.js';
import { allSchemaAttributeNames, schemaAttributeNames, type ModelSchema } from './schema-attribute-names.js';

/**
 * The root attributes a bulk run may write: the ones the overlay stores
 * as plain strings and the exporter rewrites by name. `GlobalId` is left
 * out on purpose, since one value across a selection duplicates it.
 */
export const BULK_WRITABLE_ATTRIBUTES: readonly string[] = Object.freeze(['Name', 'Description', 'ObjectType', 'Tag']);

/**
 * The entity's class this session. A retype wins, as in the exporter and
 * `effective-entities`: `setEntityType` on a created entity records the
 * retype beside it and leaves `NewEntity.type` as authored.
 */
function effectiveClass(entities: EntityTable, view: MutablePropertyView, entityId: number): string {
  return view.getEntityTypeMutation(entityId)?.newType
    ?? view.getNewEntity(entityId)?.type
    ?? exactTypeName(entities, entityId);
}

/**
 * Whether the exporter can write `attribute` on a `ifcClass` record. Mirrors
 * its lookup (`attrIndex`): the model's own schema decides when it knows the
 * class; otherwise every bundled schema that knows the class must declare the
 * attribute, so no model can drop the write. A class no bundled table knows
 * (the IFC4X3 stratum aliases, #860) is refused: a false refusal is reported,
 * a false acceptance would be lost silently.
 */
function declares(ifcClass: string, attribute: string, schema: ModelSchema | undefined): boolean {
  const own = schema ? schemaAttributeNames(schema, ifcClass) : undefined;
  if (own) return own.includes(attribute);
  const layouts = allSchemaAttributeNames(ifcClass);
  return layouts.length > 0 && layouts.every((names) => names.includes(attribute));
}

/** Why a bulk run can never write `attribute`, or `null` when it is writable. */
export function bulkAttributeRefusal(attribute: string): string | null {
  return BULK_WRITABLE_ATTRIBUTES.includes(attribute)
    ? null
    : `"${attribute}" is not an attribute a bulk edit can set (${BULK_WRITABLE_ATTRIBUTES.join(', ')})`;
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
  schema?: ModelSchema,
): Mutation {
  const refusal = bulkAttributeRefusal(attribute);
  if (refusal) throw new Error(refusal);
  const ifcClass = effectiveClass(entities, view, entityId);
  if (!declares(ifcClass, attribute, schema)) {
    throw new Error(allSchemaAttributeNames(ifcClass).length === 0
      ? `${ifcClass} is not a class in the bundled IFC schemas, so ${attribute} cannot be checked`
      : `${ifcClass} has no ${attribute} attribute${schema ? ` in ${schema}` : ''}`);
  }
  const previous = view.getAttributeMutationsForEntity(entityId).find((edit) => edit.name === attribute);
  return view.setAttribute(entityId, attribute, value, previous?.value);
}
