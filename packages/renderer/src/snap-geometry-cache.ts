/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry cache building for snap detection.
 *
 * Three stages, in order, because each one is what makes the next answerable:
 *
 * 1. WELD by position (`snap-weld.ts`). The wasm mesh is unwelded across
 *    creases, so classifying edges by vertex INDEX made every physical edge
 *    arrive twice with one adjacent triangle each — every edge looked like a
 *    boundary edge, the coplanarity test below could never fire, and the cache
 *    filled with triangulation diagonals (911 of 1755 distinct edges on
 *    `building-architecture.ifc`) that a user can snap to and measure.
 * 2. CLASSIFY: keep boundary and crease edges, drop the diagonals shared by two
 *    coplanar triangles.
 * 3. MERGE collinear runs (`snap-edge-runs.ts`), so a straight model edge that
 *    several triangles cross becomes ONE edge of the length the user sees.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';
import type { SnapEdge } from './snap-edge-runs.js';
import { GeometryCacheBuild } from './snap-geometry-build.js';

export type { SnapEdge } from './snap-edge-runs.js';

export interface MeshGeometryCache {
  vertices: Vec3[];
  edges: SnapEdge[];
}

/**
 * Build a geometry cache for a mesh: welded vertices plus reconstructed model
 * edges with their corner valences. Runs `GeometryCacheBuild` to completion;
 * the idle snap pipeline runs the same build in bounded steps instead.
 */
export function buildGeometryCache(mesh: MeshData): MeshGeometryCache {
  const build = new GeometryCacheBuild(mesh);
  while (!build.step()) { /* one call to completion */ }
  return build.result();
}
