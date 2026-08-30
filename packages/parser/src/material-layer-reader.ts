/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `IfcMaterialLayer` / `IfcMaterialLayerSet` half of the material reader.
 *
 * Split out of `material-extractor.ts`, which reads six other material
 * concepts and was at the 400-line house limit. These two belong together:
 * they are the only material entities carrying a *measure*, so they are the
 * only ones that have to decide what to do with a thickness the IEEE-754
 * double range cannot hold — and the layer and the set have to make that
 * decision the same way or a set's total stops matching its layers.
 */

import type { IfcEntity } from './entity-extractor.js';
import {
  getString,
  getNumber,
  getBoolean,
  getReference,
  getReferences,
  isUnrepresentableNumericValue,
} from './attribute-helpers.js';

/** `IfcMaterialLayer`: Material[0], LayerThickness[1], IsVentilated[2], … */
export const LAYER_THICKNESS_SLOT = 1;

export interface MaterialLayer {
  id: number;
  material: number;  // Material ID
  thickness: number;
  isVentilated?: boolean;
  name?: string;
  description?: string;
  category?: string;
  priority?: number;
}

export interface MaterialLayerSet {
  id: number;
  name?: string;
  description?: string;
  layers: number[];  // MaterialLayer IDs
  totalThickness?: number;
}

/**
 * True when this `IfcMaterialLayer`'s thickness names a number that cannot be
 * represented.
 *
 * `MaterialLayer.thickness` is typed `number`, so `|| 0` was the only thing
 * standing between an overflowing `LayerThickness` and a layer reported as
 * 0 thick — a plausible reading of a real layer, and one that also silently
 * vanishes from a layer set's total. That `|| 0` did not fire while
 * `getNumber` answered `Infinity`; it does now that the answer is `undefined`,
 * which is why the guard has to be at the call site and not in the helper.
 */
export function hasUnrepresentableThickness(layer: IfcEntity): boolean {
  return isUnrepresentableNumericValue(layer.attributes[LAYER_THICKNESS_SLOT]);
}

export function extractMaterialLayer(entity: IfcEntity): MaterialLayer {
  const materialRef = getReference(entity.attributes[0]);
  const thickness = getNumber(entity.attributes[LAYER_THICKNESS_SLOT]) || 0;

  return {
    id: entity.expressId,
    material: materialRef || 0,
    thickness,
    isVentilated: getBoolean(entity.attributes[2]),
    name: getString(entity.attributes[3]),
    description: getString(entity.attributes[4]),
    category: getString(entity.attributes[5]),
    priority: getNumber(entity.attributes[6]),
  };
}

export function extractMaterialLayerSet(
  entity: IfcEntity,
  entities: Map<number, IfcEntity>,
): MaterialLayerSet {
  const layers = getReferences(entity.attributes[0]) || [];
  const name = getString(entity.attributes[1]);
  const description = getString(entity.attributes[2]);

  // Calculate total thickness. A member layer whose thickness the double
  // range cannot hold makes the total unknowable, not smaller: adding `0` for
  // it would report a build-up thinner than the file says it is, with nothing
  // to distinguish that from a genuine total. `totalThickness` is optional, so
  // the honest answer is to leave it off.
  let totalThickness: number | undefined = 0;
  for (const layerId of layers) {
    const layerEntity = entities.get(layerId);
    if (layerEntity) {
      if (hasUnrepresentableThickness(layerEntity)) {
        totalThickness = undefined;
        break;
      }
      totalThickness += getNumber(layerEntity.attributes[LAYER_THICKNESS_SLOT]) || 0;
    }
  }

  return {
    id: entity.expressId,
    name,
    description,
    layers,
    totalThickness,
  };
}
