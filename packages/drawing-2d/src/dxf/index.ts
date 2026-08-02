/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF import as a 2D reference underlay (issue #1782).
 *
 * ```ts
 * import { importDxf } from '@ifc-lite/drawing-2d';
 * const underlay = importDxf(dxfText, 'site-plan.dxf');
 * // underlay.layers[n].paths / .fills / .texts are in drawing space (metres)
 * ```
 */

import { parseDxf } from './parser.js';
import { convertDxfToUnderlay } from './convert.js';
import type { DxfUnderlay } from './types.js';

export { parseDxf, readDxfPairs, decodeDxfText, stripMtextFormatting } from './parser.js';
export { convertDxfToUnderlay, applyDxfPlacement, type DxfConvertOptions } from './convert.js';
export { aciToCss } from './aci-colors.js';
export { DEFAULT_DXF_PLACEMENT } from './types.js';
export type {
  DxfDocument,
  DxfEntity,
  DxfLayerInfo,
  DxfBlockInfo,
  DxfPair,
  DxfUnderlay,
  DxfUnderlayLayer,
  DxfUnderlayPath,
  DxfUnderlayFill,
  DxfUnderlayText,
  DxfPlacement,
} from './types.js';

/**
 * Unitless DXF files ($INSUNITS = 0) with large coordinate extents are
 * almost always millimetre drawings (the AutoCAD metric template leaves
 * INSUNITS unset). Above this extent in raw drawing units, assume mm.
 */
const UNITLESS_MM_EXTENT_THRESHOLD = 5000;

/**
 * Parse and convert an ASCII DXF file to a reference underlay in one step.
 * Unitless files whose extents exceed {@link UNITLESS_MM_EXTENT_THRESHOLD}
 * drawing units are assumed to be in millimetres (with a warning).
 */
export function importDxf(text: string, name = 'DXF'): DxfUnderlay {
  const doc = parseDxf(text);
  const underlay = convertDxfToUnderlay(doc, name);
  if (doc.insunits === 0) {
    const b = underlay.bounds;
    const extent = Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
    if (extent > UNITLESS_MM_EXTENT_THRESHOLD) {
      const rescaled = convertDxfToUnderlay(doc, name, { metersPerUnit: 0.001 });
      rescaled.warnings.push(
        `DXF has no $INSUNITS and spans ${Math.round(extent)} units; assumed millimetres.`,
      );
      return rescaled;
    }
  }
  return underlay;
}
