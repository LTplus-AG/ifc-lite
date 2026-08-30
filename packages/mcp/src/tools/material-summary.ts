/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human-readable "Materials:"/"Material:" line for `viewer_get_selection`'s
 * text summary. Split out of `viewer.ts` (which sits at its module-size
 * budget) rather than grown in place.
 */

import type { MaterialData } from '@ifc-lite/sdk';
import { materialFallbackName } from '../material-naming.js';

/**
 * Format a `MaterialData` value as a single summary line, or undefined
 * when there is nothing to show. Every multi-material shape
 * `extractMaterialsOnDemand` can produce is listed by its member names
 * (`.layers[]`, `.profiles[]`, `.constituents[]`, `.materials[]`) before
 * falling back to a single name — an `IfcMaterialProfileSet` or
 * `IfcMaterialConstituentSet` with no set-level `Name` used to fall
 * through to that single-name check alone, which found nothing and
 * dropped the whole line instead of naming the assigned material.
 */
export function formatMaterialsBlock(mat: MaterialData | null | undefined): string | undefined {
  if (!mat) return undefined;
  if (Array.isArray(mat.layers) && mat.layers.length > 0) {
    return `  Materials: ${mat.layers.map((l) => l.materialName ?? l.name ?? '?').join(', ')}`;
  }
  if (Array.isArray(mat.profiles) && mat.profiles.length > 0) {
    return `  Materials: ${mat.profiles.map((p) => p.materialName ?? p.name ?? '?').join(', ')}`;
  }
  if (Array.isArray(mat.constituents) && mat.constituents.length > 0) {
    return `  Materials: ${mat.constituents.map((c) => c.materialName ?? c.name ?? '?').join(', ')}`;
  }
  if (Array.isArray(mat.materials) && mat.materials.length > 0) {
    return `  Materials: ${mat.materials.map((m) => m.name ?? '?').join(', ')}`;
  }
  const name = materialFallbackName(mat);
  return name ? `  Material: ${name}` : undefined;
}
