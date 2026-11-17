/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The point vertex layout, shared by the splat pipeline and the GPU point
// picker. Its own module so the picker (part of `@ifc-lite/renderer/core`)
// reaches these numbers without loading the splat pipeline and its shader.

/** Bytes per point vertex: position (3 × f32) + packed colour/class/intensity. */
export const POINT_VERTEX_BYTES = 24;
/** Number of vertices emitted per splat (two triangles forming a quad). */
export const POINT_QUAD_VERTS = 6;
