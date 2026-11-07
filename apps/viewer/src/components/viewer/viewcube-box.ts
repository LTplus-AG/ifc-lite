/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ViewCube's on-screen box, in one place: `ViewCube` draws at this size,
 * `ViewportOverlays` anchors it at this inset from the viewport's top-right
 * corner, and `ViewportHud` derives the room it keeps clear of it (the
 * top-right region starts below it, the top-center lane stops left of it).
 * Change the cube here and the HUD follows, so the two cannot drift apart.
 */

/** Edge length of the cube, in CSS px. */
export const VIEW_CUBE_SIZE_PX = 72;

/** Inset of the cube's box from the viewport's top edge, in CSS px. */
export const VIEW_CUBE_INSET_PX = 24;

/**
 * Inset of the cube's box from the viewport's right edge, in CSS px.
 *
 * Larger than the top inset because the cube is drawn rotated: at its resting
 * isometric pose the silhouette reaches about 20px past the box sideways (a
 * face diagonal is 1.41 of an edge, plus the 200px perspective) but only about
 * 13px above it. At the same 24px on both sides the silhouette sat 4px from
 * the right edge and read as clipped on a phone (#8802 R6). 8px more gives
 * the right edge the same visible gap as the top.
 */
export const VIEW_CUBE_RIGHT_INSET_PX = VIEW_CUBE_INSET_PX + 8;

/** Top inset plus size: how far the cube reaches down from the top edge. */
export const VIEW_CUBE_REACH_PX = VIEW_CUBE_INSET_PX + VIEW_CUBE_SIZE_PX;

/** Right inset plus size: how far the cube reaches in from the right edge. */
export const VIEW_CUBE_REACH_X_PX = VIEW_CUBE_RIGHT_INSET_PX + VIEW_CUBE_SIZE_PX;

/** Width of the edge and corner bands on each face, in CSS px. */
export const VIEW_CUBE_EDGE_BAND_PX = 16;
