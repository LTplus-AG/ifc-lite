/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a Section zoom asks for, and the arithmetic of its margin (#7545). Pure, so
 * the store can hold a spec without importing the camera.
 *
 * A margin is room on EACH side of the target, as a fraction of its largest extent
 * (0.10 = 10 %) or an absolute length. The renderer's framing takes a multiple of
 * the bounds (`Camera.frameBounds(min, max, ms, padding)`: 1 is edge to edge), so
 * the multiple is `1 + 2 * margin / extent`: with a 10 % margin the target spans
 * exactly 1 / 1.2 of the frame's limiting dimension.
 */

import type { Aabb } from './cut-region';

export type SectionZoomTarget = 'selection' | 'cut-region' | 'model';

export type SectionZoomMargin =
  | { kind: 'fraction'; value: number }
  | { kind: 'metres'; value: number };

export interface SectionZoomSpec {
  target: SectionZoomTarget;
  /** Extra room around the target, on each side. */
  margin: SectionZoomMargin;
}

/** The reference tool's "zoom to selection plus 10 % margin", and the first thing the popover offers. */
export const DEFAULT_SECTION_ZOOM: SectionZoomSpec = { target: 'selection', margin: { kind: 'fraction', value: 0.1 } };

/** The most margin one side may carry: more than the target's own size is a typo, not a view. */
export const MAX_ZOOM_MARGIN_FRACTION = 5;

function largestExtent(bounds: Aabb): number {
  return Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
}

/**
 * The framing multiple for `margin` around `bounds`. A target with no extent (a single
 * point) cannot take a fractional margin; it is framed edge to edge rather than at infinity.
 */
export function zoomPadding(bounds: Aabb, margin: SectionZoomMargin): number {
  const value = Number.isFinite(margin.value) ? Math.max(0, margin.value) : 0;
  const extent = largestExtent(bounds);
  if (!(extent > 0)) return 1;
  const eachSide = margin.kind === 'fraction' ? Math.min(value, MAX_ZOOM_MARGIN_FRACTION) * extent : value;
  return 1 + (2 * eachSide) / extent;
}
