/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { extractMaterialsOnDemand } from '@ifc-lite/parser';
import type { MaterialInfo } from '../types.js';

/**
 * Flatten the parser's hierarchical material graph into the flat
 * `{name, category}[]` array the IDS validator consumes. Surfaces
 * every name AND category as a candidate match — IDS material
 * `<value>` fixtures pass when ANY surface matches the constraint, so
 * we proactively duplicate categories under their own entries.
 */
export function flattenMaterials(
  matInfo: ReturnType<typeof extractMaterialsOnDemand>
): MaterialInfo[] {
  if (!matInfo) return [];
  const out: MaterialInfo[] = [];
  const push = (name?: string, category?: string): void => {
    if (!name) return;
    out.push({ name, category });
  };

  switch (matInfo.type) {
    case 'Material':
      if (matInfo.unresolved) {
        // Confirmed materially-associated (a real relationship-graph edge),
        // but the material's own name/category are unreadable on this data
        // source (#5227). `push` above drops entries with no `name`, which
        // would silently discard this marker and make the entity read as
        // genuinely unmaterialed — the exact bug this fix closes. Preserve
        // the marker itself instead.
        out.push({ name: '', unresolved: true });
        break;
      }
      push(matInfo.name, matInfo.category);
      if (matInfo.category) push(matInfo.category, matInfo.category);
      break;

    case 'MaterialList':
      for (const m of matInfo.materials || []) {
        if (typeof m === 'string') {
          push(m);
        } else if (m && typeof m === 'object') {
          push(m.name, m.category);
          if (m.category) push(m.category, m.category);
        }
      }
      break;

    case 'MaterialLayerSet':
      push(matInfo.name);
      for (const layer of matInfo.layers || []) {
        push(layer.materialName, layer.category);
        push(layer.name, layer.category);
        if (layer.materialCategory)
          push(layer.materialCategory, layer.materialCategory);
      }
      break;

    case 'MaterialConstituentSet':
      push(matInfo.name);
      for (const c of matInfo.constituents || []) {
        push(c.materialName, c.category);
        push(c.name, c.category);
        if (c.materialCategory)
          push(c.materialCategory, c.materialCategory);
      }
      break;

    case 'MaterialProfileSet':
      push(matInfo.name);
      for (const p of matInfo.profiles || []) {
        push(p.materialName, p.category);
        push(p.name, p.category);
        if (p.materialCategory)
          push(p.materialCategory, p.materialCategory);
      }
      break;
  }
  if (matInfo.unresolved && matInfo.type !== 'Material') {
    out.push({ name: '', unresolved: true });
  }
  if (!matInfo.unresolved && out.length === 0) {
    // A fully read association with no authored name/category still proves
    // presence. The empty candidate yields a definite value mismatch.
    out.push({ name: '' });
  }
  return out;
}
