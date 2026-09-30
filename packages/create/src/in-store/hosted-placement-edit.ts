/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One fresh-placement writer for hosted moves and host reanchoring (#6232).
 * Source Location/RelativePlacement records can be shared across hosts. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { readHostOpeningExtents } from './hosted-element.js';
import type { HostedFillRead } from './hosted-fill-read.js';
import { placementInAncestor, refId, type Vec3 } from './host-geometry-frame.js';

const ref = (id: number) => `#${id}`;

/** A fresh placement prevents a shared source Location/RelativePlacement
 * from moving another occurrence. A filling directly follows its opening. */
export function moveHostedOpeningPlacement(reader: AnchorEntityReader, editor: StoreEditor, read: HostedFillRead, next: Vec3): void {
  if (!next.every(Number.isFinite)) throw new Error('The opening location must contain finite native lengths');
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
  const direction = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const id = refId(value);
    if (id === null) throw new Error('An unreadable placement direction is refused');
    return ref(id);
  };
  const point = editor.addEntity('IfcCartesianPoint', [next]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [ref(point), direction(oldAxis.attributes[1]), direction(oldAxis.attributes[2])]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [ref(parent), ref(axis)]).expressId;
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
