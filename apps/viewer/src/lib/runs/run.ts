/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The record a store run slot (`./run-slot.ts`) keeps in the viewer store.
 * Dependency-free so slices can declare their job field without pulling the
 * slot (and the activity journal) into the store's module graph.
 */

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
  | { kind: 'cancelled'; runId: number };

export const IDLE_RUN = { kind: 'idle' } as const;
