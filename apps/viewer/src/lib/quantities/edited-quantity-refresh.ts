/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Update quantities of edited elements" (#9026 item 20 follow-up): whether
 * editing a loaded wall, slab, roof, column or beam's geometry refreshes its
 * base quantity set from that geometry, on the Quantities tabs and in the
 * export. Off by default: a loaded file's sets read as the file wrote them.
 *
 * A cross-file preference saved in this browser, like the theme, so it is not
 * part of any slice's teardown. It lives here rather than in the store because
 * `configureMutationView`'s quantity base reads it on every call and must not
 * import the store; the store's readers re-render through `mutationVersion`,
 * which `setEditedQuantityRefresh` callers bump (see `useEditedQuantityRefresh`).
 */

export const EDITED_QUANTITY_REFRESH_STORAGE_KEY = 'ifc-lite.quantities.update-edited.v1';

function load(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    // Only an explicit 'true' turns it on: a missing or malformed entry stays off.
    return localStorage.getItem(EDITED_QUANTITY_REFRESH_STORAGE_KEY) === 'true';
  } catch (error) {
    console.warn(`[quantities] could not read ${EDITED_QUANTITY_REFRESH_STORAGE_KEY}`, error);
    return false;
  }
}

let enabled = load();
const listeners = new Set<() => void>();

/** Whether edited loaded elements read refreshed base quantities. */
export function isEditedQuantityRefreshEnabled(): boolean {
  return enabled;
}

/** Turn the refresh on or off and save the choice in this browser. */
export function setEditedQuantityRefresh(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(EDITED_QUANTITY_REFRESH_STORAGE_KEY, String(next));
  } catch (error) {
    // Quota exceeded or private mode: the choice holds for this session only.
    console.warn(`[quantities] could not save ${EDITED_QUANTITY_REFRESH_STORAGE_KEY}`, error);
  }
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeEditedQuantityRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: re-read the saved value, as a fresh page load would. */
export function reloadEditedQuantityRefreshForTests(): void {
  enabled = load();
  for (const listener of listeners) listener();
}
