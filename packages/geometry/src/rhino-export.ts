/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { initWasmWithRetry } from './wasm-init-retry.js';
import { readNodeWasmBytes } from './node-wasm-bytes.js';

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

type RhinoEngine = typeof import('@ifc-lite/wasm/rhino');
let engine: Promise<RhinoEngine> | null = null;

/** Import and initialize the separate Rhino wasm (`@ifc-lite/wasm/rhino`) once.
 * It is never part of the default engine, so nothing is fetched until the
 * first .3dm export. A failed load is not cached, so a later export retries. */
function loadRhinoEngine(): Promise<RhinoEngine> {
  engine ??= (async () => {
    const module = await import('@ifc-lite/wasm/rhino');
    const bytes = await readNodeWasmBytes('@ifc-lite/wasm/rhino_bg.wasm');
    await initWasmWithRetry(async () => { await module.default(bytes ? { module_or_path: bytes } : undefined); }, { label: 'rhino-export' });
    return module;
  })();
  engine.catch(() => { engine = null; });
  return engine;
}

/** Build the encoded Rhino scene for `content` with the shared Rust scene builder.
 * Copies both results out and frees the wasm handle. A model with no render
 * geometry rejects with `NO_RENDER_GEOMETRY`, as `exportUsd` throws. */
export async function exportRhinoScene(content: Uint8Array, options: RhinoSceneExportOptions = {}): Promise<RhinoSceneBuffers> {
  const scene = (await loadRhinoEngine()).exportRhinoScene(content, JSON.stringify(options));
  try { return { manifest: scene.manifest, blob: scene.blob }; } finally { scene.free(); }
}
