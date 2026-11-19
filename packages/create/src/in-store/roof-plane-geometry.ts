/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { effectiveReferencers } from '@ifc-lite/export';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';

/** Read every plane Body, including the single-body form authored before #9357. */
export function readRoofPlaneBodies(reader: AnchorEntityReader, products: readonly number[]) {
  const bodies = products.map(id => {
    const shapeId = refId(reader.entity(id)?.attributes[6]);
    const reps = shapeId === null ? null : reader.entity(shapeId)?.attributes[2];
    const repId = Array.isArray(reps) && reps.length === 1 ? refId(reps[0]) : null;
    const rep = repId === null ? null : reader.entity(repId)?.attributes;
    const context = refId(rep?.[0]), items = rep?.[3];
    if (shapeId === null || repId === null || context === null || rep?.[1] !== 'Body' || !Array.isArray(items)) {
      throw new Error(`Roof plane #${id} no longer has its single Body representation`);
    }
    const solids = items.map(refId);
    if (!solids.length || solids.some(id => id === null)) throw new Error('Unreadable roof plane Body items');
    return { shapeId, repId, context, solids: solids.filter((id): id is number => id !== null) };
  });
  if (!bodies.length || bodies.some(body => body.context !== bodies[0].context)) throw new Error('Roof planes need one geometry context');
  return bodies;
}

/** Retire replaced shape wrappers only when a saved copy no longer shares them. */
export function removeUnusedRoofBodies(store: IfcDataStore, editor: StoreEditor,
  bodies: ReturnType<typeof readRoofPlaneBodies>): void {
  const refs = effectiveReferencers(store, editor.getMutationView());
  for (const body of bodies) {
    if (refs(body.shapeId).length) continue;
    editor.removeEntity(body.shapeId);
    if (!refs(body.repId).length) editor.removeEntity(body.repId);
  }
}
