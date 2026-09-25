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

import { unionEntityBounds, type BoundingBox3D } from '@/utils/viewportUtils';

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

/** The overlap of two boxes, or null when they are disjoint. */
function intersect(a: BoundingBox3D, b: BoundingBox3D): BoundingBox3D | null {
  const min = { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y), z: Math.max(a.min.z, b.min.z) };
  const max = { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y), z: Math.min(a.max.z, b.max.z) };
  return min.x <= max.x && min.y <= max.y && min.z <= max.z ? { min, max } : null;
}

export interface FitAllInput {
  /** Ids of the flat meshes currently drawn (global ids). Already filtered:
   *  a hidden model's and a toggled-off class's meshes are not in it. */
  meshIds: Iterable<number>;
  /** Ids of the GPU-instanced occurrences (global ids). */
  instancedIds: Iterable<number>;
  /** False in the Types view, where the instanced pass is not drawn. */
  instancedDrawn: boolean;
  boundsOf: (id: number) => BoundingBox3D | null | undefined;
  visibility: EffectiveVisibility;
  /**
   * The load-time, outlier-trimmed whole-scene box (#1107, #1394). It is not
   * recomputed when a model is hidden, so it is never framed as is; it only
   * clamps the visible box, so a sparse far-away tail stays trimmed.
   */
  wholeScene: BoundingBox3D;
}

/**
 * The box Fit All frames: the union of what is drawn and visible, clamped to
 * the trimmed whole-scene box. When the two do not overlap (the user isolated
 * the trimmed-away outlier itself) the visible box is framed unclamped. With
 * nothing visible, or a degenerate union, the whole scene.
 */
export function fitAllBounds(input: FitAllInput): BoundingBox3D {
  const visible: number[] = [];
  const seen = new Set<number>();
  const take = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (isEffectivelyVisible(id, input.visibility)) visible.push(id);
  };
  for (const id of input.meshIds) take(id);
  if (input.instancedDrawn) for (const id of input.instancedIds) take(id);
  // With no flat mesh list every bound comes from `boundsOf`, the same union
  // frameEntities uses.
  const union = unionEntityBounds(null, visible, input.boundsOf);
  if (!union || !isSaneBounds(union)) return input.wholeScene;
  return intersect(union, input.wholeScene) ?? union;
}
