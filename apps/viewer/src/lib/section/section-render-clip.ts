/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store's `sectionPlane` as the renderer's clip options (#5513, #5893):
 * the one place `useAnimationLoop` turns the cut into `RenderOptions`.
 *
 * Nothing clips while `sceneState.section.visible` is false — the cut is
 * lasting scene state the user toggles (#5893), no longer tied to the
 * Section tool being open (`store/section-active.ts` holds the matching
 * invariant on the store side: `activeSectionPlane()`). While visible, box
 * mode (`sectionPlane.box`) hands the renderer its `ClipBox` and NO plane at
 * all: the renderer draws a plane's preview quad whenever it is handed one,
 * even disabled (`render-section-draw.ts`), and the cardinal `axis` /
 * `position` the store keeps for the Drawing panel and BCF must not haunt
 * the box as a translucent quad. Plane mode passes the plane through as
 * before: the cap settings, the cardinal range, and a face-picked
 * normal/distance the shader uses verbatim.
 *
 * A plane that is NOT cutting (`enabled: false`) is only an editing aid: the
 * renderer draws it as the translucent preview quad the Section tool shows
 * while you pick or aim a cut. It is handed over only while that tool is
 * open (#6374). #5893 made the CUT lasting scene state, but the gate it
 * swapped in (`visible`, default `true`) also let the preview outlive the
 * tool, so every freshly loaded file showed a stray plane at the default
 * position that no control could hide: the HUD chip that owns the hide
 * toggle only exists while a cut is enabled, and its "Forget this cut"
 * turns the cut off, which is exactly the state that kept drawing. Box mode
 * needs no such rule: a disabled box draws nothing.
 */

import type { RenderOptions } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store/types';
import { isPristineSectionPlane } from './section-plane-set';

export type SectionRenderClip = Pick<RenderOptions, 'sectionPlane' | 'extraSectionPlanes' | 'clipBox'>;

/** One plane as the renderer's `SectionPlane`: no cap range (the renderer measures its own bounds), no gizmo. */
function toRendererPlane(p: SectionPlane): NonNullable<RenderOptions['extraSectionPlanes']>[number] {
  return {
    axis: p.axis, position: p.position, enabled: p.enabled, flipped: p.flipped,
    normal: p.custom?.normal, distance: p.custom?.distance,
  };
}

export function sectionRenderClip(
  visible: boolean,
  plane: SectionPlane,
  range: { min: number; max: number } | null,
  activeTool: string,
  inactive: readonly SectionPlane[] = [],
): SectionRenderClip {
  if (!visible) return {};
  // The planes beyond the active one (#7545): each clips on its own, resolved by the
  // renderer like the primary. A boxed plane clips by its box (one box slot), so it adds
  // no plane; the active plane's box wins the slot.
  const extra = inactive.filter((p) => p.enabled && !p.box);
  const extraClip = extra.length > 0 ? { extraSectionPlanes: extra.map(toRendererPlane) } : {};
  const boxed = plane.box ? plane : inactive.find((p) => p.enabled && p.box);
  const box = boxed?.box;
  if (box) return { ...extraClip, clipBox: { min: box.min, max: box.max, enabled: boxed.enabled } };
  // No preview for a plane the user has not made yet (the unnamed placeholder), nor for a disabled one outside the Section tool (#6374).
  if (!plane.enabled && (activeTool !== 'section' || isPristineSectionPlane(plane))) return extraClip;
  return {
    ...extraClip,
    sectionPlane: {
      axis: plane.axis,
      position: plane.position,
      enabled: plane.enabled,
      flipped: plane.flipped,
      showCap: plane.showCap,
      showOutlines: plane.showOutlines,
      capStyle: plane.capStyle,
      min: range?.min,
      max: range?.max,
      normal: plane.custom?.normal,
      distance: plane.custom?.distance,
    },
  };
}
