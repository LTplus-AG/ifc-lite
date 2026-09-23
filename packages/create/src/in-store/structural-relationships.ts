/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The three relationships that turn loose `IfcStructural*` entities into a
 * connected analytical *model* (#5167 task S.1) — verified against the
 * generated IFC4 registry's `allAttributes`:
 *
 *   `IfcRelConnectsStructuralMember`: `GlobalId, OwnerHistory?, Name?,
 *    Description?, RelatingStructuralMember, RelatedStructuralConnection,
 *    AppliedCondition?, AdditionalConditions?, SupportedLength?,
 *    ConditionCoordinateSystem?`
 *   `IfcRelConnectsStructuralActivity`: `GlobalId, OwnerHistory?, Name?,
 *    Description?, RelatingElement, RelatedStructuralActivity`
 *    (`RelatingElement` is `IfcStructuralActivityAssignmentSelect` =
 *    `IfcElement | IfcStructuralItem` — a member or connection here)
 *   `IfcRelAssignsToGroup`: `GlobalId, OwnerHistory?, Name?, Description?,
 *    RelatedObjects, RelatedObjectsType?, RelatingGroup` — used both for
 *    "these members/connections belong to this analysis model" and "these
 *    activities belong to this load group", exactly as
 *    `extractStructuralOnDemand` in `@ifc-lite/parser` reads it back (see
 *    that module's doc comment on why one relationship type serves both:
 *    the reader narrows a group's `RelatedObjects` by the role each
 *    collection promises, not by relationship subtype).
 *
 * Every call here emits a FRESH relationship rather than mutating an
 * existing one for the same target — the same choice `column.ts` makes for
 * `IfcRelContainedInSpatialStructure` ("Adding a parallel relationship is
 * simpler than mutating the storey's existing one and produces an
 * equivalent result on import"). Unlike `cost.ts`'s
 * `assignCostItemsToScheduleInStore`, there is no merge-into-existing-list
 * variant here; a caller assigning the same object into the same group
 * twice gets two `IfcRelAssignsToGroup` records, which importers fold
 * together same as `IfcRelContainedInSpatialStructure` does.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { ownerHistoryRef } from './_emit-helpers.js';

/** Link a structural member to a structural connection (e.g. a curve member's end to its support). */
export function connectStructuralMemberToConnectionInStore(
  editor: StoreEditor,
  ownerHistoryId: number | null,
  memberId: number,
  connectionId: number,
  random?: RandomSource,
): number {
  return editor.addEntity('IfcRelConnectsStructuralMember', [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
    null,
    null,
    `#${memberId}`,
    `#${connectionId}`,
    null, // AppliedCondition
    null, // AdditionalConditions
    null, // SupportedLength
    null, // ConditionCoordinateSystem
  ]).expressId;
}

/** Apply a structural activity (action/reaction) to the member or connection it acts on. */
export function connectStructuralActivityToItemInStore(
  editor: StoreEditor,
  ownerHistoryId: number | null,
  itemId: number,
  activityId: number,
  random?: RandomSource,
): number {
  return editor.addEntity('IfcRelConnectsStructuralActivity', [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
    null,
    null,
    `#${itemId}`,
    `#${activityId}`,
  ]).expressId;
}

/**
 * Assign objects into an `IfcGroup` (an analysis model gathering its
 * members/connections, or a load group gathering its activities).
 * `objectIds` must be non-empty — `RelatedObjects` is `SET [1:?]`.
 */
export function assignToStructuralGroupInStore(
  editor: StoreEditor,
  ownerHistoryId: number | null,
  groupId: number,
  objectIds: readonly number[],
  random?: RandomSource,
): number {
  if (objectIds.length === 0) {
    throw new Error('assignToStructuralGroupInStore: objectIds must be non-empty (IfcRelAssignsToGroup.RelatedObjects is SET [1:?])');
  }
  return editor.addEntity('IfcRelAssignsToGroup', [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
    null,
    null,
    objectIds.map((id) => `#${id}`),
    null, // RelatedObjectsType
    `#${groupId}`,
  ]).expressId;
}
