/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Ambient stubs for names in doc snippets that are NOT part of the
 * @ifc-lite surface under test (see check-doc-samples.mjs):
 *   - third-party modules the tutorials import (three, babylon, vite)
 *   - their symbols carried into a later snippet without a re-import
 *   - reader-supplied glue (`saveFile`, UI helpers)
 *   - placeholder types defined in an earlier tutorial fence
 *
 * Widening these to `any` is safe: they are the reader's own code, not
 * the ifc-lite API, so nothing here weakens the check. This file must
 * stay a SCRIPT (no import/export) — `declare module` only registers
 * ambiently from a non-module file. Real @ifc-lite globals with real
 * types live in doc-samples-globals.d.ts instead.
 */

// Third-party modules (not installed in the docs typecheck lane).
// `three` needs its accessed members declared as both a value and a type so
// the tutorials' `THREE.Mesh`-style type annotations resolve; babylon and
// vite are only imported for values, so an empty (any) module suffices.
declare module 'three' {
  export const BufferAttribute: any;
  export type BufferAttribute = any;
  export const BufferGeometry: any;
  export type BufferGeometry = any;
  export const Color: any;
  export type Color = any;
  export const DoubleSide: any;
  export type DoubleSide = any;
  export const InstancedMesh: any;
  export type InstancedMesh = any;
  export const Mesh: any;
  export type Mesh = any;
  export const MeshStandardMaterial: any;
  export type MeshStandardMaterial = any;
  export const Raycaster: any;
  export type Raycaster = any;
  export const Vector2: any;
  export type Vector2 = any;
  export const Vector3: any;
  export type Vector3 = any;
}
declare module '@babylonjs/core';
declare module 'vite';
declare module 'yjs';
// Reader-project JSON imports (e.g. `import pkg from './package.json'`
// inside a vite.config.ts example) — the file exists only in the reader's
// project, not in the typecheck temp dir.
declare module '*.json' {
  const value: any;
  export default value;
}

// `THREE.X` used (as a value or a type) in a snippet that does not
// `import * as THREE from 'three'`. A namespace carries both meanings.
declare namespace THREE {
  const BufferAttribute: any;
  type BufferAttribute = any;
  const BufferGeometry: any;
  type BufferGeometry = any;
  const Color: any;
  type Color = any;
  const DoubleSide: any;
  type DoubleSide = any;
  const InstancedMesh: any;
  type InstancedMesh = any;
  const Mesh: any;
  type Mesh = any;
  const MeshStandardMaterial: any;
  type MeshStandardMaterial = any;
  const Raycaster: any;
  type Raycaster = any;
  const Vector2: any;
  type Vector2 = any;
  const Vector3: any;
  type Vector3 = any;
}

// three / babylon symbols carried into a continuation snippet.
declare const Mesh: any;
type Mesh = any;
declare const Scene: any;
type Scene = any;
declare const Vector3: any;
type Vector3 = any;
declare const Color3: any;
type Color3 = any;
declare const StandardMaterial: any;
type StandardMaterial = any;
declare const VertexData: any;
type VertexData = any;
declare const Engine: any;
type Engine = any;
declare const ArcRotateCamera: any;
type ArcRotateCamera = any;
declare const scene: any;
declare const camera: any;
declare const raycaster: any;
declare const pointer: any;
declare const viewer: any;
declare const geometry: any;
declare const triangleMaps: any;

// Reader-supplied glue: download + UI helpers, mesh converters.
declare function saveFile(
  filename: string,
  data: Uint8Array | Blob | string | null | undefined,
): void;
declare function setupCameraControls(...args: any[]): any;
declare function displayProperties(...args: any[]): any;
declare function updateProgressUI(...args: any[]): any;
declare function showPropertiesPanel(...args: any[]): any;
declare function highlightTreeRow(...args: any[]): any;
declare function expandTreeNode(...args: any[]): any;
declare function applyHighlight(...args: any[]): any;
declare function pickAt(...args: any[]): any;
declare function transformMesh(...args: any[]): any;
declare function meshDataToThree(...args: any[]): any;
declare function meshDataToBabylon(...args: any[]): any;
declare function decodeDoor(...args: any[]): any;
declare const progressBar: any;

// More reader-supplied UI glue (guides): fallback screens, snap markers,
// DOM controls, and raw WebGPU handles (GPU* types are not in our libs;
// these are browser objects, not ifc-lite API surface).
declare function showFallbackUI(...args: any[]): any;
declare function initializeViewer(...args: any[]): any;
declare function drawSnapIndicator(...args: any[]): any;
declare function showSnapIndicator(...args: any[]): any;
declare function upload(...args: any[]): any;
declare const slider: any;
declare const axisButtons: any[];
declare const flipBtn: any;
declare const device: any;
declare const gpuDevice: any;

// Placeholder types/classes defined in an earlier tutorial fence.
type CustomDoorData = any;
type IfcLitePlugin = any;
type PluginContext = any;
declare const AnalyticsPlugin: any;
