/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from './resolve-anchor.js';
import { planStoreyReassignment, type StoreyReassignmentPlan } from './storey-reassignment-plan.js';

/** Transactional, same-identity move. Existing local placement identities are
 * retained so dependent placement chains keep following their original parent.
 * Caller records this one compound operation for native history/Undo (#7328). */
export function reassignElementsToStoreyInStore(
  store: IfcDataStore, editor: StoreEditor, selectedIds: readonly number[], sourceStoreyId: number, destinationStoreyId: number,
  expected?: StoreyReassignmentPlan,
): StoreyReassignmentPlan {
  return editor.runAtomic(draft => {
    const view = draft.getMutationView();
    const plan = planStoreyReassignment(store, view, selectedIds, sourceStoreyId, destinationStoreyId);
    if (expected && JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error('reassignElementsToStoreyInStore: reviewed source, dependency or destination frame is stale');
    const reader = new AnchorEntityReader(store, view);
    const ownerHistory = reader.firstId('IFCOWNERHISTORY');
    if (store.schemaVersion === 'IFC2X3' && ownerHistory === null) throw new Error('reassignElementsToStoreyInStore: IFC2X3 requires IfcOwnerHistory');
    const ref = (id: number) => `#${id}`;
    for (const placement of plan.placements) {
      const frame = placement.relative;
      const point = draft.addEntity('IfcCartesianPoint', [frame.o]).expressId;
      const z = draft.addEntity('IfcDirection', [frame.z]).expressId;
      const x = draft.addEntity('IfcDirection', [frame.x]).expressId;
      const axis = draft.addEntity('IfcAxis2Placement3D', [ref(point), ref(z), ref(x)]).expressId;
      draft.setPositionalAttribute(placement.expressId, 0, ref(plan.destinationPlacementId));
      draft.setPositionalAttribute(placement.expressId, 1, ref(axis));
    }
    const moved = new Set(plan.products.map(product => product.expressId));
    // Keep unrelated membership and all host/aggregate relationships intact.
    // Spaces retain spatial aggregation; physical products retain containment.
    const destinationGroups = new Map<string, number[]>();
    for (const membership of plan.sourceMemberships) {
      const remaining = membership.children.filter(id => !moved.has(id));
      if (remaining.length) draft.setPositionalAttribute(membership.id, membership.listIndex, remaining.map(ref));
      else if (!draft.removeEntity(membership.id)) throw new Error(`reassignElementsToStoreyInStore: cannot remove exhausted relationship #${membership.id}`);
      const children = destinationGroups.get(membership.type) ?? [];
      children.push(...membership.children.filter(id => moved.has(id))); destinationGroups.set(membership.type, children);
    }
    for (const [type, children] of destinationGroups) {
      const metadata = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
        ? [children.map(ref), ref(destinationStoreyId)]
        : [ref(destinationStoreyId), children.map(ref)];
      draft.addEntity(type, [generateIfcGuid(), ownerHistory === null ? null : ref(ownerHistory), null, null, ...metadata]);
    }
    return plan;
  });
}
