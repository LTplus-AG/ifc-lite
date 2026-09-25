/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revit parameters on a Speckle object, in both shapes the Revit connector
 * has written:
 *
 *   - `properties["Type Parameters" | "Instance Parameters"][group][name]`
 *     = `{ name, value, units?, internalDefinitionName }` (current v2 output);
 *   - `parameters[internalName]` = `Objects.BuiltElements.Revit.Parameter`
 *     `{ name, value, units, isTypeParameter, applicationInternalName }` (older).
 *
 * Lengths, areas and volumes are converted to metres / m² / m³; every other
 * unit is carried as authored. An entry with no scalar `value` (a compound
 * structure layer, a nested table) is not a parameter and is counted so the
 * caller can report it.
 */

import type { Resolver } from './geometry.js';
import { parameterScale } from './units.js';

export type ParamValue = string | number | boolean;

export interface SpeckleParameter {
  readonly scope: 'type' | 'instance';
  readonly name: string;
  /** Revit's BuiltInParameter / shared-parameter name, e.g. `WALL_ATTR_WIDTH_PARAM`. */
  readonly internalName?: string;
  /** Converted to SI when the unit is a length, area or volume. */
  readonly value: ParamValue;
}

export interface ParameterRead {
  readonly parameters: SpeckleParameter[];
  /** Entries under a parameter scope that carry no scalar value. */
  readonly skipped: number;
}

const isScalar = (v: unknown): v is ParamValue =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

function convert(value: ParamValue, units: unknown): ParamValue {
  if (typeof value !== 'number') return value;
  const scale = parameterScale(units);
  return scale ? value * scale.factor : value;
}

function entry(scope: 'type' | 'instance', key: string, raw: Record<string, unknown>): SpeckleParameter | undefined {
  if (!isScalar(raw.value)) return undefined;
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : key;
  const internal = raw.internalDefinitionName ?? raw.applicationInternalName;
  return { scope, name, internalName: typeof internal === 'string' ? internal : undefined, value: convert(raw.value, raw.units) };
}

const SCOPES: ReadonlyArray<[string, 'type' | 'instance']> = [['Type Parameters', 'type'], ['Instance Parameters', 'instance']];

export function readParameters(resolve: Resolver, obj: Record<string, unknown>): ParameterRead {
  const parameters: SpeckleParameter[] = [];
  let skipped = 0;
  const properties = resolve(obj.properties);
  for (const [key, scope] of SCOPES) {
    const groups = resolve(properties?.[key]);
    for (const group of Object.values(groups ?? {})) {
      const g = resolve(group);
      if (!g) continue;
      for (const [name, raw] of Object.entries(g)) {
        const r = resolve(raw);
        if (!r) continue;
        const p = entry(scope, name, r);
        if (p) parameters.push(p);
        else skipped++;
      }
    }
  }
  const legacy = resolve(obj.parameters);
  for (const [key, raw] of Object.entries(legacy ?? {})) {
    const r = resolve(raw);
    if (!r || !('value' in r)) continue; // `id`, `speckle_type`, … of the container itself
    const p = entry(r.isTypeParameter === true ? 'type' : 'instance', key, r);
    if (p) parameters.push(p);
    else skipped++;
  }
  return { parameters, skipped };
}

/** A positive numeric parameter by internal name (SI-converted), instance before type. */
export function dimension(params: readonly SpeckleParameter[], internalName: string): number | undefined {
  const hits = params.filter((p) => p.internalName === internalName && typeof p.value === 'number' && p.value > 0);
  const hit = hits.find((p) => p.scope === 'instance') ?? hits[0];
  return hit?.value as number | undefined;
}

/** Property-set rows for one scope; a repeated display name keeps both, the later one qualified by its internal name. */
export function psetRows(params: readonly SpeckleParameter[], scope: 'type' | 'instance'): Record<string, ParamValue> {
  const rows: Record<string, ParamValue> = {};
  for (const p of params) {
    if (p.scope !== scope) continue;
    let key = p.name;
    if (key in rows) key = `${p.name} (${p.internalName ?? 'duplicate'})`;
    for (let n = 2; key in rows; n++) key = `${p.name} (${p.internalName ?? 'duplicate'} ${n})`;
    rows[key] = p.value;
  }
  return rows;
}
