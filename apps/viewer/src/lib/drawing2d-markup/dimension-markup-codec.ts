/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a dimension's element references and drawing cut are spelled in
 * `Pset_IfcLiteMarkup` (`RefA`, `RefB`, `Plane`). `@ifc-lite/create` writes
 * these strings verbatim; the save path encodes with this module and the
 * reader (`overlay-parse/drawing-markup-read-dimension.ts`) decodes with it,
 * so the two cannot drift.
 *
 * - A reference is `IfcType:GlobalId`. A GlobalId uses `0-9A-Za-z_$` and an
 *   IFC type name has no colon, so the first colon splits them.
 * - A plane is the JSON of the stamp `dimensionPlaneStamp` keeps, the same
 *   value localStorage persists. Decoding does not validate it;
 *   `isDimension2D` does, on the whole dimension.
 */

import { dimensionPlaneStamp, type Dimension2DElementRef } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';

export function encodeDimensionRef(ref: Dimension2DElementRef | undefined): string | undefined {
  return ref ? `${ref.ifcType}:${ref.globalId}` : undefined;
}

/** The reference `value` spells, or `null` when it is not `IfcType:GlobalId`. */
export function decodeDimensionRef(value: string): Dimension2DElementRef | null {
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1) return null;
  return { ifcType: value.slice(0, colon), globalId: value.slice(colon + 1) };
}

export function encodeDimensionPlane(plane: DrawnSectionPlane | undefined): string | undefined {
  const stamp = dimensionPlaneStamp(plane);
  return stamp ? JSON.stringify(stamp) : undefined;
}

/** The parsed plane stamp, or `null` when `value` is not JSON. */
export function decodeDimensionPlane(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[dimension-markup-codec] Plane is not JSON; the dimension is skipped', error);
    return null;
  }
}
