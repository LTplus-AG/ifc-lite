/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { PreAlignmentSnapshot } from '../types.js';

/**
 * Growth counterpart to `data-mesh-prune.ts`'s `prunePreAlignment` (#4970).
 *
 * `preAlignment` restores its per-mesh arrays BY INDEX, so appending meshes
 * onto a model that already carries a snapshot must push one matching entry
 * per appended mesh, or index `i` drifts from the mesh it names on the very
 * next align and a later mesh silently restores from an earlier one's slot
 * (or, past the snapshot's length, is not restored at all and keeps
 * whatever bake it last received — the double-transform this issue is
 * about).
 *
 * This is sound because of WHERE `appendGeometryBatch`'s meshes come from:
 * every caller (`addWall`/`addSlab`, a split's two halves, `duplicateEntity`,
 * and the undo-restore stash in `mutation-mesh-stash.ts`) produces or stashes
 * vertices in the model's own PRISTINE frame — the same frame `capturePreAlignment`
 * captures existing meshes in — never the anchor-aligned one. So the appended
 * mesh's CURRENT data already IS its pre-alignment baseline; growth just
 * copies it into the snapshot's arrays, the same copy discipline
 * `capturePreAlignment` uses (own arrays, not shared references), so an
 * in-place edit of the live mesh afterward cannot rewrite the baseline.
 *
 * `instancedGeometryAabbs` is untouched: that channel is keyed by expressId,
 * not by mesh index, so it needs no growth step here — a newly appended
 * entity's instanced-only box (if any) is written directly by its own caller.
 */
export function growPreAlignment(
  snapshot: PreAlignmentSnapshot,
  appended: GeometryResult['meshes'],
): PreAlignmentSnapshot {
  if (appended.length === 0) return snapshot;
  return {
    ...snapshot,
    positions: [
      ...snapshot.positions,
      ...appended.map((mesh) => new Float32Array(mesh.positions)),
    ],
    normals: [
      ...snapshot.normals,
      ...appended.map((mesh) => (
        mesh.normals && mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined
      )),
    ],
    origins: [
      ...snapshot.origins,
      ...appended.map((mesh) => (mesh.origin ? [...mesh.origin] as [number, number, number] : undefined)),
    ],
    geometryAabbs: [
      ...snapshot.geometryAabbs,
      ...appended.map((mesh) => mesh.geometryAabb),
    ],
  };
}
