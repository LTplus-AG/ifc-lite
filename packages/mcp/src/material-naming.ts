/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialData } from '@ifc-lite/sdk';

/**
 * Grouping name for a `MaterialData` result, or undefined when none is
 * available. `.name` alone only covers a plain `Material` (and, when
 * authored in the source file, a LayerSet/ProfileSet/ConstituentSet) — an
 * `IfcMaterialList` never carries a list-level name, only `.materials[]`,
 * so reading `.name` alone mis-buckets every list-material entity as
 * unnamed. `computeMaterialSummary`
 * (`packages/cli/src/commands/stats-aggregation.ts`) already falls back to
 * `.materials[0]` for that case; the layer, profile and constituent
 * fallbacks below go beyond it.
 *
 * Shared by every MCP call site that needs a single label for a
 * `MaterialData` value (the `materials` resource, `viewer_get_selection`'s
 * text summary): each of these read the same `extractMaterialsOnDemand`
 * shape and used to fall back independently, drifting on which multi-
 * material shapes they covered.
 */
export function materialFallbackName(mat: MaterialData | null | undefined): string | undefined {
  if (!mat) return undefined;
  return (
    mat.name ??
    mat.materials?.[0]?.name ??
    mat.layers?.find((l) => l.materialName)?.materialName ??
    mat.profiles?.find((p) => p.materialName)?.materialName ??
    mat.constituents?.find((c) => c.materialName)?.materialName
  );
}
