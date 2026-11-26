/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit normalization for merged STEP export (issue #1475).
 *
 * When {@link MergedExporter} runs with `unitReconciliation: 'normalize'`, every
 * non-primary model whose length unit differs from the primary model's has all
 * of its length-valued data rescaled into the primary unit, so the models can be
 * unified into ONE `IfcProject` with ONE `IfcUnitAssignment` (rather than
 * federated as separate, mutually mis-scaled projects).
 *
 * This module is the pure, text-level rescaler. It knows WHICH numeric attributes
 * of a STEP entity carry a length (and which carry an area/volume) by deriving the
 * answer from the generated IFC schema registry (`@ifc-lite/parser`
 * `getAllAttributesForEntity`) — the 0-based index into an entity's `allAttributes`
 * is exactly its 0-based STEP attribute index, and each attribute is typed. This
 * avoids a hand-maintained per-entity table and stays correct as the schema evolves.
 *
 * ## Factors
 * The caller passes three *independent* factors (a length datum × `lengthFactor`,
 * an area datum × `areaFactor`, a volume datum × `volumeFactor`). They are NOT
 * `lengthFactor` powers: IFC declares `AREAUNIT`/`VOLUMEUNIT` independently of
 * `LENGTHUNIT` (e.g. Revit exports millimetre lengths but square-/cubic-metre
 * areas/volumes), so each dimension is converted by the ratio of its own declared
 * unit. See {@link MergedExporter} for how the factors are derived.
 *
 * ## What is rescaled
 * - **Coordinate lists** — every number in a `LIST OF IfcLengthMeasure` attribute
 *   (`IfcCartesianPoint.Coordinates`, `IfcCartesianPointList2D/3D.CoordList`). × length.
 * - **Scalar lengths** — any attribute typed `IfcLengthMeasure` /
 *   `IfcPositiveLengthMeasure` / `IfcNonNegativeLengthMeasure` (extrusion depths,
 *   profile dimensions, radii, wall thicknesses, `IfcVector.Magnitude`, CSG
 *   primitive sizes, `IfcBuildingStorey.Elevation`, `IfcSite.RefElevation`,
 *   `IfcQuantityLength.LengthValue`, …). × length.
 * - **Areas / volumes** — `IfcQuantityArea.AreaValue` (× area),
 *   `IfcQuantityVolume.VolumeValue` (× volume).
 * - **Typed measures in property values** — `IFCLENGTHMEASURE(x)` /
 *   `IFCPOSITIVELENGTHMEASURE(x)` / `IFCNONNEGATIVELENGTHMEASURE(x)` (× length),
 *   `IFCAREAMEASURE(x)` (× area) and `IFCVOLUMEMEASURE(x)` (× volume).
 * - **Derived profile measures** — typed values and IFC2X3 profile attributes
 *   use the ratio of declared units when available and powers of length otherwise.
 *
 * ## What is NOT rescaled
 * - Unit-definition entities (`IfcSIUnit`, `IfcConversionBasedUnit`,
 *   `IfcMeasureWithUnit`, `IfcUnitAssignment`, …): their numbers define units, not
 *   data, and must survive verbatim.
 * - Georeferencing (`IfcMapConversion`): its offsets are in the map/CRS unit,
 *   independent of the project length unit. The merged exporter keeps every
 *   coordinate operation away from this rescale (`merged-georef-normalize.ts`).
 * - Values with an explicit unit (`Unit` for a quantity or property,
 *   `DefiningUnit` or `DefinedUnit` for its respective table column).
 * - Angles, direction ratios, plain `IfcReal` ratios and counts — never typed as a
 *   length/area/volume measure, so they are excluded automatically.
 */

import { getAllAttributesForEntity, getCanonicalEntityName, getSchemaRegistryForVersion, STEP_TRIVIA } from '@ifc-lite/parser';
import { formatStepReal } from '@ifc-lite/data';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { holdsValue } from './step-comment-skip.js';
import { findOuterArgs, mapOutsideStepStrings } from './step-outer-args.js';

/** IFC defined types whose values are lengths (STEP writes them as bare reals). */
const LENGTH_MEASURE_TYPES = new Set([
  'IfcLengthMeasure',
  'IfcPositiveLengthMeasure',
  'IfcNonNegativeLengthMeasure',
]);

export const PROFILE_MEASURE_POWERS: ReadonlyMap<string, number> = new Map([
  ['IFCMASSPERLENGTHMEASURE', -1],
  ['IFCMOMENTOFINERTIAMEASURE', 4],
  ['IFCSECTIONMODULUSMEASURE', 3],
  ['IFCWARPINGCONSTANTMEASURE', 6],
]);

/**
 * Entity types whose numeric content must NEVER be rescaled: unit definitions
 * (the numbers *are* the unit) and georeferencing (offsets live in the CRS unit).
 * `IFCMAPCONVERSION` is matched by prefix to also catch schema variants.
 */
const RESCALE_EXCLUDED_TYPES = new Set([
  'IFCUNITASSIGNMENT', 'IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT', 'IFCCONTEXTDEPENDENTUNIT',
  'IFCDERIVEDUNIT', 'IFCDERIVEDUNITELEMENT', 'IFCDIMENSIONALEXPONENTS', 'IFCMONETARYUNIT',
  'IFCMEASUREWITHUNIT',
]);

function isRescaleExcluded(typeUpper: string): boolean {
  return RESCALE_EXCLUDED_TYPES.has(typeUpper) || typeUpper.startsWith('IFCMAPCONVERSION');
}

/**
 * Per-entity plan: which STEP attribute indices carry dimensional values,
 * and where a self-describing unit override lives. Indices are 0-based STEP order.
 */
export interface EntityLengthPlan {
  /** Attributes that are a LIST of lengths (coordinate arrays) → scale all numbers. */
  listIdx: number[];
  /** Scalar length attributes → scale by the length factor. */
  scalarIdx: number[];
  /** Scalar area attributes → scale by the area factor. */
  areaIdx: number[];
  /** Scalar volume attributes → scale by the volume factor. */
  volumeIdx: number[];
  /** Scalar profile measures and their STEP type names. */
  profileMeasures: { index: number; measure: string }[];
  /**
   * Indices of unit-override attributes (`Unit` / `DefiningUnit` / `DefinedUnit`,
   * typed IfcNamedUnit or the IfcUnit SELECT). An explicit unit protects its
   * value or table column from rescaling.
   */
  unitGuardIdx: number[];
  /** True when there is neither a value to scale nor a unit override to consider. */
  empty: boolean;
}

const EMPTY_PLAN: EntityLengthPlan = {
  listIdx: [], scalarIdx: [], areaIdx: [], volumeIdx: [], profileMeasures: [], unitGuardIdx: [], empty: true,
};

/** Attribute names that hold a self-describing unit override for a value. */
const UNIT_GUARD_NAMES = new Set(['Unit', 'DefiningUnit', 'DefinedUnit']);

const planCache = new Map<string, EntityLengthPlan>();

/**
 * The base measure type of an attribute, and whether it is an aggregate. Handles
 * both the compact `"IfcLengthMeasure[]"` encoding and the rare raw EXPRESS form
 * (`"UNIQUE LIST [1:2] OF IfcLengthMeasure"`) the generated registry sometimes
 * carries — the base is the last `Ifc…` token, and an aggregate is signalled by
 * the flags, a `[]` suffix, or a `LIST`/`SET`/`ARRAY` keyword.
 */
function attrBaseType(type: string, flags: { isList: boolean; isArray: boolean; isSet: boolean }): { base: string; isList: boolean } {
  const match = type.match(/Ifc[A-Za-z0-9]+/g);
  const base = match ? match[match.length - 1] : type;
  const isList = flags.isList || flags.isArray || flags.isSet
    || /\[\]/.test(type) || /\b(?:LIST|SET|ARRAY|BAG)\b/i.test(type);
  return { base, isList };
}

/**
 * Derive (and cache) the dimensional attribute plan for an uppercase STEP
 * type name from the generated schema registry. Excluded types (unit definitions,
 * georeferencing) and unknown/abstract types return the empty plan.
 */
export function getEntityLengthPlan(typeUpper: string, legacySchema?: 'IFC2X3'): EntityLengthPlan {
  const key = legacySchema ? `${legacySchema}:${typeUpper}` : typeUpper;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;
  const plan = buildEntityLengthPlan(typeUpper, legacySchema);
  planCache.set(key, plan);
  return plan;
}

function sourceAttributes(typeUpper: string, legacySchema?: 'IFC2X3') {
  if (!legacySchema) return getAllAttributesForEntity(typeUpper);
  const registry = getSchemaRegistryForVersion(legacySchema);
  const name = getCanonicalEntityName(registry, typeUpper);
  return name ? registry.entities[name].allAttributes : undefined;
}

function buildEntityLengthPlan(typeUpper: string, legacySchema?: 'IFC2X3'): EntityLengthPlan {
  if (isRescaleExcluded(typeUpper)) return EMPTY_PLAN;

  let fields = sourceAttributes(typeUpper, legacySchema);
  if (!legacySchema && !fields?.length && typeUpper.endsWith('PROFILEPROPERTIES')) {
    fields = sourceAttributes(typeUpper, 'IFC2X3');
  }
  if (!fields?.length) return EMPTY_PLAN;

  const listIdx: number[] = [];
  const scalarIdx: number[] = [];
  const areaIdx: number[] = [];
  const volumeIdx: number[] = [];
  const profileMeasures: EntityLengthPlan['profileMeasures'] = [];
  const unitGuardIdx: number[] = [];

  fields.forEach((a, i) => {
    const { base, isList } = attrBaseType(a.type, a);
    const measure = base.toUpperCase();
    if (PROFILE_MEASURE_POWERS.has(measure) && !isList) profileMeasures.push({ index: i, measure });
    if (LENGTH_MEASURE_TYPES.has(base)) {
      if (isList) listIdx.push(i);
      else scalarIdx.push(i);
    } else if (base === 'IfcAreaMeasure' && !isList) {
      areaIdx.push(i);
    } else if (base === 'IfcVolumeMeasure' && !isList) {
      volumeIdx.push(i);
    }
    // A quantity's Unit is typed IfcNamedUnit; a property's Unit is the IfcUnit
    // SELECT; an IfcPropertyTableValue uses DefiningUnit/DefinedUnit.
    if (UNIT_GUARD_NAMES.has(a.name) && (base === 'IfcNamedUnit' || base === 'IfcUnit')) {
      unitGuardIdx.push(i);
    }
  });

  const empty = listIdx.length === 0 && scalarIdx.length === 0
    && areaIdx.length === 0 && volumeIdx.length === 0 && profileMeasures.length === 0 && unitGuardIdx.length === 0;
  return empty ? EMPTY_PLAN : { listIdx, scalarIdx, areaIdx, volumeIdx, profileMeasures, unitGuardIdx, empty };
}

/**
 * Format a number as a valid ISO-10303-21 STEP REAL, after a unit multiply.
 *
 * Rounds to 12 significant digits first to erase floating-point noise from the
 * multiply (e.g. `0.3048 * 100 = 30.479999999999997` → `30.48`) — 12 digits keeps
 * sub-micron precision at building scale. Always emits a decimal point, and
 * rewrites JavaScript's lowercase exponent (`1.5e-7`) into STEP's uppercase form
 * with a mantissa dot (`1.5E-7`), so small/large magnitudes stay parseable.
 */
export function toStepRealScaled(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  if (v === 0) return '0.'; // also normalizes -0
  // Round to 12 significant digits to erase the multiply's FP noise, then reuse
  // the shared mantissa/`E` rewrite so scaled and unscaled reals format alike.
  return formatStepReal(parseFloat(v.toPrecision(12)));
}

const NUMBER_SOURCE = /[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/.source;
const COMMENT_SOURCE = /\/\*[\s\S]*?(?:\*\/|$)/.source;
const NUMBER_TOKEN_RE = new RegExp(String.raw`${COMMENT_SOURCE}|#\d+|${NUMBER_SOURCE}`, 'g');

/** Scale coordinate literals and leave references, strings and comments intact. */
export function scaleNumberLiterals(text: string, factor: number): string {
  return mapOutsideStepStrings(text, (code) => code.replace(NUMBER_TOKEN_RE, (tok) =>
    tok.startsWith('#') || tok.startsWith('/') ? tok : toStepRealScaled(parseFloat(tok) * factor)));
}

const NUMERIC_SLOT = `(${STEP_TRIVIA})(${NUMBER_SOURCE})(${STEP_TRIVIA})`;
const BARE_MEASURE_RE = new RegExp(`^${NUMERIC_SLOT}$`);
// Consume other identifiers and comments whole so neither can contain a measure match.
const TYPED_MEASURE_RE = new RegExp(
  String.raw`(IFC(?:POSITIVE|NONNEGATIVE)?LENGTHMEASURE|IFCAREAMEASURE|IFCVOLUMEMEASURE|${[...PROFILE_MEASURE_POWERS.keys()].join('|')})(${STEP_TRIVIA})\(${NUMERIC_SLOT}\)|${COMMENT_SOURCE}|[A-Za-z0-9_]+`,
  'gi',
);

/** A profile measure's factor. NaN (`profileMeasureFactors`) is a declared unit whose scale cannot be resolved. */
function profileFactor(measure: string, profileFactors: ReadonlyMap<string, number> | undefined, lengthFactor: number): number {
  const factor = profileFactors?.get(measure) ?? lengthFactor ** (PROFILE_MEASURE_POWERS.get(measure) ?? 1);
  if (Number.isNaN(factor)) throw new Error(`Cannot normalize ${measure}: its declared unit scale cannot be resolved`);
  return factor;
}

export function scaleTypedMeasures(
  text: string,
  lengthFactor: number,
  areaFactor: number,
  volumeFactor: number,
  profileFactors?: ReadonlyMap<string, number>,
  preserveTrivia = false,
): string {
  return mapOutsideStepStrings(text, (code) => code.replace(
    TYPED_MEASURE_RE,
    (full, keyword, separator, before, num, after) => {
      if (keyword === undefined) return full;
      const kw = keyword.toUpperCase();
      const factor = kw === 'IFCAREAMEASURE' ? areaFactor
        : kw === 'IFCVOLUMEMEASURE' ? volumeFactor
        : profileFactor(kw, profileFactors, lengthFactor);
      if (preserveTrivia && factor === 1) return full;
      const scaled = scaleMeasureNumber(before, num, after, factor, preserveTrivia);
      return scaled === undefined ? full : `${keyword}${preserveTrivia || separator.includes('/*') ? separator : ''}(${scaled})`;
    },
  ));
}

/** Preserve surrounding comments, and whitespace when requested. */
function scaleMeasureNumber(before: string, num: string, after: string, factor: number, preserveTrivia = false): string | undefined {
  const n = Number(num);
  if (!Number.isFinite(n)) return undefined;
  const scaled = toStepRealScaled(n * factor);
  if (preserveTrivia) return `${before}${scaled}${after}`;
  return `${before.includes('/*') ? before : ''}${scaled}${after.includes('/*') ? after : ''}`;
}

function scaleScalarArg(arg: string, factor: number): string {
  const match = BARE_MEASURE_RE.exec(arg);
  return match ? scaleMeasureNumber(match[1], match[2], match[3], factor) ?? arg : arg;
}

/**
 * Rescale the dimensional data of one STEP entity line.
 *
 * `typeUpper` is the entity's uppercase STEP type (used for the schema-derived
 * plan). The line is expected to be a single `#id=TYPE(...);` statement. Returns
 * the input unchanged when all factors are `1`, the type is excluded (unit
 * definition / georeferencing), or there is nothing to scale.
 */
export function rescaleEntityLengths(
  line: string,
  typeUpper: string,
  lengthFactor: number,
  areaFactor: number,
  volumeFactor: number,
  profileFactors?: ReadonlyMap<string, number>,
  legacySchema?: 'IFC2X3',
): string {
  if (lengthFactor === 1 && areaFactor === 1 && volumeFactor === 1 && !profileFactors?.size) return line;
  if (!Number.isFinite(lengthFactor) || !Number.isFinite(areaFactor) || !Number.isFinite(volumeFactor)) return line;
  if (isRescaleExcluded(typeUpper)) return line;

  const plan = getEntityLengthPlan(typeUpper, legacySchema);
  const hasStructural = plan.listIdx.length > 0 || plan.scalarIdx.length > 0
    || plan.areaIdx.length > 0 || plan.volumeIdx.length > 0 || plan.profileMeasures.length > 0;

  // A unit override only matters when there is a dimensional value to scale.
  if (!hasStructural && !/measure/i.test(line)) return line;

  const bounds = findOuterArgs(line);
  if (!bounds) return line;
  let inner = line.slice(bounds.open + 1, bounds.close);

  let skipValues = false;
  if (hasStructural || plan.unitGuardIdx.length > 0) {
    const args = splitTopLevelStepArguments(inner);
    // NOT an unreachable invariant: `findOuterArgs` only guarantees SCAN-state
    // (balanced parens/quotes), while #4173 made `splitTopLevelStepArguments`
    // also reject a per-slot malformed VALUE, which a scan-clean span can
    // still fail. Unlike this module's siblings (`merged-context.ts`,
    // `merged-subcontext.ts`), which fall back to "unknown, don't unify" —
    // safe for a comparison — there is no permissive fallback for a unit
    // conversion: fail loudly rather than leave the data in the wrong unit.
    if (args === null) {
      throw new Error(
        `rescaleEntityLengths: cannot split "${typeUpper}"'s slots to rescale — refusing `
        + `to silently leave its dimensional data in the wrong unit: ${line}`,
      );
    }

    // A live unit-override reference means the value is already in its own unit.
    const hasExplicitUnit = (idx: number) => holdsValue(args[idx] ?? '');
    if (typeUpper === 'IFCPROPERTYTABLEVALUE') {
      // DefiningValues / DefiningUnit and DefinedValues / DefinedUnit.
      for (const [values, unit] of [[2, 5], [3, 6]] as const) {
        if (args[values] !== undefined && !hasExplicitUnit(unit)) {
          args[values] = scaleTypedMeasures(args[values], lengthFactor, areaFactor, volumeFactor, profileFactors, true);
        }
      }
      return line.slice(0, bounds.open + 1) + args.join(',') + line.slice(bounds.close);
    }
    skipValues = plan.unitGuardIdx.some(hasExplicitUnit);

    if (!skipValues && hasStructural) {
      for (const idx of plan.listIdx) {
        if (args[idx] !== undefined) args[idx] = scaleNumberLiterals(args[idx], lengthFactor);
      }
      for (const idx of plan.scalarIdx) {
        if (args[idx] !== undefined) args[idx] = scaleScalarArg(args[idx], lengthFactor);
      }
      for (const idx of plan.areaIdx) {
        if (args[idx] !== undefined) args[idx] = scaleScalarArg(args[idx], areaFactor);
      }
      for (const idx of plan.volumeIdx) {
        if (args[idx] !== undefined) args[idx] = scaleScalarArg(args[idx], volumeFactor);
      }
      for (const { index, measure } of plan.profileMeasures) {
        if (args[index] !== undefined && BARE_MEASURE_RE.test(args[index])) args[index] = scaleScalarArg(args[index], profileFactor(measure, profileFactors, lengthFactor));
      }
      inner = args.join(',');
    }
  }

  // Typed measures live in property/quantity value slots (an IfcValue SELECT is
  // written with its explicit type). Skipped when the entity declares its own unit.
  if (!skipValues && /measure/i.test(inner)) {
    inner = scaleTypedMeasures(inner, lengthFactor, areaFactor, volumeFactor, profileFactors);
  }

  return line.slice(0, bounds.open + 1) + inner + line.slice(bounds.close);
}

/**
 * Factor that converts a value expressed in `modelScale` units into `primaryScale`
 * units (both are SI-per-unit for the same dimension). Returns `1` when the units
 * already match or either scale is non-positive/non-finite.
 */
export function computeNormalizeFactor(modelScale: number, primaryScale: number): number {
  if (!Number.isFinite(modelScale) || !Number.isFinite(primaryScale)) return 1;
  if (modelScale <= 0 || primaryScale <= 0) return 1;
  if (modelScale === primaryScale) return 1;
  return modelScale / primaryScale;
}
