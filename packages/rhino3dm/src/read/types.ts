/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoColor, RhinoUserStrings, RhinoVector3, Write3dmOptions } from '../types.js';

/** sRGB colour with alpha, each 0..1, as the viewer's `MeshData.color`. */
export type RhinoRgba = [number, number, number, number];

export type RhinoReadErrorCode = 'not-3dm' | 'newer-archive' | 'too-large' | 'no-renderable-geometry';

/** Thrown by `readRhino3dm`. The message is user-facing and says what to do. */
export class RhinoReadError extends Error {
  readonly code: RhinoReadErrorCode;
  constructor(code: RhinoReadErrorCode, message: string) {
    super(message);
    this.name = 'RhinoReadError';
    this.code = code;
  }
}

export interface ReadRhino3dmOptions {
  /** Used on first initialization only; reads and writes share one runtime. */
  locateFile?: Write3dmOptions['locateFile'];
  /** SubD refinement level, each level quadruples the control net. Default 2. */
  subdLevel?: 0 | 1 | 2 | 3;
  /**
   * Drawing budget in triangles, a block's counted once per placement. A vertex counts a
   * third of one, and a mesh at least its triangles. Default 30,000,000.
   */
  maxTriangles?: number;
  /** Bake block instances into `meshes` for callers that cannot instance. Default false. */
  bakeInstances?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface RhinoImportDocument {
  /** 50, 60, 70, 80. */
  archiveVersion: number;
  /** "Rhinoceros 8"; empty for files written by ifc-lite or openNURBS. */
  application: string;
  unitSystem: string;
  metersPerUnit: number;
  /** `ifc-lite` when the `IFC::Exporter` document string starts with "ifc-lite". */
  provenance: 'ifc-lite' | 'rhino';
  /** `ifc-world-from-model` when `IFC::WorldFromModel` was applied to every coordinate. */
  frame: 'ifc-world-from-model' | 'file';
  /** Null when unset, and for Rhino 8's default 0/0 anchor. `modelBasePoint` is in the result's frame, metres. */
  earthAnchor: null | { latitude: number; longitude: number; elevation: number; modelBasePoint: RhinoVector3 };
  /** Document strings and document user text, in file order. */
  strings: RhinoUserStrings;
}

export interface RhinoImportLayer {
  name: string;
  /** `A::B::C`. */
  fullPath: string;
  /** Index of the parent layer, always smaller than this layer's own index. */
  parent: number | null;
  color: RhinoColor;
  /** The layer's own flag; `entities[i].hidden` already folds in the ancestors. */
  visible: boolean;
  userStrings: RhinoUserStrings;
  /** The IFC spatial element this layer stands for, from its `IFC::GlobalId` and `IFC::Class` stamps. */
  spatial: null | { globalId: string; ifcClass: string; elevation: number | null };
}

export interface RhinoImportPropertySet { name: string; properties: [string, string][] }

export interface RhinoImportEntity {
  /** Always a valid 22-character IFC GUID, unique within the file. */
  globalId: string;
  /** `IFC::Class` when it names an instantiable IFC product class, else `IfcBuildingElementProxy`. */
  ifcClass: string;
  name: string;
  description: string;
  objectType: string;
  layer: number;
  /** Object hidden, or any layer on its path off; for merged objects, true only when every one is. Each geometry record carries its own. */
  hidden: boolean;
  /** Rhino object UUIDs merged into this entity. */
  objectIds: string[];
  /** Rhino geometry class of the first object: "Mesh", "Brep", "InstanceReference", "NurbsCurve", ... */
  geometryType: string;
  /** Attribute User Text of the first object, verbatim, in file order, then what the objects merged into it add. */
  userStrings: RhinoUserStrings;
  /** The same user text sorted into property sets, plus the `Rhino` set. All values are strings. */
  propertySets: RhinoImportPropertySet[];
}

/** Triangles relative to a double-precision origin: world position = `origin + positions`. */
export interface RhinoImportGeometry {
  /** Metres, Z-up. */
  origin: RhinoVector3;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface RhinoImportMesh extends RhinoImportGeometry {
  entity: number;
  color: RhinoRgba;
  /** Its own object's flag, as `RhinoImportEntity.hidden`; differs from the entity's only in a merged entity. */
  hidden: boolean;
}

/** One block's own meshes, in block space. Nested blocks are flattened into `instances`. */
export interface RhinoImportDefinition {
  name: string;
  /** `color` is null when the mesh takes the colour of the instance that places it. */
  meshes: (RhinoImportGeometry & { color: RhinoRgba | null })[];
}

export interface RhinoImportInstance {
  entity: number;
  definition: number;
  /** 16 row-major numbers, metres: world = transform · (origin + position). */
  transform: number[];
  color: RhinoRgba;
  /** Its own object's flag, as `RhinoImportEntity.hidden`; differs from the entity's only in a merged entity. */
  hidden: boolean;
}

export interface RhinoImportPointCloud {
  entity: number;
  origin: RhinoVector3;
  positions: Float32Array;
  /** RGBA bytes per point, or null when the cloud has no colours. */
  colors: Uint8Array | null;
  color: RhinoRgba;
  /** Its own object's flag, as `RhinoImportEntity.hidden`; differs from the entity's only in a merged entity. */
  hidden: boolean;
}

/** A polyline. Curves that are not polylines are sampled. A closed curve ends on its first point. */
export interface RhinoImportCurve {
  entity: number;
  origin: RhinoVector3;
  positions: Float32Array;
  closed: boolean;
  color: RhinoRgba;
  /** Its own object's flag, as `RhinoImportEntity.hidden`; differs from the entity's only in a merged entity. */
  hidden: boolean;
}

export interface RhinoImportTextDot {
  entity: number;
  position: RhinoVector3;
  text: string;
  color: RhinoRgba;
  /** Its own object's flag, as `RhinoImportEntity.hidden`; differs from the entity's only in a merged entity. */
  hidden: boolean;
}

/**
 * A .3dm as plain data: Z-up, metres, typed arrays. Guarantees: every index is
 * in range, layers come parent first, every number is finite, each `globalId`
 * is unique, entities are in file object order, and every geometry list is
 * ordered by entity.
 */
export interface RhinoImport {
  format: 'ifc-lite.rhino-import';
  version: 1;
  document: RhinoImportDocument;
  layers: RhinoImportLayer[];
  entities: RhinoImportEntity[];
  meshes: RhinoImportMesh[];
  /** Empty under `bakeInstances`. */
  definitions: RhinoImportDefinition[];
  /** Empty under `bakeInstances`. */
  instances: RhinoImportInstance[];
  pointClouds: RhinoImportPointCloud[];
  curves: RhinoImportCurve[];
  /** At most 100,000; the rest are counted in `skipped` as `TextDot:limit`. */
  textDots: RhinoImportTextDot[];
  /** Counts by reason: `"Point": 8`, `"Brep:no-render-mesh": 3`. */
  skipped: Record<string, number>;
  /** One line per distinct condition. */
  warnings: string[];
}
