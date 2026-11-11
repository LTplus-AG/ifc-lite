/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, type ViewerState } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

/**
 * The load is interactive. The store has left its loading state, nothing
 * streams or waits to upload, and the renderer has finished its async finalize.
 * Finalisation empties its fragment list before its time-sliced rebuild ends,
 * and `loading` clears before that whole phase, so all of these checks are
 * needed (#9623).
 *
 * Work that serves something other than reaching this point (a query index,
 * the next open's cache entry, a hidden minimap) waits for it, so the
 * post-stream drain and finalize keep the main thread.
 */
export function isSceneSettled(state: ViewerState = useViewerStore.getState()): boolean {
  if (state.loading || state.geometryStreamingActive || state.pendingInstancedShards?.length) return false;
  const scene = getGlobalRenderer()?.getScene();
  return !(scene?.hasQueuedMeshes() || scene?.hasStreamingFragments() || scene?.isFinalizeInProgress());
}

/**
 * Resolve `true` once the scene settles, or `false` as soon as `isCurrent`
 * turns false (a new load superseded the caller) or `timeoutMs` passes (a
 * failed finalize may keep its fragments until device recovery).
 * Ten constant-time checks per second at first, then one per second.
 */
export function whenSceneSettled(isCurrent: () => boolean = () => true, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    let polls = 0;
    const check = (): void => {
      if (!isCurrent()) { resolve(false); return; }
      if (isSceneSettled()) { resolve(true); return; }
      if (Date.now() - start >= timeoutMs) { resolve(false); return; }
      setTimeout(check, ++polls < 50 ? 100 : 1000);
    };
    check();
  });
}
