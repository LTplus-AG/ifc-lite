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

/** Read the IFC appearance for picker swatches; rendering stays in Rust. */
export function materialColour(live: LiveModel, materialId: number): string | undefined {
  const record = (id: number) => effectiveMetadataRecord(live.dataStore, id, live.view ?? undefined);
  for (const { expressId } of iterateEffectiveEntityIds(live.dataStore, live.view, ['IfcMaterialDefinitionRepresentation'])) {
    const definition = record(expressId)?.attributes;
    if (ref(definition?.[3]) !== materialId) continue;
    const representations = definition?.[2];
    if (!Array.isArray(representations)) continue;
    for (const representation of representations) {
      const items = record(ref(representation))?.attributes[3];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const styles = record(ref(item))?.attributes[1];
        if (!Array.isArray(styles)) continue;
        for (const styleRef of styles) {
          let style = record(ref(styleRef));
          if (style?.type.toUpperCase() === 'IFCPRESENTATIONSTYLEASSIGNMENT') {
            const inner = style.attributes[0];
            style = record(ref(Array.isArray(inner) ? inner[0] : null));
          }
          const parts = style?.attributes[2];
          if (!Array.isArray(parts)) continue;
          for (const part of parts) {
            const colour = record(ref(record(ref(part))?.attributes[0]));
            if (colour?.type.toUpperCase() !== 'IFCCOLOURRGB') continue;
            const rgb = colour.attributes.slice(1, 4).map(real);
            if (rgb.length === 3 && rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
              return `#${rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
            }
          }
        }
      }
    }
  }
  return undefined;
}
