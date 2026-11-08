/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAPI } from '@ifc-lite/wasm';

export const RHINO_UNITS = ['source', 'meters', 'millimeters', 'centimeters', 'feet', 'inches'] as const;
export const RHINO_COORDINATES = ['local', 'world'] as const;
export const RHINO_LAYER_SCHEMES = ['spatial-class', 'class', 'presentation'] as const;
export const RHINO_PROPERTIES = ['all', 'attributes', 'none'] as const;

/** Options for the shared Rust Rhino scene builder. All fields use Rust defaults when omitted. */
export interface RhinoSceneExportOptions {
  units?: (typeof RHINO_UNITS)[number];
  coordinates?: (typeof RHINO_COORDINATES)[number];
  layerScheme?: (typeof RHINO_LAYER_SCHEMES)[number];
  instancing?: boolean;
  properties?: (typeof RHINO_PROPERTIES)[number];
  includeSpaces?: boolean;
  normals?: boolean;
  layerSlicing?: boolean;
  hidden?: number[];
  isolated?: number[] | null;
  hiddenTypes?: string[];
}

/** Defaults for the shared Rust scene builder. */
export const RHINO_SCENE_DEFAULTS: Required<RhinoSceneExportOptions> = {
  units: 'source',
  layerScheme: 'spatial-class',
  instancing: true,
  properties: 'all',
  includeSpaces: true,
  coordinates: 'local',
  normals: true,
  layerSlicing: false,
  hidden: [],
  isolated: null,
  hiddenTypes: [],
};

/** The encoded scene `@ifc-lite/rhino3dm` writes: manifest JSON and its binary blob. */
export interface RhinoSceneBuffers { manifest: string; blob: Uint8Array }

/** Run wasm `exportRhinoScene`, copy both results out and free the handle. The bridge runs it
 * through its export runner, so `NO_RENDER_GEOMETRY` surfaces like `exportUsd`'s. */
export function callExportRhinoScene(api: IfcAPI, content: Uint8Array, options: RhinoSceneExportOptions): RhinoSceneBuffers {
  const scene = api.exportRhinoScene(content, JSON.stringify(options));
  try { return { manifest: scene.manifest, blob: scene.blob }; } finally { scene.free(); }
}
