/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The initial model seed as explicit state, separate from connectivity (#4446).
 *
 * A connected websocket is not a seeded room. `collabStatus` flips to
 * `'connected'` the moment the provider handshakes, while the owner is still
 * uploading structure and geometry into it — and `collabRoomId` is set even
 * earlier, synchronously, before any await. A Share dialog keyed on either of
 * those handed out invites to rooms that were still empty; whoever opened one
 * reconstructed nothing.
 *
 * This is the product-level answer to "is the room ready to be shared?", so no
 * UI has to inspect the Y.Doc (or `collabSession`, which is only committed
 * after the seed) to find out. Recipients never seed: for them the phase stays
 * `'none'`, which reads as ready.
 */

import type { SeedOutcome } from './geometry-seed-signal';

export type CollabSeedPhase =
  /** No seed in this session: off a room, or a recipient/joiner (rooms arrive populated). */
  | 'none'
  /** Owner join begun; waiting for the room to sync before seeding. */
  | 'syncing'
  /** Writing entities (structure) into the doc. */
  | 'structure'
  /** Uploading mesh blobs; see `CollabSeedProgress`. */
  | 'geometry'
  /** Everything the model had is in the room (including "it had nothing"). */
  | 'ready'
  /** Some geometry landed, some did not; `collabSeedFailure` says what. */
  | 'partial'
  /** The room got structure but no geometry, or the seed threw; `collabSeedFailure` says what. */
  | 'failed';

/** Geometry blob uploads so far, for a progress row. */
export interface CollabSeedProgress {
  uploaded: number;
  total: number;
}

/** Phases during which an invite must NOT be handed out yet. */
export function isCollabSeedInFlight(phase: CollabSeedPhase): boolean {
  return phase === 'syncing' || phase === 'structure' || phase === 'geometry';
}

/** The phase a finished seed lands in, from the marker classification. */
export function seedPhaseFromOutcome(outcome: SeedOutcome): 'ready' | 'partial' | 'failed' {
  if (outcome === 'partial') return 'partial';
  if (outcome === 'failed') return 'failed';
  return 'ready';
}

/**
 * User-facing sentence for an in-flight phase, or `null` once settled. A
 * complete sentence so each surface renders it as-is, under its own heading,
 * without doubling the verb.
 */
export function describeSeedPhase(phase: CollabSeedPhase, progress: CollabSeedProgress | null): string | null {
  switch (phase) {
    case 'syncing':
      return 'Connecting to the room…';
    case 'structure':
      return 'Uploading model structure…';
    case 'geometry':
      return progress ? `Uploading geometry ${progress.uploaded}/${progress.total}…` : 'Uploading geometry…';
    default:
      return null;
  }
}
