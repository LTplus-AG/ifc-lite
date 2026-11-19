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
 * Each replay is fenced: a newer reload (or device swap) supersedes it. A
 * replay that fails or is superseded hands its meshes back (`unclaim`) so the
 * next pass retries them; nothing is ever silently left out of the scene.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';

const SLICE = 256;
const RETRIES = 3;
/** Scene epoch: every flat reshape (clear, new file, replacement, rebuild) starts a new one. */
let epoch = 0;
/** Replays of one epoch run one after another: each owns the scene's streaming pass while it runs. */
let chain: Promise<unknown> = Promise.resolve();

/** A flat reshape supersedes every replay in flight: it must not upload into the reshaped scene. */
export function supersedeReleasedReplays(): void { epoch++; }

/**
 * Resident meshes for the normal upload; released ones are replayed from the backing.
 * A replay that fails in its own epoch is retried, then handed back (`unclaim`) for
 * the next rebuild; one a reshape superseded is dropped (the newer pass owns them).
 */
export function splitReleasedForReplay(renderer: Renderer, meshes: MeshData[], unclaim: (meshes: readonly MeshData[]) => void,
  replayOnce: typeof replay = replay): MeshData[] {
  if (!meshes.some(isReleasedMesh)) return meshes;
  const released = meshes.filter(isReleasedMesh);
  const mine = epoch;
  const isCurrent = () => mine === epoch;
  const run = async (): Promise<void> => {
    for (let attempt = 1; attempt <= RETRIES && isCurrent(); attempt++) {
      try {
        if (await replayOnce(renderer, released, isCurrent)) return;
      } catch (error) {
        console.error(`[GeometryBacking] released geometry replay attempt ${attempt} failed`, error);
      }
      if (attempt < RETRIES && isCurrent()) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    if (isCurrent()) unclaim(released);
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
