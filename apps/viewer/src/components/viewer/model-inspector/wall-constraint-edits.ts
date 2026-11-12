/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readStoreyInventory, readTopAttachment, setTopConstraintInStore, type TopConstraint } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { commitElementSize } from '@/lib/element-size-commit';
import { runInspectorEdit } from './inspector-edits';

export function attachWallTop(modelId: string, wallId: number, constraint: TopConstraint, onError?: (reason: string) => void): boolean {
  return runInspectorEdit(modelId, tx => recordModellingEdit(useViewerStore, modelId, (_methods, draft) => {
    const store = tx.store.models.get(modelId)?.ifcDataStore;
    if (!store) throw new Error('Model is no longer loaded');
    return setTopConstraintInStore(store, draft, wallId, constraint).remesh;
  }, tx.batchId), onError);
}

/** Endpoints are in the home storey's frame, in metres. */
export function wallOffsets(modelId: string, wallId: number) {
  const s = useViewerStore.getState(), target = modelEditTarget(s, modelId);
  const wall = s.readWallEndpoints(modelId, wallId);
  if (!target || !wall) return null;
  const levels = modelStoreys(s, modelId);
  const home = levels.find(level => level.expressId === effectiveStoreyId(target.dataStore, target.view, wallId));
  const attachment = readTopAttachment(readStoreyInventory(target.dataStore, target.view), wallId);
  const above = attachment?.binding === 'relative' && home
    ? levels[levels.indexOf(home) + 1]
    : levels.find(level => level.expressId === attachment?.targetStoreyId);
  const top = attachment?.kind === 'storey' && above && home
    ? wall.start[2] + wall.height + home.elevation - above.elevation : null;
  return { base: wall.start[2], top, attached: !!attachment, wall };
}

export function setWallOffset(modelId: string, wallId: number, kind: 'top' | 'base', value: number, onError?: (reason: string) => void): boolean {
  return runInspectorEdit(modelId, tx => {
    if (!Number.isFinite(value)) throw new Error('Enter a finite offset in metres');
    const offsets = wallOffsets(modelId, wallId);
    if (!offsets || kind === 'top' && offsets.top === null) throw new Error('A resolved storey top is required');
    const delta = value - (kind === 'top' ? offsets.top! : offsets.base);
    const height = offsets.wall.height + (kind === 'top' ? delta : offsets.attached ? -delta : 0);
    if (height < 0.1) throw new Error('The wall must be at least 0.1 m tall');
    // Keep the attachment; unlike typing Height, this edits its implicit offset.
    const sized = commitElementSize(useViewerStore, modelId, wallId, { kind: 'wall', height });
    if (!sized.ok) throw new Error(sized.reason);
    if (kind === 'base') {
      const moved = tx.store.translateEntity(modelId, wallId, [0, 0, delta], tx.batchId);
      if (!moved.ok) throw new Error(moved.reason);
    }
    return [wallId, ...sized.remesh];
  }, onError);
}
