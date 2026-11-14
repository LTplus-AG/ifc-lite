/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, type ViewerState } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { hasPendingInstancedShards } from '@/store/instancedShardQueue';
import { afterSettledFrame } from '@/lib/settled-frame';

// Build marker for the load scoreboard: this build exposes `__ifc_lite_scene_settled__` once the viewport's
// renderer is ready. Set at module load (useIfcLoader imports this module at startup), so a probe can tell
// "the hook is not installed yet" (renderer not ready: hold the mark) from "this build has no hook" (old rule).
(globalThis as Record<string, unknown>).__ifc_lite_scene_settled_supported__ = true;

/**
 * Viewports that saw a stream and have not finalized it yet (`useGeometryStreaming`).
 * The store stops streaming before the viewport's passive effect schedules the
 * finalize, and a burst appended without the queue (the small-file fast path)
 * leaves no queued mesh or fragment in between: only the viewport knows.
 */
const finalizePending = new Set<() => boolean>();
export function registerFinalizePending(pending: () => boolean): () => void {
  finalizePending.add(pending);
  return () => { finalizePending.delete(pending); };
}

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
  if (state.loading || state.geometryStreamingActive || hasPendingInstancedShards()) return false; // shards travel outside the store (#9628)
  for (const pending of finalizePending) if (pending()) return false;
  const scene = getGlobalRenderer()?.getScene();
  // Optional calls: a renderer whose scene predates these queries (test doubles,
  // partial hosts) has nothing streaming that it could report, so it is settled.
  return !(scene?.hasQueuedMeshes?.() || scene?.hasStreamingFragments?.() || scene?.isFinalizeInProgress?.());
}

/**
 * Call `done(true)` once the scene settles AND the viewport has drawn it
 * (settled-frame.ts), or `done(false)` as soon as `isCurrent` turns false (a
 * new load superseded the caller) or `timeoutMs` passes (a failed finalize may
 * keep its fragments until device recovery). Ten constant-time checks per
 * second at first, then one per second. Returns a cancel: after it, `done` is
 * never called.
 *
 * Settled alone is not enough: the check that first sees the scene settled can
 * land between finalize and the frame that draws it, and the caller's work (the
 * cache write's encode, 80-200 ms on Holter) then ran in front of that frame.
 * Superseded while waiting for the frame: `done(false)`, so the caller runs nothing.
 */
export function afterSceneSettled(done: (settled: boolean) => void, isCurrent: () => boolean = () => true, timeoutMs = 120_000): () => void {
  const start = Date.now();
  let polls = 0;
  let cancelled = false;
  let cancelWait: () => void = () => {};
  // The deadline holds through the frame wait too: a draw that stays pending must not succeed late.
  // Only a finite delay a timer can hold: setTimeout treats Infinity (no limit) or anything past 2^31-1 ms as 1 ms.
  const deadline = Number.isFinite(timeoutMs) && timeoutMs <= 0x7fffffff
    ? setTimeout(() => { if (!cancelled) { cancelWait(); finish(false); } }, timeoutMs)
    : undefined;
  const finish = (settled: boolean): void => { if (!cancelled) { cancelled = true; clearTimeout(deadline); cancelWait(); done(settled); } };
  const check = (): void => {
    if (cancelled) return;
    if (!isCurrent()) { finish(false); return; }
    if (isSceneSettled()) {
      // A load that starts while the frame is awaited makes that frame (or its
      // backstop) no proof that the next scene was drawn: wait for it again.
      const cancelFrame = afterSettledFrame(drawn);
      const unsubscribe = useViewerStore.subscribe((state) => { if (!isSceneSettled(state)) { cancelWait(); check(); } });
      cancelWait = () => { cancelFrame(); unsubscribe(); };
      return;
    }
    if (Date.now() - start >= timeoutMs) { finish(false); return; }
    const timer = setTimeout(check, ++polls < 50 ? 100 : 1000);
    cancelWait = () => clearTimeout(timer);
  };
  const drawn = (): void => {
    cancelWait();
    if (isCurrent() && isSceneSettled()) finish(true);
    else check(); // superseded (false), or the scene changed again: wait for it again
  };
  check();
  return () => { cancelled = true; clearTimeout(deadline); cancelWait(); };
}

/** Promise form of `afterSceneSettled`. */
export function whenSceneSettled(isCurrent: () => boolean = () => true, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => { afterSceneSettled(resolve, isCurrent, timeoutMs); });
}
