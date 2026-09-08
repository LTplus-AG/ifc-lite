/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialInfo } from '@ifc-lite/parser';

/**
 * Single display name for a `MaterialInfo` result (the shape
 * `extractMaterialsOnDemand` returns), or undefined when there is nothing
 * to show. `.name` alone only covers a plain `Material` (and, when
 * authored in the source file, a named LayerSet/ProfileSet/
 * ConstituentSet) — an `IfcMaterialList` never carries a list-level name
 * at all, only `.materials[]`, and an unnamed LayerSet/ProfileSet/
 * ConstituentSet carries its name only on its members (`.layers[]`,
 * `.profiles[]`, `.constituents[]`). Reading `.name` (and only the list
 * fallback) mis-reports every one of those shapes as materialless in the
 * LLM context the viewer builds for a selected element.
 */
export function materialDisplayName(mat: MaterialInfo | null | undefined): string | undefined {
  if (!mat) return undefined;
  return (
    mat.name ??
    mat.materials?.[0]?.name ??
    mat.layers?.find((l) => l.materialName)?.materialName ??
    mat.profiles?.find((p) => p.materialName)?.materialName ??
    mat.constituents?.find((c) => c.materialName)?.materialName
  );
}
