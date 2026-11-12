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

/** True when a block member's colour depends on the instance placing it: "by parent", or by a material that is "by parent". */
export function takesParentColor(look: Look): boolean {
  return look.colorSource === 'parent' || (look.colorSource === 'material' && look.materialSource === 'parent');
}

/**
 * Resolve an object's colour. `parent` is the block instance placing it, or
 * null at top level, where "from parent" falls back to the layer.
 *
 * A material's transparency overrides an opaque colour, because Rhino shows
 * transparency from the material. That applies to a material the object or its
 * layer names, never to an inherited one: the parent's colour already carries it.
 */
export function resolveAppearance(look: Look, tables: AppearanceTables, parent: Appearance | null): Appearance {
  const layer = tables.layers[look.layer];
  const inherited = look.materialSource === 'parent' && parent !== null;
  const material = inherited ? parent.material
    : look.materialSource === 'object' ? look.material : layer?.material ?? -1;
  if (parent && takesParentColor(look)) return { color: parent.color, material };
  const shader = tables.materials[material];
  const color = look.colorSource === 'object' ? rgba(look.color)
    : look.colorSource === 'material' && shader ? rgba(shader.diffuse) : rgba(layer?.color ?? BLACK);
  if (!inherited && shader && shader.transparency > 0 && color[3] === 1) color[3] = 1 - shader.transparency;
  return { color, material };
}
