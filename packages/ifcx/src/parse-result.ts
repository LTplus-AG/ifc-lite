/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StringTable, SpatialHierarchy, EntityTable, PropertyTable, QuantityTable, RelationshipGraph } from '@ifc-lite/data';
import type { MeshData } from './geometry-extractor.js';
import type { PointCloudExtraction } from './pointcloud-extractor.js';
import type { extractGeoreference } from './georeference.js';

/**
 * Result of parsing an IFCX file.
 * Compatible with existing ifc-lite data structures.
 */
export interface IfcxParseResult {
  /** Columnar entity table */
  entities: EntityTable;
  /** Columnar property table */
  properties: PropertyTable;
  /** Columnar quantity table */
  quantities: QuantityTable;
  /** Relationship graph */
  relationships: RelationshipGraph;
  /** Spatial hierarchy */
  spatialHierarchy: SpatialHierarchy;
  /** String table for interned strings */
  strings: StringTable;
  /** Pre-tessellated geometry meshes */
  meshes: MeshData[];
  /** Decoded point clouds (pcd::base64, points::array, points::base64) */
  pointClouds: PointCloudExtraction[];
  /** Mapping from IFCX path to express ID */
  pathToId: Map<string, number>;
  /** Mapping from express ID to IFCX path */
  idToPath: Map<number, string>;
  /** Schema version */
  schemaVersion: 'IFC5';
  /** File size in bytes */
  fileSize: number;
  /** Number of entities */
  entityCount: number;
  /** Parse time in milliseconds */
  parseTime: number;
  /** Canonical IFC EXPRESS attributes carried by the IFCX georeference extension. */
  georeferencing?: ReturnType<typeof extractGeoreference>;
}

export interface IfcxParseOptions {
  /** Progress callback */
  onProgress?: (progress: { phase: string; percent: number }) => void;
}

