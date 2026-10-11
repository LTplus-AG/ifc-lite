/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lazy boundary in front of the Studio's authoring runtime. The Studio
 * panel's lazy chunk awaits this before it mounts, so every synchronous slice
 * action the panel calls (open, dispatch, undo, redo) finds the runtime
 * installed. Safe to import eagerly: it only reaches `./runtime` via `import()`.
 * A failed load rejects (the panel's ChunkErrorBoundary shows it), leaves the
 * store without a runtime, and is retried by the next call.
 */

import { useViewerStore } from '@/store';

type RuntimeModule = typeof import('./runtime');

const importRuntime = (): Promise<RuntimeModule> => import('./runtime');

let loading: Promise<RuntimeModule> | null = null;

/**
 * Load the runtime once per page and install it in the store. `load` swaps
 * the module import (tests use it to exercise a failed load); a custom
 * loader is never cached.
 */
export function loadIdsStudioRuntime(load: () => Promise<RuntimeModule> = importRuntime): Promise<void> {
  let current: Promise<RuntimeModule>;
  if (load === importRuntime) {
    current = (loading ??= load());
    current.catch(() => { if (loading === current) loading = null; });
  } else {
    current = load();
  }
  return current.then(({ idsStudioRuntime }) => {
    const store = useViewerStore.getState();
    if (store.idsStudioRuntime !== idsStudioRuntime) store.idsStudioSetRuntime(idsStudioRuntime);
  });
}
