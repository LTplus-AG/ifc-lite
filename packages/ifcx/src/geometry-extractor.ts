/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry Extractor for IFCX
 * Extracts USD-style mesh data and converts to MeshData format
 *
 * COORDINATE SYSTEM:
 * - IFCX uses Z-up (following IFC/buildingSMART convention)
 * - The ifc-lite viewer uses Y-up (standard WebGL convention)
 * - This extractor converts from Z-up to Y-up after applying transforms
 */

import type { ComposedNode } from './types.js';
import type { IfcxPixels } from './appearance-wire.js';
import { executeImportedGraph } from './imported-graph.js';

export interface MeshData {
  expressId: number;
  ifcType?: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
  uvs?: Float32Array;
  texture?: IfcxPixels;
}

/** Synchronous no-setup adapter; Rust owns geometry planning and execution. */
export function extractGeometry(composed: Map<string, ComposedNode>, pathToId: Map<string, number>): MeshData[] {
  return executeImportedGraph(composed, pathToId, 1).meshes;
}
