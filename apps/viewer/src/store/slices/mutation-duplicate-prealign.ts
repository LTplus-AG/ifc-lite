/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityWorldAabb } from '@ifc-lite/geometry';
import type { ViewerState } from '../index.js';
import { correctPreAlignmentTail, type PreAlignmentMeshBaseline } from './data-mesh-prealign.js';

type Set = (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void;

/** `box` translated by `offset` — the box travels with the same delta as the
 *  positions/origin, or a restore would put the clone's spatial index entry
 *  back at the SOURCE's location instead of the visibly offset duplicate's. */
function translateBox(
  box: EntityWorldAabb | undefined,
  offset: { x: number; y: number; z: number },
): EntityWorldAabb | undefined {
  if (!box) return undefined;
  return {
    min: [box.min[0] + offset.x, box.min[1] + offset.y, box.min[2] + offset.z],
    max: [box.max[0] + offset.x, box.max[1] + offset.y, box.max[2] + offset.z],
  };
}

/**
 * #4970 correction for `duplicateEntity`. `growPreAlignment` (run inside the
 * `appendGeometryBatch` call `duplicateEntity` already makes) treats an
 * appended mesh's CURRENT bytes as its pre-alignment baseline — right for a
 * mesh built fresh from IFC parameters, wrong here: the clone's bytes come
 * from `modelRotationBaker.inModelFrame`, which reverses only the
 * placement-rotation bake, not federation alignment, so on an already-
 * aligned model they are still in the aligned frame.
 *
 * Fix: the clone is the SAME local geometry as its source, so its true
 * baseline is the source's own `preAlignment` slot, offset by the same
 * `origin` delta `cloneMeshesWithOffset` applied to the live mesh. This
 * makes every later re-align a SINGLE, non-compounding transform of the
 * duplicate — the defect this module exists to close — even though the
 * duplicate's offset then rotates/scales with the model on a future
 * re-align instead of staying a fixed viewport nudge.
 *
 * `count` clones and `sourceGlobalId`'s pre-append submeshes correspond
 * positionally, in array order — the same order `cloneMeshesWithOffset`
 * walked them.
 */
export function applyDuplicatePreAlignmentBaseline(
  set: Set,
  modelId: string,
  sourceGlobalId: number,
  count: number,
  offset: { x: number; y: number; z: number },
): void {
  if (count <= 0) return;
  set((s) => {
    const model = s.models.get(modelId);
    const snap = model?.preAlignment;
    const meshes = model?.geometryResult?.meshes;
    if (!snap || !meshes) return {};
    const start = meshes.length - count;
    if (start < 0) return {};

    const sourceIndices: number[] = [];
    for (let i = 0; i < start && sourceIndices.length < count; i += 1) {
      if (meshes[i].expressId === sourceGlobalId) sourceIndices.push(i);
    }
    if (sourceIndices.length < count) return {};

    const known: (PreAlignmentMeshBaseline | undefined)[] = sourceIndices.slice(0, count).map((srcIdx) => {
      if (srcIdx >= snap.positions.length) return undefined;
      const srcOrigin = snap.origins[srcIdx];
      return {
        positions: snap.positions[srcIdx],
        normals: snap.normals[srcIdx],
        origin: [
          (srcOrigin?.[0] ?? 0) + offset.x,
          (srcOrigin?.[1] ?? 0) + offset.y,
          (srcOrigin?.[2] ?? 0) + offset.z,
        ],
        geometryAabb: translateBox(snap.geometryAabbs[srcIdx], offset),
      };
    });

    const nextModels = new Map(s.models);
    nextModels.set(modelId, { ...model, preAlignment: correctPreAlignmentTail(snap, count, known) });
    return { models: nextModels };
  });
}
