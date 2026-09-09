/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { appearanceAssets } from '../model-assets.js';
import type { AppearanceAssetOwner } from '../assets.js';
import type { RegisteredAppearanceReference, ReferenceCommand } from './types.js';

export interface ReferenceLeaseState {
  appearanceReferences: ReadonlyMap<string, RegisteredAppearanceReference>;
  referenceUndo: readonly ReferenceCommand[];
  referenceRedo: readonly ReferenceCommand[];
}
/** A store owns independent live and history leases. Never borrow the source's lease. */
export function createReferenceLeases() {
  const namespace = crypto.randomUUID();
  let held = new Map<string, { owner: AppearanceAssetOwner; assets: Set<string> }>();
  function sync(state: ReferenceLeaseState): void {
    const desired = new Map<string, { owner: AppearanceAssetOwner; assets: Set<string> }>();
    for (const reference of state.appearanceReferences.values()) {
      const key = `reference:${namespace}:live:${reference.id}`;
      desired.set(key, { owner: { kind: 'source', id: key }, assets: new Set([reference.assetId]) });
    }
    for (const command of [...state.referenceUndo, ...state.referenceRedo]) {
      const key = `reference:${namespace}:history:${command.id}`;
      desired.set(key, { owner: { kind: 'history', id: key }, assets: new Set(
        [...command.before.values(), ...command.after.values()].map(record => record.assetId)) });
    }
    // Retain first so history pruning or live replacement cannot close a bitmap
    // that another resulting owner still needs. Missing files remain recoverable.
    for (const entry of desired.values()) for (const asset of entry.assets) {
      if (appearanceAssets.get(asset)) appearanceAssets.retain(asset, entry.owner);
    }
    for (const [key, entry] of held) for (const asset of entry.assets) {
      if (!desired.get(key)?.assets.has(asset)) appearanceAssets.release(asset, entry.owner);
    }
    held = desired;
  }
  return { sync };
}
