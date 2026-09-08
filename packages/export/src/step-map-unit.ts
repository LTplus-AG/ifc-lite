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

/** Split a map-unit label into upper-cased alphanumeric tokens. */
function tokenizeUnitLabel(label: string): string[] {
  return label.toUpperCase().split(/[^A-Z0-9]+/).filter((token) => token.length > 0);
}

/** The foot/feet spellings a US-survey qualifier may be attached to. */
const FOOT_TOKENS = new Set(['FOOT', 'FEET', 'FT']);

/**
 * Order-insensitive recogniser for the separated US-survey foot spellings —
 * `foot (US survey)`, `SURVEY FEET (US)`, `US survey foot`. The glued
 * spellings (`USSURVEYFOOT`, `FTUS`, …) are in {@link MAP_UNIT_CANONICAL_NAME}
 * and matched exactly there; once an exporter puts separators in, the word
 * order varies and gluing alone cannot see it.
 *
 * Accepts exactly one foot token plus either `US` (or the glued `USSURVEY`)
 * or both `US` and `SURVEY`. A bare `SURVEY FOOT` without `US` is REFUSED:
 * other national survey feet exist and are different ratios — Clarke's foot is
 * 0.3047972654 m, the Indian foot 0.304799514 m — so the qualifier alone does
 * not identify a value. `US FOOT` on its own IS accepted: EPSG 9003 is the
 * only US foot, so the nationality does identify it.
 *
 * The requirement that exactly ONE foot token be present, with nothing else
 * beside the qualifier, is what refuses `SQUARE US SURVEY FOOT` (an area) and
 * `NON-US SURVEY FOOT` (a label that says it is not this unit).
 *
 * Sibling of `isUsSurveyFootTokens` in packages/parser/src/map-unit-label.ts
 * and `is_us_survey_foot_tokens` in rust/core/src/unit_labels.rs — those two
 * answer a metre scale for the georeferencing READER, this one answers the
 * canonical name the STEP writer emits, but the accepted spellings are the
 * same set and must stay the same set.
 */
function isUsSurveyFootTokens(tokens: string[]): boolean {
  const feet = tokens.filter((token) => FOOT_TOKENS.has(token));
  if (feet.length !== 1) return false;
  const rest = tokens.filter((token) => !FOOT_TOKENS.has(token));
  if (rest.length === 1) return rest[0] === 'US' || rest[0] === 'USSURVEY';
  return rest.length === 2 && rest.includes('US') && rest.includes('SURVEY');
}

/**
 * Exact-match table from a folded label to the canonical unit name the rest of
 * this module compares against. DERIVED rather than hand-written: the two base
 * spellings crossed with {@link SI_PREFIXES} — the same list {@link siPrefixOf}
 * reads, so the two cannot drift — plus the foot spellings this exporter can
 * write as an `IfcConversionBasedUnit`.
 *
 * A `Map` rather than an object literal so a label like `CONSTRUCTOR` cannot
 * resolve through `Object.prototype`.
 */
const MAP_UNIT_CANONICAL_NAME: Map<string, string> = (() => {
  const table = new Map<string, string>();
  for (const spelling of ['METRE', 'METER']) {
    table.set(spelling, 'METRE');
    for (const prefix of SI_PREFIXES) table.set(`${prefix}${spelling}`, `${prefix}METRE`);
  }
  for (const foot of ['FOOT', 'FEET']) table.set(foot, 'FOOT');
  // The US survey foot is a different ratio from the international foot
  // (1200/3937 vs 0.3048) and is spelled several ways in the wild. These are
  // the accepted glued spellings, matched exactly rather than sniffed for; the
  // separated ones go through {@link isUsSurveyFootTokens}.
  for (const alias of ['USSURVEYFOOT', 'USSURVEYFEET', 'USSURVEYFT', 'USFOOT', 'USFEET', 'USFT', 'FTUS']) {
    table.set(alias, 'US SURVEY FOOT');
  }
  return table;
})();

