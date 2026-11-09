/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Category of line in architectural drawing
 */
export type LineCategory =
  | 'cut'         // Geometry intersected by section plane (thickest lines)
  | 'projection'  // Visible geometry beyond cut plane
  | 'hidden'      // Occluded geometry (rendered as dashed)
  | 'silhouette'  // Outer contour edges
  | 'crease'      // Sharp feature edges (angle > threshold)
  | 'boundary'    // Mesh boundary edges (open edges)
  | 'annotation'; // Dimensions, labels, etc.

/**
 * Visibility state for hidden line removal
 */
export type VisibilityState = 'visible' | 'hidden' | 'partial';
