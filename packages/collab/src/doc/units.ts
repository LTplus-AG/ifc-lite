/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property unit conversion (spec §20 open problem #3).
 *
 * When a model's length unit changes (e.g. `m` → `mm`), numeric
 * properties carrying a unit must auto-convert. This module ships a
 * small, dependency-free converter for the IFC unit families we see
 * most often in `Pset_*::*` properties: length, area, volume, angle.
 *
 * Real IFC schemas have far more units (mass, time, currency,
 * frequency, …). We deliberately ship a minimal-but-correct subset
 * that handles 95% of architectural / structural property data and
 * leave the long tail to v1.0 + a published unit registry.
 */

import * as Y from 'yjs';
import { ENTITY_KEY, entitiesMap } from './schema.js';
import type { PropertyValue } from './schema.js';

/** SI-relative scale factors. `to_si = scale * value`. */
const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  meter: 1,
  meters: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  inch: 0.0254,
  ft: 0.3048,
  feet: 0.3048,
};

const AREA_TO_M2: Record<string, number> = {
  'm^2': 1,
  m2: 1,
  'cm^2': 1e-4,
  cm2: 1e-4,
  'mm^2': 1e-6,
  mm2: 1e-6,
  'ft^2': 0.092903,
  'in^2': 0.00064516,
};

const VOLUME_TO_M3: Record<string, number> = {
  'm^3': 1,
  m3: 1,
  'cm^3': 1e-6,
  cm3: 1e-6,
  'mm^3': 1e-9,
  mm3: 1e-9,
  liter: 0.001,
  litre: 0.001,
  l: 0.001,
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  radian: 1,
  radians: 1,
  deg: Math.PI / 180,
  degree: Math.PI / 180,
  degrees: Math.PI / 180,
};

export type UnitFamily = 'length' | 'area' | 'volume' | 'angle';

const FAMILY_TABLES: Record<UnitFamily, Record<string, number>> = {
  length: LENGTH_TO_M,
  area: AREA_TO_M2,
  volume: VOLUME_TO_M3,
  angle: ANGLE_TO_RAD,
};

/** Detect which family a unit string belongs to (case-insensitive). */
export function familyOf(unit: string): UnitFamily | null {
  const u = unit.toLowerCase();
  for (const [family, table] of Object.entries(FAMILY_TABLES) as [UnitFamily, Record<string, number>][]) {
    if (u in table) return family;
  }
  return null;
}

/**
 * Convert `value` from `from` units to `to` units. Returns `null` if
 * either unit is unknown or they belong to different families.
 */
export function convertValue(value: number, from: string, to: string): number | null {
  const fromLc = from.toLowerCase();
  const toLc = to.toLowerCase();
  const family = familyOf(fromLc);
  if (!family) return null;
  if (familyOf(toLc) !== family) return null;
  const table = FAMILY_TABLES[family];
  const fromScale = table[fromLc];
  const toScale = table[toLc];
  if (fromScale == null || toScale == null) return null;
  return (value * fromScale) / toScale;
}

export interface ConvertEntityUnitsOptions {
  /** Forwarded to the transaction. */
  origin?: unknown;
  /** Override which families to touch. Defaults to all four. */
  families?: ReadonlyArray<UnitFamily>;
}

export interface ConvertEntityUnitsReport {
  /** How many `PropertyValue`s were converted. */
  converted: number;
  /** How many `PropertyValue`s were skipped because their unit didn't match `from`. */
  skipped: number;
}

/**
 * Walk every entity's Psets and convert numeric `PropertyValue`s
 * carrying `unit === from` to `to`. The value is updated and the
 * `unit` field is rewritten.
 *
 * Note: only converts within a single family at a time — call once per
 * family pair (e.g. `convertEntityUnits(doc, 'mm', 'm')` for length,
 * separately for area).
 */
export function convertEntityUnits(
  doc: Y.Doc,
  from: string,
  to: string,
  options: ConvertEntityUnitsOptions = {},
): ConvertEntityUnitsReport {
  let converted = 0;
  let skipped = 0;

  doc.transact(() => {
    entitiesMap(doc).forEach((entUntyped) => {
      const entity = entUntyped as Y.Map<unknown>;
      const psets = entity.get(ENTITY_KEY.PSETS) as
        | Y.Map<Y.Map<PropertyValue>>
        | undefined;
      if (!psets) return;

      psets.forEach((psetUntyped) => {
        const pset = psetUntyped as Y.Map<PropertyValue>;
        pset.forEach((prop, propName) => {
          if (!prop || prop.unit == null || typeof prop.value !== 'number') return;
          if (prop.unit.toLowerCase() !== from.toLowerCase()) {
            skipped += 1;
            return;
          }
          const newValue = convertValue(prop.value, from, to);
          if (newValue == null) {
            skipped += 1;
            return;
          }
          pset.set(propName, { ...prop, value: newValue, unit: to });
          converted += 1;
        });
      });
    });
  }, options.origin);

  return { converted, skipped };
}
