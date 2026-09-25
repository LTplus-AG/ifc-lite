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

import type { MutablePropertyView } from './mutable-property-view.js';
import type { NewEntity } from './types.js';
import { allSchemaAttributeNames } from './schema-attribute-names.js';

/**
 * Attribute names of a class in declaration order. Newest schema first: a
 * class the IFC4X3 table carries is laid out as IFC4X3 declares it; older
 * schemas only fill classes it dropped.
 */
function attributeNames(type: string): readonly string[] {
  return allSchemaAttributeNames(type)[0] ?? [];
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
