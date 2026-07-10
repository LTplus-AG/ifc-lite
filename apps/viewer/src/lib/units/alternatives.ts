/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Curated display-unit alternatives per IFC unit-type token (issue #1573).
 *
 * This is a viewer-only DISPLAY concept: it never touches the model or any
 * stored value. Each option's `scale`/`offset` converts a value in that unit
 * to the unit-type's canonical SI base: `siBase = value*scale + (offset??0)`.
 * The first option per kind is always the SI base itself (`scale: 1`, no
 * offset), so "reset to file units" is just "no override" rather than a
 * special case.
 *
 * Kept intentionally small: every list here is a hand-picked set of the
 * alternatives users actually reach for (metric + the common imperial /
 * industry unit), not an exhaustive enumeration of every `IfcSIUnitName` /
 * `IfcConversionBasedUnit` this file could theoretically declare - see
 * `packages/parser/src/project-units.ts` for the full file-declared-unit
 * resolver this complements.
 */

export interface UnitOption {
  id: string;
  symbol: string;
  scale: number;
  offset?: number;
}

export const UNIT_ALTERNATIVES: Record<string, UnitOption[]> = {
  LENGTHUNIT: [
    { id: 'm', symbol: 'm', scale: 1 },
    { id: 'mm', symbol: 'mm', scale: 1e-3 },
    { id: 'cm', symbol: 'cm', scale: 1e-2 },
    { id: 'km', symbol: 'km', scale: 1e3 },
    { id: 'ft', symbol: 'ft', scale: 0.3048 },
    { id: 'in', symbol: 'in', scale: 0.0254 },
  ],
  AREAUNIT: [
    { id: 'm2', symbol: 'm²', scale: 1 },
    { id: 'cm2', symbol: 'cm²', scale: 1e-4 },
    { id: 'mm2', symbol: 'mm²', scale: 1e-6 },
    { id: 'ft2', symbol: 'ft²', scale: 0.09290304 },
    { id: 'in2', symbol: 'in²', scale: 0.00064516 },
  ],
  VOLUMEUNIT: [
    { id: 'm3', symbol: 'm³', scale: 1 },
    { id: 'l', symbol: 'L', scale: 1e-3 },
    { id: 'cm3', symbol: 'cm³', scale: 1e-6 },
    { id: 'ft3', symbol: 'ft³', scale: 0.028316846592 },
    { id: 'gal', symbol: 'gal', scale: 0.003785411784 },
  ],
  MASSUNIT: [
    { id: 'kg', symbol: 'kg', scale: 1 },
    { id: 'g', symbol: 'g', scale: 1e-3 },
    { id: 't', symbol: 't', scale: 1e3 },
    { id: 'lb', symbol: 'lb', scale: 0.45359237 },
  ],
  TIMEUNIT: [
    { id: 's', symbol: 's', scale: 1 },
    { id: 'min', symbol: 'min', scale: 60 },
    { id: 'h', symbol: 'h', scale: 3600 },
    { id: 'd', symbol: 'd', scale: 86400 },
  ],
  PLANEANGLEUNIT: [
    { id: 'rad', symbol: 'rad', scale: 1 },
    { id: 'deg', symbol: '°', scale: 0.0174532925199433 },
  ],
  VOLUMETRICFLOWRATEUNIT: [
    { id: 'm3s', symbol: 'm³/s', scale: 1 },
    { id: 'm3h', symbol: 'm³/h', scale: 2.7777777777777776e-4 },
    { id: 'ls', symbol: 'L/s', scale: 1e-3 },
    { id: 'lmin', symbol: 'L/min', scale: 1.6666666666666667e-5 },
    { id: 'cfm', symbol: 'cfm', scale: 4.719474432e-4 },
  ],
  MASSFLOWRATEUNIT: [
    { id: 'kgs', symbol: 'kg/s', scale: 1 },
    { id: 'kgh', symbol: 'kg/h', scale: 2.7777777777777776e-4 },
    { id: 'gs', symbol: 'g/s', scale: 1e-3 },
  ],
  PRESSUREUNIT: [
    { id: 'pa', symbol: 'Pa', scale: 1 },
    { id: 'kpa', symbol: 'kPa', scale: 1e3 },
    { id: 'mpa', symbol: 'MPa', scale: 1e6 },
    { id: 'bar', symbol: 'bar', scale: 1e5 },
    { id: 'hpa', symbol: 'hPa', scale: 100 },
    { id: 'psi', symbol: 'psi', scale: 6894.757293168 },
  ],
  POWERUNIT: [
    { id: 'w', symbol: 'W', scale: 1 },
    { id: 'kw', symbol: 'kW', scale: 1e3 },
    { id: 'mw', symbol: 'MW', scale: 1e6 },
    { id: 'hp', symbol: 'hp', scale: 745.6998715823 },
  ],
  ENERGYUNIT: [
    { id: 'j', symbol: 'J', scale: 1 },
    { id: 'kj', symbol: 'kJ', scale: 1e3 },
    { id: 'mj', symbol: 'MJ', scale: 1e6 },
    { id: 'wh', symbol: 'Wh', scale: 3600 },
    { id: 'kwh', symbol: 'kWh', scale: 3.6e6 },
  ],
  LINEARVELOCITYUNIT: [
    { id: 'ms', symbol: 'm/s', scale: 1 },
    { id: 'kmh', symbol: 'km/h', scale: 0.2777777777777778 },
    { id: 'fts', symbol: 'ft/s', scale: 0.3048 },
    { id: 'mph', symbol: 'mph', scale: 0.44704 },
  ],
  FREQUENCYUNIT: [
    { id: 'hz', symbol: 'Hz', scale: 1 },
    { id: 'khz', symbol: 'kHz', scale: 1e3 },
    { id: 'mhz', symbol: 'MHz', scale: 1e6 },
  ],
  THERMODYNAMICTEMPERATUREUNIT: [
    { id: 'k', symbol: 'K', scale: 1, offset: 0 },
    { id: 'c', symbol: '°C', scale: 1, offset: 273.15 },
    { id: 'f', symbol: '°F', scale: 0.5555555555555556, offset: 255.3722222222222 },
  ],
  MASSDENSITYUNIT: [
    { id: 'kgm3', symbol: 'kg/m³', scale: 1 },
    { id: 'gcm3', symbol: 'g/cm³', scale: 1000 },
    { id: 'gl', symbol: 'g/L', scale: 1 },
  ],
  FORCEUNIT: [
    { id: 'n', symbol: 'N', scale: 1 },
    { id: 'kn', symbol: 'kN', scale: 1e3 },
    { id: 'lbf', symbol: 'lbf', scale: 4.4482216152605 },
  ],
};

/** Curated display alternatives for a unit-type token (e.g. "LENGTHUNIT"),
 *  or `[]` when this file declares no curated alternatives for it. */
export function alternativesForUnitType(unitType: string): UnitOption[] {
  return UNIT_ALTERNATIVES[unitType] ?? [];
}
