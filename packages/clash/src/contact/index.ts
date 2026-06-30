/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contact-interface geometry for a single pair of meshes.
 *
 * Where the AABB clash box is a crude proxy, this returns the REAL contact
 * patch: the shared-face polygon for coplanar/flush overlaps (surface), the
 * intersection line for crossings (line), or a point — classified by area and
 * length. It is built from a Moller triangle-triangle test (which reports the
 * intersection segment for crossings and the coplanar case) followed by
 * shared-face clustering: coplanar triangle pairs are Sutherland-Hodgman clipped
 * on their common plane and unioned into a boundary polygon; cross pairs union
 * their segments along the intersection line.
 *
 * Intended for on-demand use on the FOCUSED clash (one pair), not the bulk
 * detection sweep — clustering every clash would be far too expensive.
 */

import { narrowPhase, type NarrowPhaseOptions } from './narrow-phase.js';
import {
  clusterSharedFaces,
  type SharedFaceCluster,
  type SharedFaceOptions,
} from './shared-faces.js';
import type { Mesh, Vec3 } from './types.js';

export type { Mesh, Vec3, AABB } from './types.js';
export type { SharedFaceCluster, SharedFaceOptions } from './shared-faces.js';
export type { TrianglePair, NarrowPhaseOptions } from './narrow-phase.js';
export { narrowPhase, clusterSharedFaces };

export interface ContactOptions extends NarrowPhaseOptions, SharedFaceOptions {}

/**
 * Compute the contact interface(s) between two world-space meshes: the real
 * shared-face polygon (surface), intersection line, or point — not an AABB.
 * Returns an empty array when the triangles neither cross nor share a plane.
 */
export function contactClusters(a: Mesh, b: Mesh, opts: ContactOptions = {}): SharedFaceCluster[] {
  const pairs = narrowPhase(a, b, opts);
  if (pairs.length === 0) return [];
  return clusterSharedFaces(pairs, opts);
}
