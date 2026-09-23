/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Named reads of an overlay-created entity's attributes (#5198). A created
 * entity has no `EntityTable` row and no source bytes. Its attributes are the
 * positional payload it was created with, in the layout of its authored
 * class. Consumers that match on `GlobalId`, `Name` or `Tag` need those by
 * name.
 *
 * Precedence mirrors the rest of this package: a queued named attribute edit
 * (`setAttribute`) wins over the authored payload.
 */

import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { NewEntity } from './types.js';

let attributeNamesByType: Map<string, readonly string[]> | null = null;

/** Attribute names of a class in declaration order, across the bundled schemas. */
function attributeNames(type: string): readonly string[] {
  if (!attributeNamesByType) {
    attributeNamesByType = new Map();
    // Newest schema first: a class the IFC4X3 table carries is laid out as
    // IFC4X3 declares it. Older schemas only fill classes it dropped.
    for (const table of [ENTITIES_IFC4X3, ENTITIES_IFC4, ENTITIES_IFC2X3]) {
      for (const entity of table) {
        const key = entity.name.toUpperCase();
        if (!attributeNamesByType.has(key)) attributeNamesByType.set(key, entity.attributes);
      }
    }
  }
  return attributeNamesByType.get(type.toUpperCase()) ?? [];
}

/**
 * The string value of attribute `name` on an overlay-created entity: a queued
 * named edit, else the authored positional value. `''` when the class has no
 * such attribute or the slot is unset or non-textual.
 */
export function createdEntityStringAttribute(
  view: MutablePropertyView,
  entity: NewEntity,
  name: string,
): string {
  for (const edit of view.getAttributeMutationsForEntity(entity.expressId)) {
    if (edit.name === name) return edit.value;
  }
  const index = attributeNames(entity.type).indexOf(name);
  if (index < 0) return '';
  const raw = entity.attributes[index];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'typed' in raw) {
    const value = raw.typed.value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}
