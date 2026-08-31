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
 * Member list for one multi-material array, or undefined when the array is
 * absent, empty, or names nothing.
 *
 * The last case matters: `IfcMaterialProfile.Material` and
 * `IfcMaterialConstituent.Material` can be absent or fail to resolve, in
 * which case `material-resolver.ts` leaves both `materialName` and `name`
 * undefined on every member. A line of placeholders ("?, ?") names nothing,
 * so it is worth less than the set-level `Name` the caller falls back to —
 * report nothing here and let that fallback run.
 */
function memberLine(
  members: ReadonlyArray<{ materialName?: string; name?: string }> | undefined,
): string | undefined {
  if (!Array.isArray(members) || members.length === 0) return undefined;
  if (!members.some((m) => m.materialName ?? m.name)) return undefined;
  return `  Materials: ${members.map((m) => m.materialName ?? m.name ?? '?').join(', ')}`;
}

/**
 * Format a `MaterialData` value as a single summary line, or undefined
 * when there is nothing to show. Every multi-material shape
 * `extractMaterialsOnDemand` can produce is listed by its member names
 * (`.layers[]`, `.profiles[]`, `.constituents[]`, `.materials[]`) before
 * falling back to a single name — an `IfcMaterialProfileSet` or
 * `IfcMaterialConstituentSet` with no set-level `Name` used to fall
 * through to that single-name check alone, which found nothing and
 * dropped the whole line instead of naming the assigned material.
 *
 * The single-name fallback still runs when the member arrays name nothing,
 * so a NAMED set whose members are all unnamed keeps printing its own
 * `Name` rather than a row of `?` placeholders.
 */
export function formatMaterialsBlock(mat: MaterialData | null | undefined): string | undefined {
  if (!mat) return undefined;
  const line =
    memberLine(mat.layers) ??
    memberLine(mat.profiles) ??
    memberLine(mat.constituents) ??
    memberLine(mat.materials);
  if (line) return line;
  const name = materialFallbackName(mat);
  return name ? `  Material: ${name}` : undefined;
}
