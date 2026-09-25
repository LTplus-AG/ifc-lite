/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Fit All frames: what is VISIBLE now (#5884), not the load-time bounds
 * cache. That cache holds every mesh that ever streamed in, so isolating one
 * storey, hiding elements or hiding a far-away federated model and pressing
 * Fit All still framed all of it.
 *
 * "Visible" is the renderer's own rule over the viewer's effective channels:
 * - `hidden`: user hides plus every entity of a hidden model
 *   (`modelHiddenEntities`, the set `useVisibilityState` returns);
 * - `isolated`: the effective isolation (storey selection, class filter and
 *   isolate intersected, `effectiveIsolatedIds`), or null for none.
 * Class toggles (spaces, openings, site, ...) are already applied: the flat
 * mesh list is the filtered one, and toggled classes never reach the
 * instanced shard (`typeVisibilityFilter.ts`, #5409).
 */

import type { BoundingBox3D } from '@/utils/viewportUtils';
import { robustFitBoundsFull, type RobustFitMeshInput } from '@/components/viewer/robustFitBoundsAccumulator';

export interface EffectiveVisibility {
  hidden: ReadonlySet<number>;
  isolated: ReadonlySet<number> | null;
}

function isEffectivelyVisible(id: number, visibility: EffectiveVisibility): boolean {
  if (visibility.hidden.has(id)) return false;
  return visibility.isolated === null || visibility.isolated.has(id);
}

/** Every component finite and the span sane (the `frameEntities` gate). */
function isSaneBounds(b: BoundingBox3D): boolean {
  const values = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
  if (!values.every(Number.isFinite)) return false;
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
  return span >= 0 && span < 1e5;
}

/**
 * Whether the GPU-instanced pass is drawn: instancing is class-0 occurrence
 * geometry, hidden in the Types view mode when the model carries a type
 * library. The one gate for the scene (`setInstancedVisible`) and Fit All.
 */
export function instancedPassDrawn(s: { hasTypeGeometry: boolean; typeViewMode: string }): boolean {
  return !s.hasTypeGeometry || s.typeViewMode === 'model';
}

export interface FitAllInput {
  /** The flat meshes currently drawn (global ids). Already filtered: a
   *  hidden model's and a toggled-off class's meshes are not in it. */
  meshes: Iterable<{ expressId: number; ifcType?: string }>;
  /** Ids of the GPU-instanced occurrences (global ids). */
  instancedIds: Iterable<number>;
  /** False in the Types view, where the instanced pass is not drawn. */
  instancedDrawn: boolean;
  /** IFC class of an instanced occurrence (they carry none): the #5633
   *  marker rule drops a detached cluster made only of proxies. */
  typeOf: (id: number) => string | undefined;
  /** PLACED world bounds per id (model placement offsets applied). */
  boundsOf: (id: number) => BoundingBox3D | null | undefined;
  visibility: EffectiveVisibility;
  /** The load-time fit box; framed only when nothing visible has bounds. */
  wholeScene: BoundingBox3D;
}

/**
 * The box Fit All frames: the entities that are drawn and visible, with a
 * sparse far-away tail trimmed by the same outlier-robust fold the load-time
 * fit uses (#1107, #1394), computed now from placed bounds, so a moved model
 * or geometry authored after load is framed where it is. Each entity weighs
 * the same here (the load-time fit weighs by vertex count). An isolated
 * outlier is framed as is: one entity has no tail to trim.
 */
export function fitAllBounds(input: FitAllInput): BoundingBox3D {
  const boxes: RobustFitMeshInput[] = [];
  const seen = new Set<number>();
  const take = (id: number, ifcType: string | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!isEffectivelyVisible(id, input.visibility)) return;
    const b = input.boundsOf(id);
    if (b) boxes.push({ positions: Float64Array.of(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z), ifcType });
  };
  for (const mesh of input.meshes) take(mesh.expressId, mesh.ifcType);
  if (input.instancedDrawn) for (const id of input.instancedIds) take(id, input.typeOf(id));
  const fit = robustFitBoundsFull(boxes, { quiet: true });
  const bounds = fit ? (fit.robust ?? fit.full) : null;
  return bounds && isSaneBounds(bounds) ? bounds : input.wholeScene;
}
