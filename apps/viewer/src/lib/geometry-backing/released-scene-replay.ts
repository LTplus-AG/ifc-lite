/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene re-uploads over released CPU geometry (#10264). A content-version
 * reload (realign, rebase, rotation, collab) rebuilds the scene from the
 * store list; released members have no arrays to upload. They are split off
 * here and replayed from the model's ACKNOWLEDGED backing generation through
 * the renderer's bounded replay: one chunk lease and one slice at a time.
 *
 * Each replay is fenced: a newer reload (or device swap) supersedes it, and
 * the newer pass owns those meshes. A replay that fails in its own epoch keeps
 * them: it retries (bounded), then parks and retries whenever the backing's
 * availability changes (a seal acknowledges, a generation fails or is
 * replaced) until it completes or a reshape supersedes it. It never hands
 * meshes back to an incremental pass that would not select them again.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { isReleasedMesh, noteSceneGeometry } from '@/lib/released-mesh-provenance';

/** One replay attempt: `true` once complete; `'moved'` when only an Exploded lift change superseded it. */
export type ReplayOnce = (renderer: Renderer, released: readonly MeshData[], isCurrent: () => boolean) => Promise<boolean | 'moved'>;
export interface ReplayToken { readonly epoch: number }

/**
 * Shared replay state. The replay itself (retries, parking, backing reads: `released-scene-replay-run.ts`)
 * loads only when a released mesh is first replayed; release is off in product, so it stays out of the
 * eager bundle.
 */
export const replayState = {
  /** Scene epoch: every flat reshape (clear, new file, replacement, rebuild) starts a new one. */
  epoch: 0,
  /** Replays of one epoch run one after another: each owns the scene's streaming pass while it runs. */
  chain: Promise.resolve() as Promise<unknown>,
  /** Parked replays of the current epoch, waiting for the backing's availability to change. */
  parked: new Set<() => void>(),
  /** Released replays not yet complete (queued, retrying or parked), each with the epoch it belongs to. */
  unfinished: new Set<ReplayToken>(),
  /** The latest geometry pass's completion, held until every replay of the current epoch completed. */
  waiter: null as (() => void) | null,
};

/**
 * Run `done` (a pass's "triangle counts complete") once no released replay of the current epoch is
 * still queued, retrying or parked: now if none is. Only a replay that completed, finalized in its own
 * epoch, counts as done. The latest pass replaces any earlier waiter; `null` withdraws it.
 */
export function completeAfterReleasedReplays(done: (() => void) | null): void {
  replayState.waiter = done;
  settleWaiter();
}
export function settleWaiter(): void {
  const { waiter, unfinished, epoch } = replayState;
  if (!waiter || [...unfinished].some((replay) => replay.epoch === epoch)) return;
  replayState.waiter = null;
  waiter();
}

/** A flat reshape supersedes every replay in flight: it must not upload into the reshaped scene. */
export function supersedeReleasedReplays(): void {
  const epoch = ++replayState.epoch;
  replayState.waiter = null; // the reshaping pass registers its own
  for (const stop of [...replayState.parked]) stop();
  for (const replay of [...replayState.unfinished]) if (replay.epoch !== epoch) replayState.unfinished.delete(replay);
}
/** The current scene epoch (a device recovery's rebuild is fenced by it too). */
export function releasedReplayEpoch(): number { return replayState.epoch; }

/**
 * Resident meshes for the normal upload; released ones are replayed from the backing.
 * A replay that fails in its own epoch retries, then parks until the backing changes;
 * one a reshape superseded is dropped (the newer pass owns its meshes).
 */
export function splitReleasedForReplay(renderer: Renderer, meshes: MeshData[], drawn?: readonly MeshData[], replayOnce?: ReplayOnce): MeshData[] {
  if (drawn) noteSceneGeometry(drawn); // the whole list the scene now draws (streamed appends included)
  if (!meshes.some(isReleasedMesh)) return meshes;
  const released = meshes.filter(isReleasedMesh);
  const token: ReplayToken = { epoch: replayState.epoch };
  replayState.unfinished.add(token);
  const run = () => import('./released-scene-replay-run').then(({ runReleasedReplay }) => runReleasedReplay(renderer, released, token, replayOnce));
  replayState.chain = replayState.chain.then(run, run);
  return meshes.filter((mesh) => !isReleasedMesh(mesh));
}

/** Settles once every replay queued so far has finished (tests). */
export function releasedReplaysIdle(): Promise<void> { return replayState.chain.then(() => undefined); }
