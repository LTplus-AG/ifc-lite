/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How often a panel re-derives whole-model data from geometry WHILE that
 * geometry is still streaming in (#6411).
 *
 * A large load publishes geometry to the store every 500 ms
 * (`getRenderIntervalMs`), and every publish replaces `state.models`. Panels
 * that walk every mesh or every element on each publish (the hierarchy tree,
 * the object counts, the model statistics) saturated the main thread on a
 * 127K-element model: the geometry workers finished and then idled while the
 * main thread drained their batches. Streaming-time panel data is progress,
 * not a result, so it refreshes on this cadence and becomes exact the moment
 * streaming ends.
 */
export const STREAMING_PANEL_REFRESH_MS = 4000;

/** Whether streaming-derived data last taken at `takenAt` is due for a refresh at `now` (ms, same clock). */
export function streamingRefreshDue(takenAt: number, now: number): boolean {
  return now - takenAt >= STREAMING_PANEL_REFRESH_MS;
}
