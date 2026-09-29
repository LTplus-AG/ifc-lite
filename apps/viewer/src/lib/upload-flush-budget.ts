/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

/**
 * Per-call time slice for draining the scene's GPU upload queue once nothing
 * else needs the main thread.
 *
 * While geometry streams, the main thread must keep returning to the worker
 * message pump, and while the user navigates, frames must stay short, so both
 * keep the scene's 12 ms default. Once a large stream has ended, the queue can
 * still hold seconds of uploads: on a 1 GB MEP model about 7 s, drained at
 * 12 ms per 16.7 ms frame with the main thread ~40% idle, before the renderer
 * could finalize. Nothing competes then, so each frame may take more (#6436).
 */
export const SETTLE_FLUSH_BUDGET_MS = 32;

/** The budget for this flush, or `undefined` for the scene's streaming default. */
export function uploadFlushBudgetMs(interacting: boolean, state = useViewerStore.getState()): number | undefined {
  return interacting || state.geometryStreamingActive ? undefined : SETTLE_FLUSH_BUDGET_MS;
}
