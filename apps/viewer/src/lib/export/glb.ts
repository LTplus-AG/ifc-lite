/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GLB export helper — assembles the binary in Rust (`ifc-lite-export`) over the
 * meshes the viewer already holds, with no re-meshing. Replaces the per-call-site
 * `new GLTFExporter(...).exportGLB(...)` usage.
 */

import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';

export interface GlbFromGeometryOptions {
  includeMetadata?: boolean;
  /** Pre-filtered meshes to emit (visibility/colour selection already applied). */
  meshes?: MeshData[];
  /**
   * Emit standard (lit) PBR materials so external viewers shade the model from
   * its normals. `false` ⇒ flat `KHR_materials_unlit` (the historical look —
   * apparent base colour only, no shading). Defaults to lit. (#1321)
   */
  lit?: boolean;
  /**
   * Self-illuminate each material at its base colour (core glTF `emissiveFactor`).
   * Targets renderers with no ambient/IBL and a single hard sun — Google Earth,
   * which otherwise lit IFC models so dark that shadow-side faces went black
   * (#1427). The base colour is kept, so this never darkens a viewer that ignores
   * emissive. Defaults to off. Mutually exclusive in spirit with unlit, so don't
   * pair with `lit: false` (the unlit spec mandates `emissiveFactor = 0`).
   */
  emissive?: boolean;
}

/** The slice of `GeometryProcessor` this helper drives — a test seam (see glb.test.ts). */
export type GlbProcessor = Pick<GeometryProcessor, 'init' | 'exportGlbFromMeshes' | 'dispose'>;

/**
 * Build a GLB from a `GeometryResult` (or a pre-filtered mesh list) via the Rust
 * from-meshes assembler. Per-element RTC origin rides a glTF node translation.
 *
 * `createProcessor` defaults to the real wasm processor; tests inject a stub.
 */
export async function exportGlbFromGeometry(
  geometryResult: GeometryResult,
  opts: GlbFromGeometryOptions = {},
  createProcessor: () => GlbProcessor = () => new GeometryProcessor(),
): Promise<Uint8Array> {
  const meshes = opts.meshes ?? (geometryResult.meshes as MeshData[]);
  const gp = createProcessor();
  await gp.init();
  try {
    const glb = gp.exportGlbFromMeshes(meshes, opts.includeMetadata ?? false, opts.lit ?? true, opts.emissive ?? false);
    if (!glb) throw new Error('GLB assembly returned no data');
    return glb;
  } finally {
    gp.dispose();
  }
}
