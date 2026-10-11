/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lazy boundary in front of the Studio's authoring runtime. The Studio
 * panel's lazy chunk awaits this before it mounts, so every synchronous slice
 * action the panel calls (open, dispatch, undo, redo) finds the runtime
 * installed. Safe to import eagerly: it only reaches `./runtime` via `import()`.
 */

import { useViewerStore } from '@/store';

let loading: Promise<typeof import('./runtime')> | null = null;

/** Load the runtime once per page and install it in the store. Retryable after a failed load. */
export function loadIdsStudioRuntime(): Promise<void> {
  const current = (loading ??= import('./runtime'));
  current.catch(() => { if (loading === current) loading = null; });
  return current.then(({ idsStudioRuntime }) => {
    const store = useViewerStore.getState();
    if (store.idsStudioRuntime !== idsStudioRuntime) store.idsStudioSetRuntime(idsStudioRuntime);
  });
}
