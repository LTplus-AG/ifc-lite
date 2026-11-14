/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { LiveModel } from '@/lib/commands/modeling/authored-kinds';

/** Model appearance data: stable across light/dark UI themes. */
export const DEFAULT_MATERIAL_COLOUR = '#808080';

const ref = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'string' && /^#\d+$/.test(v) ? Number(v.slice(1)) : -1;
const real = (v: unknown): number => typeof v === 'number' ? v : Number((v as { real?: unknown } | null)?.real);
const STYLE_REF_SLOT: Readonly<Record<string, number>> = {
  IFCMATERIALDEFINITIONREPRESENTATION: 2,
  IFCSTYLEDREPRESENTATION: 3,
  IFCSTYLEDITEM: 1,
  IFCPRESENTATIONSTYLEASSIGNMENT: 0,
  IFCSURFACESTYLE: 2,
  IFCSURFACESTYLESHADING: 0,
  IFCSURFACESTYLERENDERING: 0,
};

/** Only surface appearance edges: curve styles never supply a surface swatch.
 * The result is pure metadata, so one visited set bounds cycles and fan-out. */
function colourBehind(live: LiveModel, definitionId: number): string | undefined {
  const pending = [definitionId];
  const seen = new Set<number>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id < 0 || seen.has(id)) continue;
    seen.add(id);
    const record = effectiveMetadataRecord(live.dataStore, id, live.view ?? undefined);
    if (!record) continue;
    const type = record.type.toUpperCase();
    if (type === 'IFCCOLOURRGB') {
      const rgb = record.attributes.slice(1, 4).map(real);
      if (rgb.length === 3 && rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
        return `#${rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
      }
      continue;
    }
    const slot = STYLE_REF_SLOT[type];
    if (slot === undefined) continue;
    const value = record.attributes[slot];
    const links = Array.isArray(value) ? value : [value];
    // Stack order preserves the IFC list's preference order.
    for (let i = links.length - 1; i >= 0; i--) pending.push(ref(links[i]));
  }
  return undefined;
}

/** Read the IFC appearance for picker swatches; rendering stays in Rust. */
export function materialColour(live: LiveModel, materialId: number): string | undefined {
  for (const { expressId } of iterateEffectiveEntityIds(live.dataStore, live.view, ['IfcMaterialDefinitionRepresentation'])) {
    const definition = effectiveMetadataRecord(live.dataStore, expressId, live.view ?? undefined)?.attributes;
    if (ref(definition?.[3]) !== materialId) continue;
    const colour = colourBehind(live, expressId);
    if (colour) return colour;
  }
  return undefined;
}