/**
 * Canonicalize a map-unit label to the spelling the rest of this module
 * compares against: American `METER` to `METRE`, the foot spellings to `FOOT`,
 * the US survey foot to `US SURVEY FOOT`, and an SI prefix kept rather than
 * swallowed. Anything not recognised is returned normalised-but-unchanged, for
 * the caller to REFUSE rather than guess at.
 *
 * The label is NORMALISED and then matched EXACTLY — never substring-matched.
 *
 * What the normalisation accepts:
 * - any case and any separators: `metres`, `Meters`, `MILLI-METRE`;
 * - `METRE` and `METER`, each carrying any `IfcSIPrefix` member;
 * - `FOOT` and `FEET`;
 * - one English plural suffix, stripped once and re-matched exactly;
 * - the US survey foot, glued or separated in any word order.
 *
 * What it REFUSES, by leaving the label alone so `resolveMapUnitReference`
 * returns `null` and `MapUnit` stays `$` with a warning:
 * - a label that merely CONTAINS a unit. `MILLIMETRE`, `CENTIMETRE` and
 *   `KILOMETRE` all contain `METRE`, and an `includes('METRE')` test wrote all
 *   three into the file as a plain `.METRE.` — a silent 1000x error in the CRS
 *   scale (#3274). The foot half of that same test was `includes('FOOT')`, and
 *   it was satisfied by `FOOTCANDLE` (an illuminance), `FOOT-POUND` (an
 *   energy), `FOOTPRINT`, and by `SQUARE FOOT` and `CUBIC FEET` — an area and
 *   a volume written as a LENGTH unit, which is a wrong DIMENSION rather than
 *   a wrong magnitude, and no scale factor can be right for it;
 * - a survey foot with no nationality: `SURVEY FOOT`, `CLARKE'S FOOT`,
 *   `INDIAN FOOT`, `SEARS FOOT`, `BRITISH FOOT (1936)` are five different
 *   ratios, and `includes('FOOT')` gave every one of them the international
 *   0.3048;
 * - `INCH`, `YARD`, `MILE` and anything else this exporter cannot express.
 *
 * Normalising a recognisable spelling onto a table entry is NOT that
 * approximation: the answer is still one exact table hit, so `MILLIMETERS`
 * resolves to `MILLIMETRE` and not to `METRE`.
 *
 * Sibling of `inferMapUnitScaleFromLabel` in
 * packages/parser/src/map-unit-label.ts and `infer_map_unit_scale` in
 * rust/core/src/unit_labels.rs, which apply these same rules on the reading
 * side. This exporter's accepted set is the smaller one — it writes only what
 * it can express as an `IfcNamedUnit` — but no spelling may be accepted here
 * that those refuse, or refused here that those accept as a length.
 */
export function normalizeMapUnitName(unitName: string): string {
  const normalized = unitName.trim().toUpperCase().replace(/\s+/g, ' ');
  const tokens = tokenizeUnitLabel(normalized);
  if (tokens.length === 0) return normalized;
  if (isUsSurveyFootTokens(tokens)) return 'US SURVEY FOOT';

  const key = tokens.join('');
  const exact = MAP_UNIT_CANONICAL_NAME.get(key);
  if (exact !== undefined) return exact;

  // One English plural suffix, removed once and re-matched exactly. `ES`
  // covers spellings whose singular is not reachable by dropping a single `S`.
  for (const suffix of ['S', 'ES']) {
    if (!key.endsWith(suffix)) continue;
    const singular = MAP_UNIT_CANONICAL_NAME.get(key.slice(0, -suffix.length));
    if (singular !== undefined) return singular;
  }
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
  // An empty label is not a unit name, and it is reachable: the caller guards
  // `crs.mapUnit !== undefined`, not `!== ''`, and `normalizeMapUnitName('')`
  // is `''`. Both comparisons below fold a non-string Name attribute to `''`
  // too, so without this an empty MapUnit binds to whichever unit happens to
  // have a malformed name rather than to nothing.
  if (preferredUnitName === '') return null;

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
