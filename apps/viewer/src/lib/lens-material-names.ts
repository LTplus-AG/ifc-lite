/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialInfo } from '@ifc-lite/parser';

/**
 * Collect the distinct *individual* material names for an element from its
 * resolved {@link MaterialInfo} — each layer / constituent / profile / list
 * material. Deliberately excludes the layer-set / usage name (`info.name`,
 * which for Revit exports is the family+type, not a material) UNLESS the
 * element has no sub-structure, in which case the top-level name IS the single
 * material. Order-preserving and de-duplicated, so a wall layered
 * gypsumboard / insulation / gypsumboard yields `["gypsumboard", "insulation"]`
 * and the element can be grouped/selected under each material. (#1366)
 */
export function lensMaterialNames(info: MaterialInfo | null | undefined): string[] {
  if (!info) return [];
  const seen = new Set<string>();
  const add = (s?: string) => {
    const t = s?.trim();
    if (t) seen.add(t);
  };
  for (const l of info.layers ?? []) add(l.materialName);
  for (const c of info.constituents ?? []) add(c.materialName);
  for (const p of info.profiles ?? []) add(p.materialName);
  for (const m of info.materials ?? []) add(m.name);
  // No sub-structure → the element carries a single plain material.
  if (seen.size === 0) add(info.name);
  return [...seen];
}
