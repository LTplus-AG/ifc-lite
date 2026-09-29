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
export const VIEW_CUBE_SIZE_PX = 60;

/** Inset of the cube's box from the viewport's top and right edges, in CSS px. */
export const VIEW_CUBE_INSET_PX = 24;

/** Inset plus size: how far the cube reaches in from the top-right corner. */
export const VIEW_CUBE_REACH_PX = VIEW_CUBE_INSET_PX + VIEW_CUBE_SIZE_PX;
