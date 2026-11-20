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
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import { releasedGeometryMetadataVersion, subscribeReleasedGeometryMetadata } from './released-geometry-metadata';

const SLICE = 256;
const RETRIES = 3;
/** Scene epoch: every flat reshape (clear, new file, replacement, rebuild) starts a new one. */
let epoch = 0;
/** Replays of one epoch run one after another: each owns the scene's streaming pass while it runs. */
let chain: Promise<unknown> = Promise.resolve();

/** Parked replays of the current epoch, waiting for the backing's availability to change. */
const parked = new Set<() => void>();

/** A flat reshape supersedes every replay in flight: it must not upload into the reshaped scene. */
export function supersedeReleasedReplays(): void {
  epoch++;
  for (const stop of [...parked]) stop();
}

/**
 * Resident meshes for the normal upload; released ones are replayed from the backing.
 * A replay that fails in its own epoch retries, then parks until the backing changes;
 * one a reshape superseded is dropped (the newer pass owns its meshes).
 */
export function splitReleasedForReplay(renderer: Renderer, meshes: MeshData[], replayOnce: typeof replay = replay): MeshData[] {
  if (!meshes.some(isReleasedMesh)) return meshes;
  const released = meshes.filter(isReleasedMesh);
  const mine = epoch;
  const isCurrent = () => mine === epoch;
  // The backing revision each attempt started from: a change during the LAST failing attempt
  // lands before `park` subscribes, so park compares against it instead of losing that wake.
  let seen = releasedGeometryMetadataVersion();
  const run = async (): Promise<void> => {
    for (let attempt = 1; attempt <= RETRIES && isCurrent(); attempt++) {
      seen = releasedGeometryMetadataVersion();
      try {
        if (await replayOnce(renderer, released, isCurrent)) return;
      } catch (error) {
        console.error(`[GeometryBacking] released geometry replay attempt ${attempt} failed`, error);
      }
      if (attempt < RETRIES && isCurrent()) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    if (isCurrent()) park();
  };
  const attempt = async (): Promise<boolean> => {
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
    const stop = () => { done = true; unsubscribe(); parked.delete(stop); };
    const schedule = (): void => {
      if (done) return;
      if (!isCurrent()) { stop(); return; }
      if (busy) { again = true; return; }
      busy = true;
      again = false;
      chain = chain.then(async () => {
        const ok = !done && isCurrent() && await attempt();
        busy = false;
        if (ok || !isCurrent()) stop();
        else if (again) schedule();
      });
    };
    const unsubscribe = subscribeReleasedGeometryMetadata(schedule);
    parked.add(stop);
    if (releasedGeometryMetadataVersion() !== seen) schedule(); // changed since the last attempt began
  };
  chain = chain.then(run, run);
  return meshes.filter((mesh) => !isReleasedMesh(mesh));
}

/** Settles once every replay queued so far has finished (tests). */
export function releasedReplaysIdle(): Promise<void> { return chain.then(() => undefined); }

async function replay(renderer: Renderer, released: readonly MeshData[], isCurrent: () => boolean): Promise<boolean> {
  const [{ replayReleasedGeometry }, { activeGeometryBackingTap }, { replayStoreList }, { canonicalStoreMesh }, { GeometryUnavailableError }, { getViewerState }] =
    await Promise.all([import('@ifc-lite/renderer'), import('./backing-debug-hook'), import('./generation-replay'),
      import('./store-mesh-readback'), import('./geometry-readback'), import('@/store/viewerStoreHandle')]);
  const tap = activeGeometryBackingTap();
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
      yield* replayStoreList(meshes, source, SLICE);
    }
  }
  const result = await replayReleasedGeometry(renderer, batches(), { isCurrent });
  if (result.status !== 'complete') console.warn(`[GeometryBacking] released geometry replay ${result.status}; it will be retried`, result);
  return result.status === 'complete';
}
