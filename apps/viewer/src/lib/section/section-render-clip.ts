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

/** The model's bounds the Section range is read from (`coordinateInfo.shiftedBounds`). */
export interface RangeBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** A cardinal plane's slider range along its own axis: the one the Section bar, the caps and the offset field use. */
function axisRange(p: SectionPlane, bounds: RangeBounds | null | undefined): { min?: number; max?: number } {
  if (!bounds || p.custom) return {};
  const key = p.axis === 'side' ? 'x' : p.axis === 'down' ? 'y' : 'z';
  const min = bounds.min[key];
  const max = bounds.max[key];
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : {};
}

/**
 * One plane as the renderer's `SectionPlane`. The id keys the plane's cap and its frame; `showGizmo`
 * hides the primary quad. With `bounds` a cardinal plane carries the same slider range as the active
 * plane does, so every plane's percentage means the same place in the clip, the cap and the offset field.
 */
export function rendererSectionPlane(p: SectionPlane, bounds?: RangeBounds | null): NonNullable<RenderOptions['extraSectionPlanes']>[number] {
  return {
    id: p.id, showGizmo: p.showGizmo, axis: p.axis, position: p.position, enabled: p.enabled, flipped: p.flipped,
    normal: p.custom?.normal, distance: p.custom?.distance,
    ...axisRange(p, bounds),
  };
}

/**
 * The plane whose box clips (the renderer has ONE box slot): the active plane's box while it is cutting,
 * else the first inactive plane's box that is, else the active plane's box switched off. One rule, shared
 * with the PDF export, the zoom and the BCF/SDK readers, so none of them clips by a box the screen does not.
 */
export function boxHoldingPlane(plane: SectionPlane, inactive: readonly SectionPlane[]): SectionPlane | undefined {
  return plane.box && plane.enabled ? plane : (inactive.find((p) => p.enabled && p.box) ?? (plane.box ? plane : undefined));
}

export function sectionRenderClip(
  visible: boolean,
  plane: SectionPlane,
  range: { min: number; max: number } | null,
  activeTool: string,
  inactive: readonly SectionPlane[] = [],
  bounds?: RangeBounds | null,
): SectionRenderClip {
  if (!visible) return {};
  // The planes beyond the active one (#7545): each is resolved by the renderer like the primary;
  // only the enabled ones clip, the rest are handed over so their marks and previews exist.
  // A boxed plane clips by its box (one box slot), so it adds no plane; the active plane's box wins the slot.
  const extra = inactive.filter((p) => !p.box);
  const extraClip = extra.length > 0 ? { extraSectionPlanes: extra.map((p) => rendererSectionPlane(p, bounds)) } : {};
  // The active plane's box wins the one box slot; otherwise an enabled inactive plane's box takes it.
  // Either way the clip does not depend on WHICH plane is active: a boxed inactive plane clips by its
  // box and the active plane (when it is not the boxed one) still clips by itself, below.
  const boxed = boxHoldingPlane(plane, inactive);
  const box = boxed?.box;
  const boxClip = box && boxed ? { clipBox: { min: box.min, max: box.max, enabled: boxed.enabled } } : {};
  if (plane.box) return { ...extraClip, ...boxClip };
  // No preview for a plane the user has not made yet (the unnamed placeholder), nor for a disabled one outside the Section tool (#6374).
  if (!plane.enabled && (activeTool !== 'section' || isPristineSectionPlane(plane))) return { ...extraClip, ...boxClip };
  return {
    ...extraClip,
    ...boxClip,
    sectionPlane: {
      id: plane.id,
      showGizmo: plane.showGizmo,
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
