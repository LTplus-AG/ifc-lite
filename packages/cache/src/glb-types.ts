/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Minimal glTF type definitions for parsing
export interface GLTFDocument {
  asset: { version: string; generator?: string };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GLTFNode[];
  meshes?: GLTFMesh[];
  materials?: GLTFMaterial[];
  accessors?: GLTFAccessor[];
  bufferViews?: GLTFBufferView[];
  buffers?: GLTFBuffer[];
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>;
  textures?: Array<{ source?: number; sampler?: number }>;
  samplers?: Array<{ wrapS?: number; wrapT?: number }>;
}

export interface GLTFNode {
  mesh?: number;
  name?: string;
  extras?: { expressId?: number };
  children?: number[];
  /** Node-local translation (xyz). The from-meshes exporter places all geometry
   *  under a single translated root node, so this is composed down the hierarchy. */
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
  /** Node-local column-major 4x4 (glTF convention). The from-bytes instanced
   *  exporter places each shared-template occurrence with a node MATRIX (rotation +
   *  translation); mutually exclusive with `translation` per the glTF spec. */
  matrix?: number[];
}

export interface GLTFMesh {
  primitives: GLTFPrimitive[];
  name?: string;
}

export interface GLTFPrimitive {
  attributes: {
    POSITION: number;
    NORMAL?: number;
    TEXCOORD_0?: number;
    [name: string]: number | undefined;
  };
  targets?: unknown[];
  extensions?: Record<string, unknown>;
  indices?: number;
  mode?: number;
  material?: number;
}

export interface GLTFMaterial {
  pbrMetallicRoughness?: {
    baseColorTexture?: { index: number; texCoord?: number; extensions?: { KHR_texture_transform?: { offset?: number[]; scale?: number[]; rotation?: number; texCoord?: number } } };
    metallicRoughnessTexture?: unknown;
    baseColorFactor?: [number, number, number, number] | number[];
  };
  normalTexture?: unknown;
  emissiveTexture?: unknown;
  occlusionTexture?: unknown;
  extensions?: Record<string, unknown>;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
}

export interface GLTFAccessor {
  sparse?: unknown;
  normalized?: boolean;
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
  min?: number[];
  max?: number[];
}

export interface GLTFBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

export interface GLTFBuffer {
  byteLength: number;
  uri?: string;
}

