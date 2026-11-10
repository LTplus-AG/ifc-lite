/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EditTarget } from './edit/target.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { readTopAttachment } from './storey/storey-attachment.js';
import { setTopConstraintInStore } from './storey/storey-top-constraint.js';
/** Refit dependents inside the caller's atomic placement/shape edit. Returns products requiring remeshing. */
export function refreshTopAttachmentsInStore(target: EditTarget, moved: readonly number[], refit: readonly number[] = []): number[] {
  const targets = new Set(moved.filter(id => /^(IFCROOF|IFCSLAB|IFCSLABSTANDARDCASE|IFCSLABELEMENTEDCASE)$/.test(target.editor.getEntityType?.(id)?.toUpperCase() ?? '')));
  if (!targets.size && !refit.length) return [];
  const dependents = new Set(refit);
  const inventory = readStoreyInventory(target.dataStore, target.view), remesh: number[] = [];
  for (const type of ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE', 'IFCCOLUMN', 'IFCBEAM', 'IFCMEMBER', 'IFCCURTAINWALL']) {
    for (const id of inventory.reader.ids(type)) {
      const top = readTopAttachment(inventory, id);
      const targetId = top?.targetElementId;
      if (targetId === undefined || !targets.has(targetId) && !dependents.has(id)) continue;
      const roof = inventory.reader.entity(targetId)?.type.toUpperCase() === 'IFCROOF';
      const result = setTopConstraintInStore(target.dataStore, target.editor, id, roof ? { kind: 'roof', roofId: targetId } : { kind: 'slab', slabId: targetId });
      remesh.push(id, ...result.remesh);
    }
  }
  return [...new Set(remesh)];
}
