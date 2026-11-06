/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which walls are attached to a storey above (#9013, requirement 4).
 *
 * IFC has no standard wall-top constraint, so attachment is RECORDED, never
 * inferred from a wall height that happens to equal the current spacing (a
 * fixed 3.00 m wall under a 3.00 m storey is still a fixed wall). Two records
 * are read:
 *
 * 1. `IfcLite_StoreyAttachment.TopConstraint` (IfcLabel), written by the
 *    Model workspace: the GlobalId of the storey the top is attached to, or
 *    `NextStoreyAbove` for a wall drawn as attached before any storey above
 *    existed (the blank-file case). The first storey added directly above
 *    binds it. GlobalIds survive export, reload and schema conversion, and
 *    the property is an ordinary overlay write, so it undoes with its edit.
 * 2. Revit's own export, `Constraints` › `Top Constraint` = `Up to level:
 *    <name>`: what the authoring tool recorded, matched to a storey by name.
 *    `Unconnected` (or no record) is a fixed-height wall.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreyInventory } from './storey-model.js';

export const STOREY_ATTACHMENT_PSET = 'IfcLite_StoreyAttachment';
export const TOP_CONSTRAINT = 'TopConstraint';
export const NEXT_STOREY_ABOVE = 'NextStoreyAbove';

const REVIT_PSET = 'Constraints';
const REVIT_TOP = 'Top Constraint';
const REVIT_LEVEL = /^\s*up to level\s*:\s*(.+?)\s*$/i;

export interface TopAttachment {
  /** The storey the top follows; null while unbound (`NextStoreyAbove` with no storey above yet). */
  readonly targetStoreyId: number | null;
  readonly source: 'ifclite' | 'revit';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The recorded top attachment of a wall, or null for a fixed-height wall. */
export function readTopAttachment(inventory: StoreyInventory, wallId: number): TopAttachment | null {
  const view = inventory.view;
  const own = text(view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT));
  if (own) {
    if (own === NEXT_STOREY_ABOVE) return { targetStoreyId: null, source: 'ifclite' };
    const storey = inventory.storeys.find((candidate) => candidate.GlobalId === own);
    // A GlobalId naming no live storey (it was deleted) leaves the wall fixed.
    return storey ? { targetStoreyId: storey.expressId, source: 'ifclite' } : null;
  }
  const revit = text(view.getPropertyValue(wallId, REVIT_PSET, REVIT_TOP));
  const level = revit ? REVIT_LEVEL.exec(revit)?.[1] : undefined;
  if (!level) return null;
  const named = inventory.storeys.filter((storey) => storey.Name.trim().toLowerCase() === level.toLowerCase());
  // Two storeys with that name: refuse to pick one.
  return named.length === 1 ? { targetStoreyId: named[0].expressId, source: 'revit' } : null;
}

/** Record a wall as attached to `target` (a storey GlobalId or `NextStoreyAbove`). */
export function writeTopAttachment(view: MutablePropertyView, wallId: number, target: string): void {
  view.setProperty(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, target, PropertyValueType.Label);
}

/** Make a wall fixed-height again. */
export function clearTopAttachment(view: MutablePropertyView, wallId: number): void {
  if (view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT) !== null) {
    view.deleteProperty(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT);
  }
}
