/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit → SI conversion for `range` drafts. IDS values are stored in SI
 * units (IDS 1.0, "units"), so `{ kind: 'range', min: 2400, unit: 'mm' }`
 * becomes `minInclusive: 2.4`. Only linear (scale) units and the two
 * affine temperature scales are supported; anything else is a draft error.
 */

interface UnitDef {
  scale: number;
  offset?: number;
}

const UNITS: Record<string, UnitDef> = {
  // length → m
  mm: { scale: 1e-3 },
  cm: { scale: 1e-2 },
  dm: { scale: 1e-1 },
  m: { scale: 1 },
  km: { scale: 1e3 },
  in: { scale: 0.0254 },
  ft: { scale: 0.3048 },
  // area → m²
  mm2: { scale: 1e-6 },
  cm2: { scale: 1e-4 },
  m2: { scale: 1 },
  ft2: { scale: 0.09290304 },
  // volume → m³
  mm3: { scale: 1e-9 },
  cm3: { scale: 1e-6 },
  l: { scale: 1e-3 },
  m3: { scale: 1 },
  // mass → kg
  g: { scale: 1e-3 },
  kg: { scale: 1 },
  t: { scale: 1e3 },
  // time → s
  s: { scale: 1 },
  min: { scale: 60 },
  h: { scale: 3600 },
  // force → N, pressure → Pa
  n: { scale: 1 },
  kn: { scale: 1e3 },
  pa: { scale: 1 },
  kpa: { scale: 1e3 },
  mpa: { scale: 1e6 },
  // plane angle → rad
  rad: { scale: 1 },
  deg: { scale: Math.PI / 180 },
  // thermodynamic temperature → K
  k: { scale: 1 },
  degc: { scale: 1, offset: 273.15 },
  degf: { scale: 5 / 9, offset: 273.15 - (32 * 5) / 9 },
};

const ALIASES: Record<string, string> = {
  'mm²': 'mm2',
  'cm²': 'cm2',
  'm²': 'm2',
  'ft²': 'ft2',
  'mm³': 'mm3',
  'cm³': 'cm3',
  'm³': 'm3',
  '°': 'deg',
  '°c': 'degc',
  '°f': 'degf',
  liter: 'l',
  litre: 'l',
};

function lookupUnit(unit: string): UnitDef | undefined {
  const key = unit.trim().toLowerCase();
  return UNITS[ALIASES[key] ?? key];
}

export function isKnownUnit(unit: string): boolean {
  return lookupUnit(unit) !== undefined;
}

/** Convert `value` in `unit` to SI. Throws on an unknown unit. */
export function toSI(value: number, unit: string): number {
  const def = lookupUnit(unit);
  if (!def) throw new Error(`unknown unit "${unit}"`);
  const si = value * def.scale + (def.offset ?? 0);
  // Strip binary noise from decimal scales (2400 mm → 2.4, not 2.4000000000000004).
  return Number(si.toPrecision(15));
}
