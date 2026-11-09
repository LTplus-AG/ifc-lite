/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The record a store run slot (`./run-slot.ts`) keeps in the viewer store.
 * Dependency-free so slices can declare their job field without pulling the
 * slot (and the activity journal) into the store's module graph.
 */

/**
 * Why a run ended without a result.
 * - `user`: someone asked (a Cancel button, the tray, the task's own abort).
 * - `superseded`: a newer run of the same slot or hook took over.
 * - `teardown`: what the run belonged to went away (a slice teardown, an
 *   unmount, a `key` change).
 * - `scope`: it finished, but the world it read changed meanwhile, so its
 *   result was discarded.
 *
 * Only `user` is a cancel the user caused; the activity journal shows only
 * that one as "cancelled" and drops the row for the others.
 */
export type CancelReason = 'user' | 'superseded' | 'teardown' | 'scope';

/**
 * A job as the store holds it. `owner` is what the run belongs to (the models
 * it reads, the request it answers): a teardown arm reads it to decide
 * whether the run ends with what is being torn down.
 */
export type Run<R, P = never, O = undefined, E = unknown> =
  | { kind: 'idle' }
  | { kind: 'running'; runId: number; owner: O; progress?: P }
  | { kind: 'succeeded'; runId: number; result: R }
  | { kind: 'failed'; runId: number; error: E }
  | { kind: 'cancelled'; runId: number; reason: CancelReason };

export const IDLE_RUN = { kind: 'idle' } as const;
