/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The released replay runner, loaded on first use (`released-scene-replay.ts` holds the shared state).
 *
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
import { replayReleasedGeometry, type Renderer } from '@ifc-lite/renderer';
import { releasedGeometryMetadataVersion, subscribeReleasedGeometryMetadata } from './released-geometry-metadata';
import { replayState as state, settleWaiter, type ReplayOnce, type ReplayToken } from './released-scene-replay';
// Static: this module is itself loaded on demand, and a dynamic import of a module the eager
// graph already holds would split it into its own eager chunk.
import { activeGeometryBackingTap } from './backing-debug-hook';
import { replayStoreList } from './generation-replay';
import { canonicalStoreMesh } from './store-mesh-readback';
import { GeometryUnavailableError } from './geometry-readback';
import { getViewerState } from '@/store/viewerStoreHandle';
import { captureLevelLift } from '@/lib/level-lift-fence';
import { placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';

const SLICE = 256;
const RETRIES = 3;

/** Replay `released` in `token`'s epoch: bounded retries, then parked until the backing changes. */
export async function runReleasedReplay(renderer: Renderer, released: readonly MeshData[], token: ReplayToken, replayOnce: ReplayOnce = replay): Promise<void> {
  const isCurrent = () => token.epoch === state.epoch;
  // Complete only when it finished in its own epoch; a superseded one just stops counting.
  const finish = (complete: boolean) => { if (state.unfinished.delete(token) && complete && isCurrent()) settleWaiter(); };
  // The backing revision each attempt started from: a change during the LAST failing attempt
  // lands before `park` subscribes, so park compares against it instead of losing that wake.
  let seen = releasedGeometryMetadataVersion();
  const attempt = async (): Promise<boolean | 'moved'> => {
    try {
      return isCurrent() && await replayOnce(renderer, released, isCurrent);
    } catch (error) {
      console.error('[GeometryBacking] parked released geometry replay failed', error);
      return false;
    }
  };
  const park = () => {
    // One attempt at a time: `busy` covers queued AND in flight. A notification meanwhile is
    // remembered and retried only if that attempt fails; success or disposal ends it all.
    let done = false, busy = false, again = false;
    const stop = () => { done = true; unsubscribe(); state.parked.delete(stop); };
    const schedule = (): void => {
      if (done) return;
      if (!isCurrent()) { stop(); finish(false); return; }
      if (busy) { again = true; return; }
      busy = true;
      again = false;
      state.chain = state.chain.then(async () => {
        const outcome = !done && isCurrent() && await attempt(), ok = outcome === true;
        busy = false;
        if (ok || !isCurrent()) { stop(); finish(ok); }
        else if (again || outcome === 'moved') schedule();
      });
    };
    const unsubscribe = subscribeReleasedGeometryMetadata(schedule);
    state.parked.add(stop);
    if (releasedGeometryMetadataVersion() !== seen) schedule(); // changed since the last attempt began
  };
  for (let n = 1; n <= RETRIES && isCurrent(); n++) {
    seen = releasedGeometryMetadataVersion();
    try {
      const outcome = await replayOnce(renderer, released, isCurrent);
      if (outcome === true) { finish(true); return; }
      if (outcome === 'moved') { n--; continue; } // the Exploded lift moved: retry at the new one, not a failure
    } catch (error) {
      console.error(`[GeometryBacking] released geometry replay attempt ${n} failed`, error);
    }
    if (n < RETRIES && isCurrent()) await new Promise((resolve) => setTimeout(resolve, 250 * n));
  }
  if (isCurrent()) park(); else finish(false);
}

/** `true` once complete; `'moved'` when only an Exploded lift change superseded it (retry at the new lift at once). */
export async function replay(renderer: Renderer, released: readonly MeshData[], isCurrent: () => boolean): Promise<boolean | 'moved'> {
  const tap = activeGeometryBackingTap();
  // The same arrival placement as a resident upload: the current Exploded lift, fenced entry by entry.
  const level = captureLevelLift(getViewerState());
  // Each released mesh (or copy of one) by the model whose store list holds its source.
  const owner = new Map<MeshData, string>();
  for (const [modelId, model] of getViewerState().models) for (const mesh of model.geometryResult?.meshes ?? []) owner.set(mesh, modelId);
  const byModel = new Map<string, MeshData[]>();
  for (const mesh of released) {
    const found = canonicalStoreMesh(mesh, owner);
    if (!found) throw new GeometryUnavailableError(`Released mesh of entity ${mesh.expressId} belongs to no model`);
    let group = byModel.get(found.at);
    if (!group) byModel.set(found.at, (group = []));
    group.push(mesh);
  }
  // A reload follows a content bump, so the model's CURRENT generation is still being
  // rebuilt; the acknowledged one stays durable until that rebuild is acknowledged.
  async function* batches(): AsyncGenerator<readonly MeshData[]> {
    for (const [modelId, meshes] of byModel) {
      const source = tap?.replaySource(modelId);
      if (!source) throw new GeometryUnavailableError(`Model ${modelId} has no acknowledged backing to replay from`);
      for await (const batch of replayStoreList(meshes, source, SLICE)) yield placeNewMeshesAtCurrentLevel([...batch], level.lift);
    }
  }
  const result = await replayReleasedGeometry(renderer, batches(), { isCurrent: () => isCurrent() && level.current(getViewerState()) });
  if (result.status === 'complete') return true;
  if (result.status === 'superseded' && isCurrent() && !level.current(getViewerState())) return 'moved';
  console.warn(`[GeometryBacking] released geometry replay ${result.status}; it will be retried`, result);
  return false;
}
