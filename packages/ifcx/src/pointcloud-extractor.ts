/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud extractor for IFCX.
 *
 * Reads the three buildingSMART point cloud schemas:
 *   - `pcd::base64`     — full PCD file embedded as base64
 *   - `points::array`   — inline JSON arrays of [x,y,z] (and optional rgb)
 *   - `points::base64`  — base64-Float32 buffers
 *
 * Coordinates: positions are extracted in IFCx-native Z-up space, with any
 * `usd::xformop` lineage transform applied. The extractor swaps Y/Z to
 * match the viewer's Y-up convention — same convention as the mesh
 * extractor (see geometry-extractor.ts).
 */

import type { ComposedNode } from './types.js';
import { executeImportedGraph } from './imported-graph.js';

export interface PointCloudExtraction {
  expressId: number;
  ifcType?: string;
  positions: Float32Array;
  colors?: Float32Array;
  pointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/** Synchronous no-setup adapter; point codecs retain their existing authority. */
export function extractPointClouds(composed: Map<string, ComposedNode>, pathToId: Map<string, number>): PointCloudExtraction[] {
  return executeImportedGraph(composed, pathToId, 2).pointClouds;
}
