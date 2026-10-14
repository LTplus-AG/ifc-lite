/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a section plane is in the scene (#7545), as the renderer resolved it.
 *
 * The renderer turns a cardinal plane's slider percentage into a world plane (its
 * own bounds, the building rotation); the viewer cannot do that exactly, so the
 * plane's name tag, outline and drag handle ask it. The renderer answers from the
 * last frame's bounds and the planes passed here (the store's newest), so a plane
 * that just moved is placed where it IS, not where the last frame drew it.
 */

import type { SectionPlaneFrame } from '@ifc-lite/renderer';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { rendererSectionPlane } from '@/lib/section/section-render-clip';
import { visibleCoordinateInfo } from '@/lib/section/section-plane-inputs';

/** Every plane's frame from the store's current planes, primary first; empty before the renderer has a frame. */
export function currentPlaneFrames(): SectionPlaneFrame[] {
  const renderer = getGlobalRenderer();
  if (!renderer) return [];
  const state = useViewerStore.getState();
  const { sectionPlane, inactiveSectionPlanes } = state;
  // The same range the clip uses, so a tag sits on the plane that cuts.
  const bounds = visibleCoordinateInfo(state)?.shiftedBounds ?? null;
  return renderer.getSectionPlaneFrames({
    primary: sectionPlane.box ? null : rendererSectionPlane(sectionPlane, bounds),
    extras: inactiveSectionPlanes.filter((p) => !p.box).map((p) => rendererSectionPlane(p, bounds)),
  });
}

/** One plane's frame by id, or null. */
export function planeFrame(id: string): SectionPlaneFrame | null {
  return currentPlaneFrames().find((frame) => frame.id === id) ?? null;
}
