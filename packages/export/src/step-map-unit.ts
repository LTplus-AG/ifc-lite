/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map-unit resolution for the georeferencing phase: the `IfcNamedUnit` an
 * `IfcProjectedCRS.MapUnit` points at, and the reuse-or-synthesise decision
 * behind it.
 *
 * Split out of `step-georeferencing.ts` in #3274 rather than grown in place —
 * the question it answers is a different one from "which georeferencing
 * entities does this export write", it has a second caller in
 * `step-property-sets.ts` (property units reach `findLengthUnitReference`
 * through `findUnitId`), and raising the module-size budget instead would have
 * wanted a per-file justification in the PR; a split does not.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: a unit name is compared WHOLE. The
 * defect it was extracted for was a substring test — `normalized.includes('METRE')`
 * — which `MILLIMETRE`, `CENTIMETRE` and `KILOMETRE` all satisfy, so every one
 * of them was written into the file as a plain `.METRE.`. The map unit is the
 * scale of the entire coordinate reference system, so that is a silent 1000x
 * error in the one attribute another team uses to place the model on the
 * earth, and it is invisible in the output: a millimetre request produced
 * bytes identical to a metre request.
 *
 * And a unit this module cannot express is REFUSED, not approximated.
 * `IfcProjectedCRS.MapUnit` is `OPTIONAL IfcNamedUnit` with
 * `IsLengthUnit : NOT(EXISTS(MapUnit)) OR (MapUnit.UnitType = LENGTHUNIT)`, so
 * an absent MapUnit is schema-valid; a MapUnit naming the wrong unit is not
 * merely lossy, it is false, and nothing downstream can tell it from a true
 * one.
 */

import { findSourceProjectLengthUnit, normalizeMapUnitName } from '@ifc-lite/parser';
export { normalizeMapUnitName } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { toStepReal } from './step-serialization.js';
import type { GeorefContext, GeorefLookupContext } from './step-georeferencing.js';

/**
 * Message for the refusal when a requested map unit is one this exporter
 * cannot express as an `IfcNamedUnit`. `MapUnit` is optional, so it is left
 * absent rather than filled with a unit that is not the one asked for (#3274).
 */
export function mapUnitUnsupportedWarning(unitName: string): string {
  return `Cannot express map unit ${JSON.stringify(unitName)} as an IfcNamedUnit: only metres (with any SI prefix), FOOT and US SURVEY FOOT are supported. IfcProjectedCRS.MapUnit was left unset rather than declared as metres.`;
}

/** Record a map unit the exporter refused to guess at. */
export function reportMapUnitUnsupported(warnings: string[], unitName: string): void {
  const message = mapUnitUnsupportedWarning(unitName);
  warnings.push(message);
  console.warn(`[StepExporter] ${message}`);
}

export function resolveMapUnitReference(unitName: string, newGeorefLines: string[], effective: EffectiveEntityIndex, ctx: GeorefContext): number | null {
  const normalized = normalizeMapUnitName(unitName);
  const existing = findLengthUnitReference(normalized, effective, ctx);
  if (existing !== null) {
    return existing;
  }

  // A metre, with or without an SI prefix. `MILLIMETRE` KEEPS its prefix: the
  // map unit is the scale of the entire coordinate reference system, so
  // writing `.METRE.` for a millimetre map is a silent 1000x error in the one
  // attribute another team relies on to place the model (#3274).
  const prefix = siPrefixOf(normalized);
  if (prefix !== undefined) {
    const unitId = ctx.allocateExpressId();
    const prefixToken = prefix === null ? '$' : `.${prefix}.`;
    newGeorefLines.push(`#${unitId}=IFCSIUNIT(*,.LENGTHUNIT.,${prefixToken},.METRE.);`);
    return unitId;
  }

  if (normalized === 'FOOT' || normalized === 'US SURVEY FOOT') {
    const dimId = ctx.allocateExpressId();
    const siUnitId = ctx.allocateExpressId();
    const measureId = ctx.allocateExpressId();
    const convUnitId = ctx.allocateExpressId();
    const factor = normalized === 'US SURVEY FOOT' ? 1200 / 3937 : 0.3048;
    const name = normalized === 'US SURVEY FOOT' ? 'US SURVEY FOOT' : 'FOOT';
    newGeorefLines.push(`#${dimId}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);`);
    newGeorefLines.push(`#${siUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    newGeorefLines.push(`#${measureId}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${toStepReal(factor)}),#${siUnitId});`);
    newGeorefLines.push(`#${convUnitId}=IFCCONVERSIONBASEDUNIT(#${dimId},.LENGTHUNIT.,'${name}',#${measureId});`);
    return convUnitId;
  }

  // A unit this exporter cannot express. It must NOT claim to be metres: that
  // is the coordinate reference system's scale, and a wrong one is worse than
  // an absent one. `IfcProjectedCRS.MapUnit` is `OPTIONAL IfcNamedUnit`, and
  // the WHERE rule is `NOT(EXISTS(MapUnit)) OR MapUnit.UnitType = LENGTHUNIT`,
  // so omitting it is schema-valid. Refuse, and let the caller say so in
  // `stats.warnings` the way the two map-conversion refusals do (#3274).
  return null;
}

/** Every `IfcSIPrefix` member, longest first so `MILLI` cannot shadow `MILLIMICRO`-style
 *  compounds and `DECA` cannot shadow `DECI`. */
const SI_PREFIXES = [
  'FEMTO', 'MICRO', 'HECTO', 'CENTI', 'MILLI',
  'EXA', 'PETA', 'TERA', 'GIGA', 'MEGA', 'KILO', 'DECA', 'DECI', 'NANO', 'PICO', 'ATTO',
] as const;

/**
 * The `IfcSIPrefix` token for a normalized metre name — `null` for a bare
 * `METRE`, the prefix for a prefixed one, and `undefined` when the name is not
 * a metre at all.
 *
 * Three-valued deliberately: `null` and `undefined` are the two answers a bare
 * boolean would merge, and merging them is the defect — `MILLIMETRE` reaching
 * the "plain metre" arm is exactly what {@link normalizeMapUnitName}'s old
 * `includes('METRE')` test did.
 */
function siPrefixOf(normalized: string): string | null | undefined {
  if (normalized === 'METRE') return null;
  for (const prefix of SI_PREFIXES) {
    if (normalized === `${prefix}METRE`) return prefix;
  }
  return undefined;
}

/** Existing exporter entry point delegates eligibility and exact label matching
 * to the canonical reader/writer resolver. */
export function findLengthUnitReference(preferredUnitName: string, effective: EffectiveEntityIndex, ctx: GeorefLookupContext): number | null {
  if (!ctx.entityExtractor) return null;
  return findSourceProjectLengthUnit(preferredUnitName, ctx.dataStore,
    effective.byType.get('IFCPROJECT') ?? [], id => effective.isDeleted(id));
}
