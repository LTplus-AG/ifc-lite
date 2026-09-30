/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Change sets panel's only door into the mutation slice (#6232 D4). The
 * panel calls these and never touches `changeSets` itself, so the slice owns
 * every write.
 */

import { useViewerStore } from '@/store';

/** Create a set and make it the active one (new edits land in it). Returns its id. */
export function createChangeSet(name: string): string {
  return useViewerStore.getState().createChangeSet(name);
}

/** Make `id` the active set, or `null` to stop collecting edits into the chosen set. */
export function activateChangeSet(id: string | null): void {
  useViewerStore.getState().setActiveChangeSet(id);
}

export function renameChangeSet(id: string, name: string): void {
  useViewerStore.getState().renameChangeSet(id, name);
}

/** Drop a set and its record of edits (the edits stay in the model). Clears it as the active set. */
export function discardChangeSet(id: string): void {
  useViewerStore.getState().deleteChangeSet(id);
}

/** The file content for `id`, in the slice's export format, or null if the set is gone. */
export function exportChangeSet(id: string): string | null {
  return useViewerStore.getState().exportChangeSet(id);
}

/** Add a set from an exported file. Returns the new set's id, or null when the file is not a change set. */
export function importChangeSet(json: string): string | null {
  return useViewerStore.getState().importChangeSet(json);
}
