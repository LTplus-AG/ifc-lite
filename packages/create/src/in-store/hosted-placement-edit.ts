/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One fresh-placement writer for hosted moves and host reanchoring (#6232).
 * Source Location/RelativePlacement records can be shared across hosts. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { readHostOpeningExtents } from './hosted-element.js';
import { readHostedFill, type HostedFillRead } from './hosted-fill-read.js';
import { axis3d, placementInAncestor, refId, type Vec3 } from './host-geometry-frame.js';

const ref = (id: number) => `#${id}`;

/** A fresh placement prevents a shared source Location/RelativePlacement
 * from moving another occurrence. A filling directly follows its opening. */
export function moveHostedOpeningPlacement(reader: AnchorEntityReader, editor: StoreEditor, read: HostedFillRead, next: Vec3, targetHostId = read.hostId): void {
  if (next.length !== 3 || !next.every(Number.isFinite)) throw new Error('The opening location must contain three finite native lengths');
  const opening = reader.entity(read.openingId)!;
  const oldPlacementId = refId(opening.attributes[5]);
  const oldPlacement = oldPlacementId === null ? null : reader.entity(oldPlacementId);
  const oldAxisId = oldPlacement ? refId(oldPlacement.attributes[1]) : null;
  const oldAxis = oldAxisId === null ? null : reader.entity(oldAxisId);
  const parent = oldPlacement ? refId(oldPlacement.attributes[0]) : null;
  const host = reader.entity(read.hostId);
  const hostPlacement = host ? refId(host.attributes[5]) : null;
  if (!oldAxis || parent === null || hostPlacement !== parent || oldPlacementId === null
    || !placementInAncestor(reader, oldPlacementId, parent)) throw new Error('The opening placement cannot be edited safely');
  const targetHost = reader.entity(targetHostId);
  const targetPlacementId = targetHost ? refId(targetHost.attributes[5]) : null;
  const targetPlacement = targetPlacementId === null ? null : reader.entity(targetPlacementId);
  const targetAxisId = targetPlacement ? refId(targetPlacement.attributes[1]) : null;
  const targetAxis = targetAxisId === null ? null : reader.entity(targetAxisId);
  if (!targetPlacement || targetPlacement.type.toUpperCase() !== 'IFCLOCALPLACEMENT'
    || targetAxisId === null || targetAxis?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D'
    || !axis3d(reader, targetAxisId)) throw new Error('The target host placement cannot be edited safely');
  const direction = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const id = refId(value);
    if (id === null) throw new Error('An unreadable placement direction is refused');
    return ref(id);
  };
  const point = editor.addEntity('IfcCartesianPoint', [next]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [ref(point), direction(oldAxis.attributes[1]), direction(oldAxis.attributes[2])]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [ref(targetPlacementId!), ref(axis)]).expressId;
  if (read.fillingId !== null) {
    const filling = reader.entity(read.fillingId)!;
    const fillingPlacementId = refId(filling.attributes[5]);
    const fillingPlacement = fillingPlacementId === null ? null : reader.entity(fillingPlacementId);
    const fillingAxis = fillingPlacement ? refId(fillingPlacement.attributes[1]) : null;
    if (!fillingPlacement || refId(fillingPlacement.attributes[0]) !== oldPlacementId || fillingAxis === null
      || fillingPlacementId === null || !placementInAncestor(reader, fillingPlacementId, parent)) {
      throw new Error('A filling not placed directly in its opening cannot be moved safely');
    }
    const nextFilling = editor.addEntity('IfcLocalPlacement', [ref(placement), ref(fillingAxis)]).expressId;
    editor.setPositionalAttribute(read.fillingId, 5, ref(nextFilling));
  }
  editor.setPositionalAttribute(read.openingId, 5, ref(placement));
}

export interface HostedOpeningReassignment {
  readonly openingId: number;
  readonly hostId: number;
  /** Opening origin in the target host frame, in native file units. */
  readonly location: Vec3;
}

/** Apply a validated split/rehost plan atomically. Every opening, filling and
 * void relation keeps its identity; only the selected occurrence receives
 * fresh placements and its void relation's host changes. Source placement
 * records stay untouched. The caller decides the final host/fit for all cuts;
 * this batch never validates against intermediate single-move positions. */
export function reassignHostedOpeningsInStore(
  store: IfcDataStore, editor: StoreEditor, sourceHostId: number, moves: readonly HostedOpeningReassignment[],
): void {
  editor.runAtomic(draft => {
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    const sourceRelations = new Map<number, number[]>();
    for (const id of reader.ids('IFCRELVOIDSELEMENT')) {
      const rel = reader.entity(id);
      if (!rel || refId(rel.attributes[4]) !== sourceHostId) continue;
      const openingId = refId(rel.attributes[5]);
      if (openingId === null) continue;
      const ids = sourceRelations.get(openingId) ?? [];
      ids.push(id);
      sourceRelations.set(openingId, ids);
    }
    const seen = new Set<number>();
    const plan = moves.map(move => {
      if (seen.has(move.openingId)) throw new Error('An opening cannot be reassigned twice in one batch');
      seen.add(move.openingId);
      const read = readHostedFill(store, move.openingId, view);
      if (!read || read.hostId !== sourceHostId) throw new Error('The opening does not belong to the source host');
      const relations = sourceRelations.get(move.openingId) ?? [];
      if (relations.length !== 1) throw new Error('An opening must have exactly one source void relationship');
      return { move, read, relationId: relations[0] };
    });
    for (const { move, read, relationId } of plan) {
      moveHostedOpeningPlacement(reader, draft, read, move.location, move.hostId);
      if (move.hostId !== sourceHostId) draft.setPositionalAttribute(relationId, 4, ref(move.hostId));
    }
  });
}

/** Reanchor every opening after a host-origin translation. `shift` is the
 * host's origin displacement in its own frame, in native file units. The
 * caller validates the final host body before changing its placement.
 * Reanchor the whole batch without applying single-move fit/overlap checks
 * to transient positions; the cuts keep their relative positions and shape.
 * Unreadable cuts or placements refuse with no surviving writes. */
export function reanchorHostedOpeningsInStore(
  store: IfcDataStore, editor: StoreEditor, hostId: number, shift: Vec3,
): void {
  if (shift.length !== 3 || !shift.every(Number.isFinite)) throw new Error('The host displacement must contain three finite native lengths');
  editor.runAtomic(draft => {
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    const { cuts, unreadable } = readHostOpeningExtents(store, hostId, view);
    if (unreadable.length > 0) throw new Error('Unreadable hosted cuts cannot be reanchored safely');
    for (const cut of cuts) {
      moveHostedOpeningPlacement(reader, draft, cut, [
        cut.location[0] - shift[0], cut.location[1] - shift[1], cut.location[2] - shift[2],
      ]);
    }
  });
}
