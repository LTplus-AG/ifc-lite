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
 * through `findUnitId`), and the module-size budget is not a thing to raise.
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

/**
 * Canonicalize a map-unit label to the spelling the rest of this module
 * compares against: American `METER` to `METRE`, feet to `FOOT`, and an SI
 * prefix kept rather than swallowed.
 *
 * The prefix test is an EXACT match on `<PREFIX>METRE`, not a substring test.
 * A substring test is what silently turned `MILLIMETRE`, `CENTIMETRE` and
 * `KILOMETRE` into `METRE` (#3274) — all three contain `METRE`. Anything not
 * recognised is returned as-is, for the caller to refuse rather than guess.
 */
export function normalizeMapUnitName(unitName: string): string {
  const normalized = unitName.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalized.includes('US SURVEY FOOT')) return 'US SURVEY FOOT';
  if (normalized.includes('FOOT') || normalized.includes('FEET')) return 'FOOT';
  // `METER` is the same unit under the American spelling, at any prefix.
  const metric = normalized.replace(/METERS?$/, 'METRE').replace(/METRES$/, 'METRE');
  if (siPrefixOf(metric) !== undefined) return metric;
  return normalized;
}

/**
 * `effective` filters the candidates the same way the georef reads above do:
 * returning a tombstoned unit id hands the caller a `#id` for a line the
 * export never writes. Returning null instead makes `resolveMapUnitReference`
 * synthesise a fresh unit, which is the outcome a deleted unit deserves.
 */
export function findLengthUnitReference(preferredUnitName: string, effective: EffectiveEntityIndex, ctx: GeorefLookupContext): number | null {
  if (!ctx.entityExtractor) return null;

  // Only source records carry the bytes `extractEntity` reads, so an
  // overlay-created project is skipped rather than shadowing the file's own.
  const projectId = (effective.byType.get('IFCPROJECT') ?? []).find((id) => ctx.dataStore.entityIndex.byId.has(id));
  const projectRef = projectId !== undefined ? ctx.dataStore.entityIndex.byId.get(projectId) : undefined;
  const project = projectRef ? ctx.entityExtractor.extractEntity(projectRef) : null;
  const unitAssignmentId = project?.attributes?.[8];
  if (typeof unitAssignmentId !== 'number' || effective.isDeleted(unitAssignmentId)) return null;

  const unitAssignmentRef = ctx.dataStore.entityIndex.byId.get(unitAssignmentId);
  const unitAssignment = unitAssignmentRef ? ctx.entityExtractor.extractEntity(unitAssignmentRef) : null;
  const units = unitAssignment?.attributes?.[0];
  if (!Array.isArray(units)) return null;

  for (const unitId of units) {
    if (typeof unitId !== 'number' || effective.isDeleted(unitId)) continue;
    const unitRef = ctx.dataStore.entityIndex.byId.get(unitId);
    const unit = unitRef ? ctx.entityExtractor.extractEntity(unitRef) : null;
    if (!unit) continue;

    const typeName = unit.type.toUpperCase();
    const attrs = unit.attributes ?? [];
    const unitType = typeof attrs[1] === 'string' ? attrs[1].replace(/\./g, '').toUpperCase() : '';
    if (unitType !== 'LENGTHUNIT') continue;

    if (typeName === 'IFCSIUNIT') {
      const prefix = typeof attrs[2] === 'string' ? attrs[2].replace(/\./g, '').toUpperCase() : '';
      const name = typeof attrs[3] === 'string' ? attrs[3].replace(/\./g, '').toUpperCase() : '';
      // The prefix is part of the unit, so it is part of the comparison. The
      // old test asked only whether the preferred name was `METRE` and the
      // file's unit was a metre of any prefix, which both missed a reusable
      // `.MILLI.` unit and would have matched one for a plain-metre request
      // had `combined` been read (#3274).
      const combined = prefix ? `${prefix}${name}` : name;
      if (normalizeMapUnitName(combined) === preferredUnitName) {
        return unitId;
      }
    }

    if (typeName === 'IFCCONVERSIONBASEDUNIT') {
      const name = typeof attrs[2] === 'string' ? normalizeMapUnitName(attrs[2]) : '';
      if (name === preferredUnitName) {
        return unitId;
      }
    }
  }

  return null;
}
