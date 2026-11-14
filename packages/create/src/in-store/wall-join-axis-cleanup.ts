/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A rewritten wall gets a fresh Axis representation (its old one may be shared
 * with another wall, so it is never edited in place). One this session built is
 * removed as it is replaced (`wall-join-apply.ts`); one the loaded FILE owns
 * stayed behind unreferenced, and IfcShapeModel.WR11 requires a representation
 * to belong to a product shape, a representation map or a shape aspect, so the
 * export of an edited loaded model failed express validation (#9296 lane U3).
 *
 * After the rewrite, each replaced file Axis representation that nothing
 * references any more is removed, with its curve and points when nothing else
 * uses them. One still referenced (a shared representation) stays.
 */

import { effectiveReferencers } from '@ifc-lite/export';
import type { StoreEditor } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';

export function dropReplacedSourceAxes(store: IfcDataStore, editor: StoreEditor, axisRepIds: Iterable<number | null>): void {
  const view = editor.getMutationView();
  const live = (id: number) => !view.getTombstones().has(id) && editor.hasEntity(id);
  const candidates = [...new Set(axisRepIds)].filter((id): id is number => id !== null && editor.getNewEntity(id) === null && live(id));
  if (candidates.length === 0) return;
  const referencers = effectiveReferencers(store, view);
  const refs = (id: number, slot: number): number[] => {
    const value = effectiveMetadataRecord(store, id, view)?.attributes[slot];
    return (Array.isArray(value) ? value : []).flatMap(ref => {
      const n = typeof ref === 'number' ? ref : typeof ref === 'string' && /^#\d+$/.test(ref) ? Number(ref.slice(1)) : null;
      return n === null ? [] : [n];
    });
  };
  // Only the removed records point at it: nothing else would lose a reference.
  const onlyFrom = (id: number, owners: ReadonlySet<number>) => referencers(id).every(parent => owners.has(parent));
  for (const repId of candidates) {
    if (referencers(repId).length > 0) continue;
    const removed = new Set([repId]);
    // IfcShapeRepresentation.Items (slot 3), each an IfcPolyline whose Points (slot 0) are IfcCartesianPoints.
    const curves = refs(repId, 3).filter(id => editor.getEntityType(id)?.toUpperCase() === 'IFCPOLYLINE' && onlyFrom(id, removed));
    for (const curve of curves) removed.add(curve);
    const points = [...new Set(curves.flatMap(curve => refs(curve, 0)))].filter(id => onlyFrom(id, removed));
    for (const id of [repId, ...curves, ...points]) editor.removeEntity(id);
  }
}
