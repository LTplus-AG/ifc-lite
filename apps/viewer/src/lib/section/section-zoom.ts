/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact zoom for the Section tool (#7545): frame a chosen target with a stated
 * margin (`section-zoom-spec.ts`), keeping the current view direction and projection.
 */

import { resolveKeptHalfSpace } from '@/lib/export/view-pdf/view-section-plane';
import { resolveClippingSectionInputs } from './section-plane-inputs';
import { clipBoundsByPlanes, type Aabb } from './cut-region';
import { zoomPadding, type SectionZoomSpec, type SectionZoomTarget } from './section-zoom-spec';
import { getGlobalRenderer } from '@/hooks/useBCF';
import type { useViewerStore } from '@/store';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/** The part of the model the cutting planes leave on screen, in world space. Null when the planes cut it all away or nothing is loaded. */
export function cutRegionBounds(state: ViewerState): Aabb | null {
  const scene = getGlobalRenderer()?.getCamera()?.getSceneBounds() ?? null;
  if (!scene) return null;
  const planes = resolveClippingSectionInputs(state).map((input) => {
    const half = resolveKeptHalfSpace(input);
    return { normal: [half.normal.x, half.normal.y, half.normal.z] as const, distance: half.offset, flipped: false };
  });
  return clipBoundsByPlanes(scene, planes);
}

/** The world bounds a spec's target names right now, or null when there is nothing to frame. */
export function zoomTargetBounds(target: SectionZoomTarget, state: ViewerState): Aabb | null {
  if (target === 'selection') return state.cameraCallbacks.selectionBounds?.() ?? null;
  if (target === 'cut-region') return cutRegionBounds(state);
  return getGlobalRenderer()?.getCamera()?.getSceneBounds() ?? null;
}

/** Frame the spec's target with its margin. Resolves false when there is nothing to frame (no selection, everything cut away). */
export function zoomToSectionTarget(state: ViewerState, spec: SectionZoomSpec, durationMs = 300): Promise<boolean> {
  const bounds = zoomTargetBounds(spec.target, state);
  const frame = state.cameraCallbacks.frameBounds;
  if (!bounds || !frame) return Promise.resolve(false);
  return frame(bounds.min, bounds.max, { padding: zoomPadding(bounds, spec.margin), durationMs });
}
