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
 *
 * `Fixed` in the IfcLite record is an explicit fixed-height wall: it
 * overrides a Revit record, so making a Revit-attached wall fixed sticks.
 * A record that names no single live storey (a deleted storey's GlobalId, a
 * Revit level renamed or shared by two storeys) is not guessed at:
 * `topAttachmentProblem` reports it and the plan lists it as a notice.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreyInventory } from './storey-model.js';

export const STOREY_ATTACHMENT_PSET = 'IfcLite_StoreyAttachment';
export const TOP_CONSTRAINT = 'TopConstraint';
export const NEXT_STOREY_ABOVE = 'NextStoreyAbove';
export const FIXED_HEIGHT = 'Fixed';

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
    if (own === FIXED_HEIGHT) return null;
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

/**
 * Why a wall's recorded attachment cannot be followed, or null when it can
 * (or the wall records none): the record names no single live storey.
 */
export function topAttachmentProblem(inventory: StoreyInventory, wallId: number): string | null {
  const view = inventory.view;
  const own = text(view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT));
  if (own) {
    if (own === FIXED_HEIGHT || own === NEXT_STOREY_ABOVE) return null;
    return inventory.storeys.some((storey) => storey.GlobalId === own) ? null : `its top is attached to a storey that no longer exists (${own})`;
  }
  const level = REVIT_LEVEL.exec(text(view.getPropertyValue(wallId, REVIT_PSET, REVIT_TOP)) ?? '')?.[1];
  if (!level) return null;
  const named = inventory.storeys.filter((storey) => storey.Name.trim().toLowerCase() === level.toLowerCase()).length;
  if (named === 1) return null;
  return named === 0
    ? `Revit records its top up to level "${level}", which no storey is called`
    : `Revit records its top up to level "${level}", which ${named} storeys are called`;
}

/** Record a wall as attached to `target` (a storey GlobalId or `NextStoreyAbove`). */
export function writeTopAttachment(view: MutablePropertyView, wallId: number, target: string): void {
  view.setProperty(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, target, PropertyValueType.Label);
}

/**
 * Make a wall fixed-height again. A wall Revit recorded as attached gets an
 * explicit `Fixed` record (the Revit property is the file's own and stays);
 * any other wall simply loses the IfcLite record.
 */
export function clearTopAttachment(view: MutablePropertyView, wallId: number): void {
  const revit = text(view.getPropertyValue(wallId, REVIT_PSET, REVIT_TOP));
  if (revit && REVIT_LEVEL.test(revit)) {
    view.setProperty(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, FIXED_HEIGHT, PropertyValueType.Label);
  } else if (view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT) !== null) {
    view.deleteProperty(wallId, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT);
  }
}
