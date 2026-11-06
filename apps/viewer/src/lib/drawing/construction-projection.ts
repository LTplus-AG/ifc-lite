/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a drawing shows construction projection (#979), the content beyond
 * the cut plane, for the plane it is cut on (#8802).
 *
 * The stored `showConstructionProjection` display option is three-valued:
 *  - `null`: the user has not chosen. It follows the cut: ON for a plan
 *    (`down`) cut, where a floor plan without the slab, furniture and openings
 *    below the cut height reads as a few loose wall strips, and OFF for a
 *    front or side section, which keeps the previous default.
 *  - `true` / `false`: an explicit choice. It is set by the Projection toggle,
 *    or restored from a persisted drawing, and holds on every cut.
 *
 * A face-picked custom plane never projects; `useDrawingGeneration` and the
 * toolbar gate that separately, so this only resolves the preference.
 */

export type ConstructionProjectionPreference = boolean | null;

interface PlaneForProjection {
  axis: 'down' | 'front' | 'side';
}

/** The effective projection setting for a cut on `plane`. */
export function constructionProjectionEnabled(
  preference: ConstructionProjectionPreference | undefined,
  plane: PlaneForProjection,
): boolean {
  if (typeof preference === 'boolean') return preference;
  return plane.axis === 'down';
}

/**
 * The value the Projection toggle stores: the opposite of what the user sees,
 * as an explicit choice. It never goes back to `null`, so the user's choice
 * outlives a switch between plan and section.
 */
export function toggledConstructionProjection(
  preference: ConstructionProjectionPreference | undefined,
  plane: PlaneForProjection,
): boolean {
  return !constructionProjectionEnabled(preference, plane);
}
