/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import { getAttributeNames, getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';

type DisplayAttribute = { name: string; value: string | number | boolean };

/**
 * The entity's displayed attributes with this session's edits laid over
 * them: named attribute edits (bSDD, the attribute editor), and positional
 * edits of a numeric slot the list already shows, such as an IfcSite
 * RefElevation the georeferencing check wrote (#10659). A positional edit
 * of any other value (a list, a reference) shows in the Raw STEP tab.
 */
export function mergeAttributeMutations(
  base: DisplayAttribute[],
  view: MutablePropertyView | null | undefined,
  expressId: number | undefined,
  typeName: string | undefined,
): DisplayAttribute[] {
  if (!view || !expressId) return base;
  const merged = [...base];
  const put = (name: string, value: string | number | boolean, addMissing: boolean) => {
    const idx = merged.findIndex((a) => a.name === name);
    if (idx >= 0) merged[idx] = { name, value };
    else if (addMissing) merged.push({ name, value });
  };
  const positional = view.getPositionalMutationsForEntity(expressId);
  if (positional?.size && typeName) {
    const names = getAttributeNamesAcrossSchemas(typeName);
    for (const [index, value] of positional) {
      const number = typeof value === 'number' ? value : value !== null && typeof value === 'object' && 'real' in value ? value.real : undefined;
      if (number !== undefined && names[index]) put(names[index], number, false);
    }
  }
  for (const ma of view.getAttributeMutationsForEntity(expressId)) put(ma.name, ma.value === '$' ? '' : ma.value, true);
  return merged;
}

/** Synthesize display attributes for overlay-only duplicates and scripted adds. */
export function attributesFromOverlayEntity(
  entity: NewEntity,
): Array<{ name: string; value: string }> {
  const names = getAttributeNames(entity.type) ?? [];
  if (names.length === 0) return [];
  const out: Array<{ name: string; value: string }> = [];
  const len = Math.min(names.length, entity.attributes.length);
  for (let i = 0; i < len; i++) {
    const value = entity.attributes[i];
    let display: string;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value === '$' || value.length === 0) continue;
      display = value;
    } else if (typeof value === 'number') {
      display = String(value);
    } else if (typeof value === 'boolean') {
      display = value ? 'true' : 'false';
    } else {
      continue;
    }
    out.push({ name: names[i], value: display });
  }
  return out;
}
