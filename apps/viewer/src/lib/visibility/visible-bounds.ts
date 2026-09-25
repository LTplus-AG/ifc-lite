/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Fit All frames: the bounds of what is VISIBLE now (#5884), not the
 * load-time bounds cache. That cache holds every mesh that ever streamed in,
 * so isolating one storey, hiding elements or hiding a far-away federated
 * model and pressing Fit All still framed all of it.
 *
 * "Visible" is the renderer's own rule over the viewer's effective channels:
 * - `hidden`: user hides plus every entity of a hidden model
 *   (`modelHiddenEntities`, the set `useVisibilityState` returns);
 * - `isolated`: the effective isolation (storey selection, class filter and
 *   isolate intersected, `effectiveIsolatedIds`), or null for none.
 */

import { unionEntityBounds, type BoundingBox3D } from '@/utils/viewportUtils';

export interface EffectiveVisibility {
  hidden: ReadonlySet<number>;
  isolated: ReadonlySet<number> | null;
}

export function isEffectivelyVisible(id: number, visibility: EffectiveVisibility): boolean {
  if (visibility.hidden.has(id)) return false;
  return visibility.isolated === null || visibility.isolated.has(id);
}

/**
 * Union of the world bounds of the visible ids among `ids` (global ids, the
 * id space meshes and the renderer share). Null when nothing visible has
 * bounds, so the caller can fall back to the whole scene.
 */
export function visibleBounds(
  ids: Iterable<number>,
  boundsOf: (id: number) => BoundingBox3D | null | undefined,
  visibility: EffectiveVisibility,
): BoundingBox3D | null {
  const visible: number[] = [];
  for (const id of ids) if (isEffectivelyVisible(id, visibility)) visible.push(id);
  // The same union frameEntities uses; with no flat mesh list every bound
  // comes from `boundsOf`.
  return unionEntityBounds(null, visible, boundsOf);
}
