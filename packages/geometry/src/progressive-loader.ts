/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry quality mode, threaded through the loader options.
 *
 * (The former priority-based `ProgressiveMeshLoader` / web-ifc `FlatMesh`
 * path that lived here was removed — geometry streams through the
 * pre-pass + job-batch path now.)
 */
export enum GeometryQuality {
  Fast = 'fast',       // Skip small objects, simplified geometry
  Balanced = 'balanced', // Default - all geometry
  High = 'high'        // Full quality + mesh repair
}
