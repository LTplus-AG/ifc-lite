/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoColor } from '../types.js';
import type { RAttributes, ReadApi } from './rhino-api.js';
import type { RhinoRgba } from './types.js';

/** How an object says it wants to be coloured, before layers and parents are consulted. */
export interface Look {
  colorSource: 'layer' | 'object' | 'material' | 'parent';
  color: RhinoColor;
  materialSource: 'layer' | 'object' | 'parent';
  material: number;
  /** Index into the output layers. */
  layer: number;
}

/** A resolved colour and the material index it came with, which children may inherit. */
export interface Appearance { color: RhinoRgba; material: number }

export interface AppearanceTables {
  layers: { color: RhinoColor; material: number }[];
  materials: { diffuse: RhinoColor; transparency: number }[];
}

const BLACK: RhinoColor = [0, 0, 0, 255];
const rgba = ([r, g, b, a]: RhinoColor): RhinoRgba => [r / 255, g / 255, b / 255, a / 255];

export function readLook(api: ReadApi, attributes: RAttributes, layer: number): Look {
  const color = attributes.colorSource.value, material = attributes.materialSource.value;
  const c = attributes.objectColor;
  return {
    colorSource: color === api.ObjectColorSource.ColorFromObject.value ? 'object'
      : color === api.ObjectColorSource.ColorFromMaterial.value ? 'material'
      : color === api.ObjectColorSource.ColorFromParent.value ? 'parent' : 'layer',
    color: [c.r, c.g, c.b, c.a],
    materialSource: material === api.ObjectMaterialSource.MaterialFromObject.value ? 'object'
      : material === api.ObjectMaterialSource.MaterialFromParent.value ? 'parent' : 'layer',
    material: attributes.materialIndex,
    layer,
  };
}

/**
 * Resolve an object's colour and the material it is drawn with. `parent` is the block instance
 * placing it, or null at top level, where every "from parent" source falls back to the layer.
 *
 * This follows `ON_3dmObjectAttributes::ApplyParentalControl` (openNURBS 8.x): a "by parent"
 * material is *overwritten* with the instance's, which leaves the member indistinguishable from
 * one that owned that material. So an inherited material decides the member's colour under
 * `ColorFromMaterial` and its transparency under every source, exactly as its own would. A "by
 * parent" colour takes the instance's resolved colour. Every other source reads the member's own
 * attributes, its own layer included: openNURBS never changes a member's layer index.
 *
 * A material's transparency overrides an opaque colour, because Rhino shows transparency from the
 * material; a colour that already carries alpha keeps it.
 */
export function resolveAppearance(look: Look, tables: AppearanceTables, parent: Appearance | null): Appearance {
  const layer = tables.layers[look.layer];
  const material = look.materialSource === 'parent' && parent !== null ? parent.material
    : look.materialSource === 'object' ? look.material : layer?.material ?? -1;
  const shader = tables.materials[material];
  let color = look.colorSource === 'parent' && parent !== null ? parent.color
    : look.colorSource === 'object' ? rgba(look.color)
    : look.colorSource === 'material' && shader ? rgba(shader.diffuse) : rgba(layer?.color ?? BLACK);
  // A new array: the parent's colour is shared with the parent.
  if (shader && shader.transparency > 0 && color[3] === 1) color = [color[0], color[1], color[2], 1 - shader.transparency];
  return { color, material };
}
