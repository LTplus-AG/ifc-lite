/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityWorldAabb, GeometryResult } from '@ifc-lite/geometry';
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
 * The naive assumption here — the appended mesh's CURRENT data already IS
 * its pre-alignment baseline — holds for `addWall`/`addSlab` and a split's
 * two halves: they build fresh from IFC parameters, in the model's own
 * pristine frame, never the anchor-aligned one (see rotation-bake.ts's
 * "COROLLARY FOR AUTHORING"). It does NOT hold for `duplicateEntity` or the
 * undo-restore stash: both read live/`inModelFrame` bytes, which reverse
 * only the placement-ROTATION bake, not federation ALIGNMENT — on an
 * already-aligned model those bytes are still in the aligned frame. Those
 * two callers grow a slot here like everyone else (so the index invariant
 * never breaks), then immediately correct it with `correctPreAlignmentTail`
 * once they can compute the true baseline (`mutationSlice.ts`'s
 * `duplicateEntity`, `mutation-mesh-stash.ts`'s `restoreStashedEntityMesh`).
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

/** The true pre-alignment value for one mesh, for a caller that can compute
 *  it directly instead of relying on `growPreAlignment`'s "current bytes are
 *  pristine" guess (see the module comment above). */
export interface PreAlignmentMeshBaseline {
  positions: Float32Array;
  normals?: Float32Array;
  origin?: [number, number, number];
  geometryAabb?: EntityWorldAabb;
}

/**
 * Overwrite the LAST `count` slots of `snapshot` with `known` values — the
 * born-correct counterpart to `growPreAlignment`'s guess, for a caller that
 * just grew the snapshot by `count` (via `growPreAlignment`, through
 * `appendGeometryBatch`) and can now supply the real baseline for some or
 * all of those slots. `known[i]` corresponds to the mesh at
 * `snapshot.positions.length - count + i`; an `undefined` entry leaves that
 * one slot exactly as `growPreAlignment` set it (nothing to correct it
 * with).
 */
export function correctPreAlignmentTail(
  snapshot: PreAlignmentSnapshot,
  count: number,
  known: ReadonlyArray<PreAlignmentMeshBaseline | undefined>,
): PreAlignmentSnapshot {
  const start = snapshot.positions.length - count;
  if (count <= 0 || start < 0) return snapshot;
  const positions = [...snapshot.positions];
  const normals = [...snapshot.normals];
  const origins = [...snapshot.origins];
  const geometryAabbs = [...snapshot.geometryAabbs];
  for (let i = 0; i < count; i += 1) {
    const baseline = known[i];
    if (!baseline) continue;
    positions[start + i] = new Float32Array(baseline.positions);
    normals[start + i] = baseline.normals ? new Float32Array(baseline.normals) : undefined;
    origins[start + i] = baseline.origin ? [...baseline.origin] : undefined;
    geometryAabbs[start + i] = baseline.geometryAabb;
  }
  return { ...snapshot, positions, normals, origins, geometryAabbs };
}
