/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lazy boundary in front of the Studio's authoring runtime. The Studio
 * panel's lazy chunk awaits this before it mounts, so every synchronous slice
 * action the panel calls (open, dispatch, undo, redo) finds the runtime
 * installed. Safe to import eagerly: it only reaches `./runtime` via `import()`.
 *
 * A failed load rejects; the panel shows its ChunkErrorBoundary fallback, whose
 * action is a page reload, like every other lazy panel (React.lazy keeps the
 * rejected factory for the page's lifetime). This loader does not cache the
 * failure, so the next call after a reload, or any other caller, tries again.
 */

import { useViewerStore } from '@/store';

type RuntimeModule = typeof import('./runtime');

let loading: Promise<RuntimeModule> | null = null;

/** Load the runtime once per page and install it in the store (again, if the store lost it). */
export function loadIdsStudioRuntime(): Promise<void> {
  const current = (loading ??= import('./runtime'));
  current.catch(() => { if (loading === current) loading = null; });
  return current.then(({ idsStudioRuntime }) => {
    const store = useViewerStore.getState();
    if (store.idsStudioRuntime !== idsStudioRuntime) store.idsStudioSetRuntime(idsStudioRuntime);
  });
}
