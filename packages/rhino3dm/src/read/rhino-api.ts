/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Rhino } from '../runtime.js';
import type { RhinoUserStrings } from '../types.js';

/**
 * The part of rhino3dm.js 8.35.0 the reader calls, as it behaves at runtime.
 * Upstream's .d.ts is wrong or silent on most of it: enums are objects with a
 * numeric `value`, `getUserStrings` returns pairs, `subdivide` and
 * `createFromSubDControlNet` take arguments, and `fromByteArray` returns null.
 */
export interface EnumValue { value: number }
export interface Rgba8 { r: number; g: number; b: number; a: number }
type Class<T> = abstract new (...args: never[]) => T;
interface Table<T> { count: number; get(index: number): T }
interface WithUserStrings { getUserStrings(): RhinoUserStrings }

export interface RMesh {
  vertices(): { count: number; point3dAt(index: number): number[] };
  translate(vector: number[]): boolean;
  toThreejsBuffers(rotateToYUp: boolean): { position: Float32Array; normal: Float32Array; index: Uint32Array };
}
export interface RBrep { faces(): Table<{ getMesh(type: EnumValue): RMesh | null }> }
export interface RExtrusion { getMesh(type: EnumValue): RMesh | null }
export interface RSubD { subdivide(levels: number): boolean }
export interface RPointCloud { count: number; containsColors: boolean; getPoints(): number[][]; getColors(): Rgba8[] }
export interface RTextDot { point: number[]; text: string }
export interface RCurve {
  domain: number[]; spanCount: number; isClosed: boolean;
  pointAt(t: number): number[];
  tryGetPolyline(): Table<number[]> | null;
}
export interface RInstanceReference { parentIdefId: string; xform: Record<string, number> }

export interface RAttributes extends WithUserStrings {
  id: string; name: string; layerIndex: number; visible: boolean; isInstanceDefinitionObject: boolean;
  mode: EnumValue; colorSource: EnumValue; objectColor: Rgba8;
  materialSource: EnumValue; materialIndex: number;
  getGroupList(): number[];
}
export interface RLayer extends WithUserStrings {
  // No `fullPath`: the reader builds each path from the parent it settled on, because the native
  // property follows `ParentId` with no visited set. See `orderLayers`.
  name: string; id: string; parentLayerId: string;
  color: Rgba8; visible: boolean; renderMaterialIndex: number;
}
export interface RAnchor {
  earthBasepointLatitude: number; earthBasepointLongitude: number; earthBasepointElevation: number;
  modelBasePoint: number[];
  earthLocationIsSet(): boolean;
}
export interface RFile {
  applicationName: string;
  settings(): { modelUnitSystem: EnumValue; earthAnchorPoint: RAnchor };
  strings(): Table<[string, string]>;
  layers(): Table<RLayer>;
  materials(): Table<{ name: string; diffuseColor: Rgba8; transparency: number }>;
  groups(): Table<{ name: string }>;
  instanceDefinitions(): Table<{ id: string; name: string; updateType: EnumValue; getObjectIds(): string[] }>;
  objects(): Table<{ attributes(): RAttributes; geometry(): object }>;
}

export interface ReadApi {
  File3dm: { fromByteArray(bytes: Uint8Array): RFile | null };
  Mesh: (new () => RMesh) & { createFromSubDControlNet(subd: RSubD, includeTextureCoordinates: boolean): RMesh | null };
  Brep: Class<RBrep>; Extrusion: Class<RExtrusion>; SubD: Class<RSubD>;
  PointCloud: Class<RPointCloud>; TextDot: Class<RTextDot>; Curve: Class<RCurve>;
  InstanceReference: Class<RInstanceReference>;
  UnitSystem: Record<string, EnumValue | undefined>;
  MeshType: { Any: EnumValue };
  ObjectMode: { Hidden: EnumValue };
  ObjectColorSource: Record<'ColorFromLayer' | 'ColorFromObject' | 'ColorFromMaterial' | 'ColorFromParent', EnumValue>;
  ObjectMaterialSource: Record<'MaterialFromLayer' | 'MaterialFromObject' | 'MaterialFromParent', EnumValue>;
  InstanceDefinitionUpdateType: Record<'Linked' | 'LinkedAndEmbedded', EnumValue>;
}

export function readApi(rhino: Rhino): ReadApi {
  return rhino as unknown as ReadApi;
}
