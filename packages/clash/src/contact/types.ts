/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core geometric and identity types for connection detection.
 *
 * IDs are opaque strings. In an ifc-lite integration they'd be
 * federation-aware GlobalIds, but this package treats them as
 * strings so it stays independent of the viewer.
 */

export type Vec3 = readonly [number, number, number];

/** Axis-aligned bounding box in world coordinates. */
export interface AABB {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** An entity's bounds, keyed by an opaque id. */
export interface MeshBounds {
  readonly id: string;
  readonly aabb: AABB;
}

/** Triangulated mesh in world coordinates (Z-up, matching IFC). */
export interface Mesh {
  readonly id: string;
  /** Flat array of positions, length = 3 * vertexCount. */
  readonly positions: Float32Array | Float64Array;
  /** Flat array of triangle indices, length = 3 * triangleCount. */
  readonly indices: Uint32Array;
}

/** Unordered pair of ids, canonicalised to (min, max) lexicographically. */
export type IdPair = readonly [string, string];

/** Classification types emitted by the shared-face pipeline. */
export type ConnectionType = "point" | "line" | "surface";

/** Reference type for an element's buildup origin. */
export type ReferenceType = "outer_face" | "center" | "upper_face";
