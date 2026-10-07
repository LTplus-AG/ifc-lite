/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reset can retire a preset without loading its optional preview/apply controls (#6926). */
export const LAYOUT_PRESET_STORAGE_KEY = 'ifc-lite:layout-preset-v1';
let resetEpoch = 0;
const listeners = new Set<() => void>();
export function layoutPresetResetEpoch(): number { return resetEpoch; }
export function subscribeLayoutPresetReset(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function forgetLayoutPreset(): void {
  try { window.localStorage.removeItem(LAYOUT_PRESET_STORAGE_KEY); }
  catch (error) { console.warn('[layout-preset] failed to persist preset reset:', error); }
  resetEpoch++;
  for (const listener of listeners) listener();
}
