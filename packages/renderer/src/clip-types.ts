/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The clip volumes `RenderOptions` hands the renderer; re-exported from `types.ts`. */

/**
 * Axis-aligned clip box (section / crop box): geometry is kept only where it
 * lies INSIDE all six box planes; fragments outside the box are discarded by the
 * shader (real geometry cut, unlike bounding-box element isolation). Coordinates
 * are in the same world space the shader sees as `input.worldPos` — i.e. the
 * viewer space the camera/section planes use. Independent of `sectionPlane`; both
 * can be active at once.
 */
export interface ClipBox {
  /** Box min corner [x, y, z] in world space. */
  min: [number, number, number];
  /** Box max corner [x, y, z] in world space. */
  max: [number, number, number];
  /** When false (or omitted), the box has no effect. */
  enabled: boolean;
}

/**
 * One more half-space cut beyond `RenderOptions.sectionPlane` (#7545): a
 * world-space plane `dot(p, normal) = distance`, with the side the fragment
 * test removes chosen by `flipped` exactly as for the primary plane (removed
 * where `(dot(p, normal) - distance) * (flipped ? -1 : 1) > 0`). It has no
 * gizmo, cap or range; the renderer only clips against it. Passes clip
 * against every plane at once.
 */
export interface ExtraClipPlane {
  /** Unit world-space normal. */
  normal: [number, number, number];
  /** `dot(pointOnPlane, normal)` in world units. */
  distance: number;
  flipped: boolean;
  /** The plane's id when it came from `RenderOptions.extraSectionPlanes` and had one: keys its cap. */
  id?: string;
}
