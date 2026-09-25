/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderOptions } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store';

/**
 * Builds the `sectionPlane` render option from the section-tool state, or
 * `undefined` when the section tool is not the active tool. Extracted from
 * `useAnimationLoop.ts`'s per-frame `renderer.render()` call (#5390) to make
 * room in that file, which sits at its module-size budget.
 */
export function buildSectionPlaneOption(
  isSectionToolActive: boolean,
  sectionPlane: SectionPlane,
  range: { min: number; max: number } | null,
): RenderOptions['sectionPlane'] {
  if (!isSectionToolActive) return undefined;
  return {
    axis: sectionPlane.axis,
    position: sectionPlane.position,
    enabled: sectionPlane.enabled,
    flipped: sectionPlane.flipped,
    // Cap rendering settings — the renderer reads these to draw the
    // filled, hatched cut surfaces.
    showCap: sectionPlane.showCap,
    showOutlines: sectionPlane.showOutlines,
    capStyle: sectionPlane.capStyle,
    min: range?.min,
    max: range?.max,
    // Custom (face-picked) plane override (issue #243). When set the
    // renderer uses these verbatim and ignores axis/position/min/max for
    // the clip math; cap polygons are still emitted through the same
    // Section2DOverlayRenderer with a custom basis so the silhouette
    // lands on the tilted plane.
    normal: sectionPlane.custom?.normal,
    distance: sectionPlane.custom?.distance,
  };
}
