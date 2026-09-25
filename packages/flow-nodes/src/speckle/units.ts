/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Speckle unit strings → SI scale factors.
 *
 * Geometry carries Speckle's own unit vocabulary (`mm`, `cm`, `m`, `km`,
 * `in`, `ft`, `yd`, `mi` and their spelled-out aliases, per specklepy's
 * `UNITS_STRINGS`). Revit parameters carry Revit's display names instead
 * (`Centimeters`, `Square meters`, `Cubic feet`). Both are handled; a unit
 * outside these tables is not a length/area/volume and its value is carried
 * unconverted, never guessed.
 */

const LENGTH_TO_METRES: Readonly<Record<string, number>> = {
  mm: 0.001, mil: 0.001, millimeter: 0.001, millimeters: 0.001, millimetre: 0.001, millimetres: 0.001,
  cm: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01,
  dm: 0.1, decimeter: 0.1, decimeters: 0.1, decimetre: 0.1, decimetres: 0.1,
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
  km: 1000, kilometer: 1000, kilometers: 1000, kilometre: 1000, kilometres: 1000,
  in: 0.0254, inch: 0.0254, inches: 0.0254,
  ft: 0.3048, foot: 0.3048, feet: 0.3048,
  yd: 0.9144, yard: 0.9144, yards: 0.9144,
  mi: 1609.34, mile: 1609.34, miles: 1609.34,
};

/** Metres per one `units`, or undefined when `units` is not a length unit (including Speckle's `none`). */
export function lengthScale(units: unknown): number | undefined {
  if (typeof units !== 'string') return undefined;
  return LENGTH_TO_METRES[units.trim().toLowerCase()];
}

export type Quantity = 'length' | 'area' | 'volume';

/**
 * The quantity and SI factor of a parameter unit, e.g. `Square meters` →
 * area × 1, `Cubic feet` → volume × 0.0283…; undefined for anything else
 * (`Currency`, `Degrees`, …).
 */
export function parameterScale(units: unknown): { quantity: Quantity; factor: number } | undefined {
  if (typeof units !== 'string') return undefined;
  const u = units.trim().toLowerCase();
  const direct = LENGTH_TO_METRES[u];
  if (direct !== undefined) return { quantity: 'length', factor: direct };
  const sq = /^(?:square\s+(.+)|(.+?)(?:²|2))$/.exec(u);
  if (sq) {
    const f = LENGTH_TO_METRES[(sq[1] ?? sq[2]).trim()];
    if (f !== undefined) return { quantity: 'area', factor: f * f };
  }
  const cu = /^(?:cubic\s+(.+)|(.+?)(?:³|3))$/.exec(u);
  if (cu) {
    const f = LENGTH_TO_METRES[(cu[1] ?? cu[2]).trim()];
    if (f !== undefined) return { quantity: 'volume', factor: f * f * f };
  }
  if (u === 'liters' || u === 'litres' || u === 'l') return { quantity: 'volume', factor: 0.001 };
  return undefined;
}
