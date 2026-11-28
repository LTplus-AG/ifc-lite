/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Highlight copies that outlived a change of their base's frame or encoding (selection-hydration.ts retires them). */
import { copyBuild } from './individual-mesh-upload.js';
import type { Scene } from './scene.js';
import type { Mesh } from './types.js';

type CopyScene = Pick<Scene, 'getMeshes' | 'getPickGeometryRevision' | 'removeMeshesWhere'> & Partial<Pick<Scene, 'getIndividualMeshFrame'>>;

/** Whether every piece of a copy is still drawn in the frame and encoding it was written for (checked once per revision). */
function copyCurrent(scene: CopyScene & Pick<Scene, 'getIndividualMeshFrame'>, mesh: Mesh, revision: number): boolean {
  const build = copyBuild(mesh.vertexBuffer), at = mesh.rteOrigin;
  if (!build || !at || build.checked === revision) return true;
  for (let i = 0; i < build.pieces.length; i++) {
    const piece = build.pieces[i]!.deref();
    if (!piece) continue;
    const now = scene.getIndividualMeshFrame(piece);
    const origin = now.sharedOrigin ?? piece.origin ?? [0, 0, 0];
    if (now.quantized !== build.quantized[i] || origin[0] !== at[0] || origin[1] !== at[1] || origin[2] !== at[2]) return false;
  }
  build.checked = revision;
  return true;
}

/**
 * Free the copies with a piece now drawn in another frame or encoding: a finalize, requantize or
 * rebuild swapped the batch under it (a fragment's lattice for an f32 bucket, say), and a copy only
 * ties with its base in the frame it was built for. Every piece of a merge or pool is checked, at
 * most once per pick-geometry revision (the pool walk in selection-hydration.ts pays the same per revision). They are
 * built again where the base now draws; a merge goes whole: every merge of its entity, or every pool.
 */
export function retireCopiesInStaleFrames(scene: CopyScene, selected: ReadonlySet<number>): void {
  if (!scene.getIndividualMeshFrame) return;
  const revision = scene.getPickGeometryRevision();
  let stale: Set<Mesh> | undefined, entities: Set<number> | undefined, pools = false;
  for (const mesh of scene.getMeshes()) {
    if (mesh.hydrated !== true || (!selected.has(mesh.expressId) && !mesh.mergedSelection?.ids)) continue;
    if (copyCurrent(scene as CopyScene & Pick<Scene, 'getIndividualMeshFrame'>, mesh, revision)) continue;
    (stale ??= new Set()).add(mesh);
    if (mesh.mergedSelection?.ids) pools = true; else if (mesh.mergedSelection) (entities ??= new Set()).add(mesh.expressId);
  }
  if (stale) scene.removeMeshesWhere((mesh) => stale.has(mesh) || (mesh.hydrated === true && mesh.mergedSelection !== undefined
    && (mesh.mergedSelection.ids ? pools : entities?.has(mesh.expressId) === true)));
}
