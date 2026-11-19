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
let latest = 0;

/** Resident meshes for the normal upload; released ones are replayed from the backing. */
export function splitReleasedForReplay(renderer: Renderer, meshes: MeshData[], unclaim: (meshes: readonly MeshData[]) => void): MeshData[] {
  if (!meshes.some(isReleasedMesh)) return meshes;
  const released = meshes.filter(isReleasedMesh);
  const token = ++latest;
  void replay(renderer, released, () => token === latest).then((ok) => { if (!ok) unclaim(released); },
    (error: unknown) => { console.error('[GeometryBacking] released geometry replay failed', error); unclaim(released); });
  return meshes.filter((mesh) => !isReleasedMesh(mesh));
}

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
    byModel.set(found.at, [...(byModel.get(found.at) ?? []), mesh]);
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
