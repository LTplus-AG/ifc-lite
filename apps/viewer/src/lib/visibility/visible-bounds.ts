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

export interface FitAllInput {
  /** Ids of the flat meshes currently drawn (global ids). */
  meshIds: Iterable<number>;
  /** Ids of the GPU-instanced occurrences (global ids). */
  instancedIds: Iterable<number>;
  /** False in the Types view, where the instanced pass is not drawn. */
  instancedDrawn: boolean;
  boundsOf: (id: number) => BoundingBox3D | null | undefined;
  visibility: EffectiveVisibility;
  /**
   * The whole-scene fit box: the load-time, outlier-trimmed bounds (#1107,
   * #1394). Used as is when nothing is filtered out, so a stray far-away
   * element still does not pull the fit into empty space.
   */
  wholeScene: BoundingBox3D;
}

/** The box Fit All frames. */
export function fitAllBounds(input: FitAllInput): BoundingBox3D {
  const ids = new Set(input.meshIds);
  if (input.instancedDrawn) for (const id of input.instancedIds) ids.add(id);
  const visible: number[] = [];
  for (const id of ids) if (isEffectivelyVisible(id, input.visibility)) visible.push(id);
  // Nothing filtered out: the whole scene, outlier trimming included.
  if (input.instancedDrawn && visible.length === ids.size) return input.wholeScene;
  // With no flat mesh list every bound comes from `boundsOf`, the same union
  // frameEntities uses.
  const bounds = unionEntityBounds(null, visible, input.boundsOf);
  return bounds && isSaneBounds(bounds) ? bounds : input.wholeScene;
}
