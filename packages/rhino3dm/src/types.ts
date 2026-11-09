/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type RhinoVector3 = [number, number, number];
export type RhinoColor = [number, number, number, number];
export type RhinoUserStrings = [string, string][];
export interface EncodedRhinoScene { manifest: string; blob: Uint8Array }
export const RHINO_3DM_VERSIONS = [8, 7] as const;
export type Rhino3dmVersion = (typeof RHINO_3DM_VERSIONS)[number];
export interface Write3dmResult { bytes: Uint8Array; warnings: string[]; objectCount: number }
export interface Write3dmOptions {
  version?: Rhino3dmVersion;
  onProgress?: (done: number, total: number) => void;
  /** Used on first initialization only; concurrent and later writes share the runtime. */
  locateFile?: (path: string, prefix: string) => string;
}
export interface RhinoBufferRef { offset: number; count: number }
export interface RhinoMesh {
  positions: RhinoBufferRef;
  normals: RhinoBufferRef | null;
  indices: RhinoBufferRef;
}
export interface RhinoEarthAnchor {
  latitude: number; longitude: number; elevation: number;
  modelBasePoint: RhinoVector3; modelNorth: RhinoVector3; modelEast: RhinoVector3;
  name: string;
}
export interface RhinoSettings {
  unitSystem: 'Millimeters' | 'Centimeters' | 'Meters' | 'Feet' | 'Inches';
  metersPerUnit: number; absoluteTolerance: number; angleToleranceDegrees: number;
  earthAnchor: RhinoEarthAnchor | null;
}
export interface RhinoLayer {
  name: string; parent: number | null; color: RhinoColor; visible: boolean; locked: boolean;
}
export interface RhinoMaterial { name: string; diffuse: RhinoVector3; transparency: number }
export interface RhinoGroup { name: string }
export interface RhinoBlock { name: string; description: string; meshes: number[]; layer: number }
export interface RhinoObjectAttributes {
  layer: number; name: string; objectId: string; color: RhinoColor;
  material: number; groups: number[]; userStrings: RhinoUserStrings;
}
export type RhinoObject = RhinoObjectAttributes & (
  { kind: 'mesh'; mesh: number } | { kind: 'instance'; block: number; xform: number[] }
);
export interface RhinoSceneManifest {
  format: 'ifc-lite.rhino-scene'; version: 1;
  settings: RhinoSettings; warnings: string[]; documentStrings: RhinoUserStrings;
  layers: RhinoLayer[]; materials: RhinoMaterial[]; groups: RhinoGroup[];
  meshes: RhinoMesh[]; blocks: RhinoBlock[]; objects: RhinoObject[];
}
