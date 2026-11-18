/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isWktDefinition, registeredWktDefinition, wktDefinitionInMetres } from './wkt-projection.js';

/** A CRS's native linear unit: its name, when known, and its length in metres. */
export interface LinearUnit {
  /** `metre`, `foot`, `US survey foot`, ... `null` when the definition states only a factor. */
  readonly name: string | null;
  /** Metres per unit: 0.3048 for the foot, 1200/3937 for the US survey foot. */
  readonly toMetres: number;
}

/** proj4 `+units=` names this package recognises. Anything else fails closed. */
const PROJ_UNITS: Record<string, LinearUnit> = {
  m: { name: 'metre', toMetres: 1 },
  ft: { name: 'foot', toMetres: 0.3048 },
  'us-ft': { name: 'US survey foot', toMetres: 1200 / 3937 },
  km: { name: 'kilometre', toMetres: 1000 },
};

/** The same units looked up by factor, to name a definition that states only `+to_meter`. */
function nameForFactor(toMetres: number): string | null {
  return Object.values(PROJ_UNITS).find((unit) => unit.toMetres === toMetres)?.name ?? null;
}

/**
 * The native linear unit of a projected definition (a proj4 string or a
 * registered WKT handle), or `null` when it names a unit this package does
 * not know or states an unusable factor. A definition that states no unit is
 * in metres.
 */
export function projectedLinearUnit(definition: string): LinearUnit | null {
  if (isWktDefinition(definition)) {
    if (wktDefinitionInMetres(definition) === definition) return PROJ_UNITS.m;
    const parsed = registeredWktDefinition(definition);
    const toMetres = parsed?.to_meter ?? 1;
    if (!Number.isFinite(toMetres) || toMetres <= 0) return null;
    // wkt-parser lower-cases the unit name and spells metre the American way.
    const name = typeof parsed?.units === 'string' ? (parsed.units === 'meter' ? 'metre' : parsed.units) : null;
    return { name: name ?? nameForFactor(toMetres), toMetres };
  }
  const explicit = /(?:^|\s)\+to_meter=([^\s]+)/i.exec(definition)?.[1];
  if (explicit) {
    const ratio = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(explicit);
    const toMetres = ratio ? Number(ratio[1]) / Number(ratio[2]) : Number(explicit);
    return Number.isFinite(toMetres) && toMetres > 0 ? { name: nameForFactor(toMetres), toMetres } : null;
  }
  const unit = /(?:^|\s)\+units=([^\s]+)/i.exec(definition)?.[1]?.toLowerCase();
  if (unit === undefined) return PROJ_UNITS.m;
  return Object.hasOwn(PROJ_UNITS, unit) ? PROJ_UNITS[unit] : null;
}

/** Resolve proj4's native projected unit to metres; `null` for an unknown unit. */
export function projectedUnitToMetres(definition: string): number | null {
  return projectedLinearUnit(definition)?.toMetres ?? null;
}
