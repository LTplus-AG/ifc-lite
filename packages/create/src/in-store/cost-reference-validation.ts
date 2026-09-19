/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';

/** Require a live entity of one exact IFC class. */
export function requireEntityType(
  editor: StoreEditor, id: number, expectedType: string, attribute: string, context: string,
): void {
  const actual = editor.getEntityType(id);
  if (actual === undefined) throw new Error(`${context}: ${attribute} #${id} does not exist in this model`);
  if (actual.toUpperCase() !== expectedType.toUpperCase()) {
    throw new Error(`${context}: ${attribute} #${id} must be an ${expectedType}, got ${actual}`);
  }
}

/** Require a live entity whose exact class belongs to `allowedTypes`. */
export function requireEntityTypeOneOf(
  editor: StoreEditor, id: number, allowedTypes: ReadonlySet<string>, attribute: string, context: string,
): void {
  const actual = editor.getEntityType(id);
  if (actual === undefined) throw new Error(`${context}: ${attribute} #${id} does not exist in this model`);
  if (!allowedTypes.has(actual.toUpperCase())) {
    throw new Error(`${context}: ${attribute} #${id} must be one of ${[...allowedTypes].join(', ')}, got ${actual}`);
  }
}

/** Require a live entity that descends from one IFC schema supertype. */
export function requireEntitySubtype(
  editor: StoreEditor, id: number, supertype: string, attribute: string, context: string,
): void {
  const actual = editor.getEntityType(id);
  if (actual === undefined) throw new Error(`${context}: ${attribute} #${id} does not exist in this model`);
  if (!getInheritanceChainAcrossSchemas(actual).includes(supertype)) {
    throw new Error(`${context}: ${attribute} #${id} must be an ${supertype}, got ${actual}`);
  }
}

/** Validate one cost-control relationship member against the IFC hierarchy. */
export function requireAssignableIfcObjectDefinition(
  editor: StoreEditor, id: number, relatingControlId: number, context: string,
): void {
  if (id === relatingControlId) {
    throw new Error(`${context}: relatingControlId #${id} cannot also be one of relatedObjectIds`);
  }
  requireEntitySubtype(editor, id, 'IfcObjectDefinition', 'relatedObjectIds', context);
}
