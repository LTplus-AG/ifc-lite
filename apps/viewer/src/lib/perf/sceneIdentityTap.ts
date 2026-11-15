/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene identity tap for the load scoreboard's untimed identity pass
 * (`?perf.sceneIdentity=1`). A cache hit carries no element geometry hashes, so
 * a reopen is verified against its own cold open on what the scene really
 * holds: the batches a load wrote to the cache or a reopen adopted, hashed by
 * `sceneIdentity.ts`, loaded only when the flag is on. With the flag off (every
 * normal and every timed load) a tap is one flag read and returns.
 */

import type { SceneSnapshot } from '@ifc-lite/renderer';
import { readPerfFlag } from './flags.js';

export type TappedKind = 'written' | 'adopted';
export interface TappedSnapshot { kind: TappedKind; sig: string | null; batches: number; error?: string }

const tapped: TappedSnapshot[] = [];
let pending = 0;
let generation = 0;

export function sceneIdentityEnabled(): boolean {
  const v = readPerfFlag('sceneIdentity');
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Hash `snapshot` off the load path (its views stay valid: the writer has copied it, adoption keeps them). */
export function tapSceneSnapshot(kind: TappedKind, snapshot: SceneSnapshot): void {
  if (!sceneIdentityEnabled()) return;
  const entry: TappedSnapshot = { kind, sig: null, batches: snapshot.batches.length };
  const owner = generation;
  tapped.push(entry);
  pending++;
  import('./sceneIdentity.js')
    .then(({ snapshotSignature }) => { if (owner === generation) entry.sig = snapshotSignature(snapshot); })
    .catch((err: unknown) => { if (owner === generation) entry.error = String(err); })
    .finally(() => { if (owner === generation) pending--; });
}

export function tappedSceneSnapshots(): { snapshots: readonly TappedSnapshot[]; pending: number } {
  return { snapshots: tapped.map((t) => ({ ...t })), pending };
}

/** Drop the previous viewport's taps and invalidate its pending hash callbacks (#9990). */
export function resetSceneIdentityTap(): void {
  generation++;
  tapped.length = 0;
  pending = 0;
}
