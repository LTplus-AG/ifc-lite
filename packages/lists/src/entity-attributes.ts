/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The built-in entity attributes a list column may read (`ColumnDefinition.attribute`). */
export const ENTITY_ATTRIBUTES = [
  'Name',
  'GlobalId',
  'Class',
  'Type',
  'Description',
  'ObjectType',
  'PredefinedType',
  'Tag',
] as const;

export type EntityAttribute = typeof ENTITY_ATTRIBUTES[number];
