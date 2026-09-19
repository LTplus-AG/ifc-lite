/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';

/** Validate one cost-control relationship member against the IFC hierarchy. */
export function requireAssignableIfcObject(
  editor: StoreEditor, id: number, relatingControlId: number, context: string,
): void {
  if (id === relatingControlId) {
    throw new Error(`${context}: relatingControlId #${id} cannot also be one of relatedObjectIds`);
  }
  const actual = editor.getEntityType(id);
  if (actual === undefined) throw new Error(`${context}: relatedObjectIds #${id} does not exist in this model`);
  const isIfcObject = getInheritanceChainAcrossSchemas(actual).includes('IfcObject');
  if (!isIfcObject) {
    throw new Error(`${context}: relatedObjectIds #${id} (${actual}) must be an IfcObject`);
  }
}
