/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store's `sectionPlane` as the renderer's clip options (#5513): the
 * one place `useAnimationLoop` turns the cut into `RenderOptions`.
 *
 * Outside the Section tool nothing clips (`store/section-active.ts` holds
 * the same invariant on the store side). Inside it, box mode
 * (`sectionPlane.box`) hands the renderer its `ClipBox` and NO plane at
 * all: the renderer draws a plane's preview quad whenever it is handed one,
 * even disabled (`render-section-draw.ts`), and the cardinal `axis` /
 * `position` the store keeps for the Drawing panel and BCF must not haunt
 * the box as a translucent quad. Plane mode passes the plane through as
 * before: the cap settings, the cardinal range, and a face-picked
 * normal/distance the shader uses verbatim.
 */

import type { RenderOptions } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store/types';

export type SectionRenderClip = Pick<RenderOptions, 'sectionPlane' | 'clipBox'>;

export function sectionRenderClip(
  activeTool: string,
  plane: SectionPlane,
  range: { min: number; max: number } | null,
): SectionRenderClip {
  if (activeTool !== 'section') return {};
  const box = plane.box;
  if (box) return { clipBox: { min: box.min, max: box.max, enabled: plane.enabled } };
  return {
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
