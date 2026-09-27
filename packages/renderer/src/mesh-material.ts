/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The material row of the main mesh uniform (#5386): `metallicRoughness`
 * and `transmission`, right after `baseColor`. The fragment stage's specular
 * term (`shaders/specular.wgsl.ts`) reads it.
 *
 * No IFC finish reaches the renderer yet (IfcSurfaceStyleRendering's specular
 * fields are not extracted), so a draw's material is derived here: a caller's
 * `Mesh.material` if it supplies one, else a matte dielectric, or glass when
 * the AUTHORED colour is translucent.
 *
 * Authored, not drawn: X-Ray and compare fade an opaque element by lowering
 * the alpha the draw carries (`baseColor.a`), and a fade must not turn a wall
 * into a pane of glass. Only the colour the geometry was authored with says
 * what the surface is, so every writer passes that alpha here.
 */

import { MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import { OPAQUE_ALPHA_CUTOFF } from './overlay-routing.js';
import type { Material } from './types.js';

/** A dielectric: plaster, concrete, masonry, timber, paint. */
export const DEFAULT_MATERIAL_METALLIC = 0;

/**
 * Matte. Building finishes are mostly rough, and at this roughness the sun's
 * highlight on a dielectric is a broad, faint sheen that leaves a white wall
 * as it was (`mesh-material.test.ts` pins that). At the 0.6 this lane used to
 * hold, the highlight washed a whitish film over every sunlit coloured roof.
 */
export const DEFAULT_MATERIAL_ROUGHNESS = 0.9;

/**
 * Glass. Architectural glass is optically smooth, so it mirrors the sky at
 * grazing angles and shows a tight sun glint; that reflection is what makes a
 * pane read as glass.
 */
export const GLASS_ROUGHNESS = 0.05;

/**
 * Write a draw's material into the mesh uniform's material row: metallic,
 * roughness, transmission (1 = drawn as glass) and padding.
 *
 * @param authoredAlpha The alpha of the colour the geometry was authored
 *   with, before any X-Ray or compare fade. Defaults to opaque.
 * @param material A caller-supplied finish; its fields win over the defaults.
 */
export function packMeshMaterial(
  out: Float32Array,
  authoredAlpha = 1,
  material?: Partial<Pick<Material, 'metallic' | 'roughness'>>,
): void {
  const glass = authoredAlpha < OPAQUE_ALPHA_CUTOFF;
  const at = MESH_UNIFORM_OFFSET.metallicRoughness;
  out[at] = material?.metallic ?? DEFAULT_MATERIAL_METALLIC;
  out[at + 1] = material?.roughness ?? (glass ? GLASS_ROUGHNESS : DEFAULT_MATERIAL_ROUGHNESS);
  out[at + 2] = glass ? 1 : 0;
  out[at + 3] = 0;
}
