/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Types of IFC and local session history edits */
export type MutationType =
  | 'CREATE_PROPERTY'
  | 'UPDATE_PROPERTY'
  | 'DELETE_PROPERTY'
  | 'CREATE_PROPERTY_SET'
  | 'DELETE_PROPERTY_SET'
  | 'CREATE_QUANTITY'
  | 'UPDATE_QUANTITY'
  | 'DELETE_QUANTITY'
  /** A whole quantity set removed, the twin of `DELETE_PROPERTY_SET`. Distinct
   *  from `DELETE_QUANTITY`, which names one quantity inside a set: replaying a
   *  set removal as a member removal drops the set's other members on the
   *  floor, and both replay consumers key off `propName` being present. */
  | 'DELETE_QUANTITY_SET'
  | 'UPDATE_ATTRIBUTE'
  | 'UPDATE_POSITIONAL_ATTRIBUTE'
  | 'UPDATE_ENTITY_TYPE'
  | 'CREATE_ENTITY'
  | 'DELETE_ENTITY'
  /** Local domain history only; never changes IFC attributes or geometry. */
  | 'SESSION_EDIT';

