/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The site-context GLB format, shared by the encoder and the decoder.
 *
 * Axes. glTF is Y-up. The site frame (x east, y north, z up) maps to glTF as
 * `(x, y, z)_gltf = (east, up, −north)`, the same Z-up → Y-up turn the
 * viewer applies to IFC. Negation is exact, so the mapping loses nothing.
 *
 * Precision. A feature node's `translation` is (feature origin − document
 * origin) in glTF axes. Both origins are f64; their difference is exact
 * (Sterbenz: the two values are within a factor of two of each other), and
 * JSON numbers are written by `JSON.stringify`, whose shortest round-trip
 * form parses back to the identical double. The absolute feature origin is
 * also stored in the node's `extras.origin`, so a reader that wants it does
 * not have to add anything.
 */

import type { Attribution } from '@ifc-lite/geodata-ch';
import type { JsonValue, SiteContextIssue, SiteContextLayerKind, SiteContextOriginHeight } from './types.js';

export const SITE_CONTEXT_FORMAT_VERSION = 1;
export const EXTRAS_KEY = 'ifcLiteSiteContext';

export const GLB_MAGIC = 0x46546c67;
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

export const FLOAT = 5126;
export const UNSIGNED_INT = 5125;
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

export const AXES_DESCRIPTION = 'site frame x=east y=north z=up (metres); glTF (x, y, z) = (east, up, -north)';

export interface SiteContextGlbLayerMeta {
  kind: SiteContextLayerKind;
  attribution: Attribution[];
  issues: SiteContextIssue[];
  complete: boolean;
  /** Index of the layer's group node; its children are the feature nodes. */
  node: number;
  /** The layer's provenance, when it has one (format 1 files from before it was added have none). */
  provenance?: { [key: string]: JsonValue };
}

/** `asset.extras.ifcLiteSiteContext`. */
export interface SiteContextGlbMeta {
  formatVersion: number;
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  origin: [number, number, number];
  /** What H0 is (optional in format 1: absent in files written before it existed). */
  originHeight?: SiteContextOriginHeight;
  axes: string;
  layers: SiteContextGlbLayerMeta[];
}

/** A feature node's `extras`. */
export interface SiteContextGlbNodeExtras {
  id: string;
  ifcType: string;
  name: string;
  origin: [number, number, number];
  attributes: { [key: string]: JsonValue };
  provenance: { [key: string]: JsonValue };
  /** Present (and `true`) only on the subject building. */
  subject?: true;
}

/** A mesh's `extras.ifcLiteSiteContext`: named index ranges of its one primitive (see `SiteContextMesh.parts`). */
export interface SiteContextGlbMeshExtras {
  parts: Array<{ name: string; firstIndex: number; indexCount: number }>;
}

export interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3';
  min?: number[];
  max?: number[];
}

export interface GltfPrimitive {
  attributes: { POSITION: number; NORMAL: number; TEXCOORD_0?: number };
  indices: number;
  material: number;
  mode?: number;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  translation?: [number, number, number];
  extras?: { [key: string]: unknown };
}

export interface GltfJson {
  asset: { version: string; generator?: string; extras?: { [EXTRAS_KEY]?: SiteContextGlbMeta } };
  scene?: number;
  scenes?: Array<{ name?: string; nodes: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[]; extras?: { [EXTRAS_KEY]?: SiteContextGlbMeshExtras } }>;
  materials?: unknown[];
  accessors?: GltfAccessor[];
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; target?: number }>;
  buffers?: Array<{ byteLength: number }>;
  /** Extensions a reader must understand; this reader understands none. */
  extensionsRequired?: string[];
}

/** Plain colours so the file reads in any glTF viewer. */
export const LAYER_MATERIALS: Record<SiteContextLayerKind, { name: string; color: [number, number, number, number]; doubleSided: boolean }> = {
  terrain: { name: 'site-context terrain', color: [0.62, 0.6, 0.52, 1], doubleSided: false },
  parcel: { name: 'site-context parcel', color: [0.85, 0.16, 0.1, 1], doubleSided: true },
  // Single-sided: the buildings layer makes winding consistent and outward.
  buildings: { name: 'site-context buildings', color: [0.8, 0.8, 0.8, 1], doubleSided: false },
};
