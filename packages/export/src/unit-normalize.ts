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
 *   `IFCAREAMEASURE(x)` (× area), `IFCVOLUMEMEASURE(x)` (× volume), wherever they
 *   appear outside a quoted string.
 *
 * ## What is NOT rescaled
 * - Unit-definition entities (`IfcSIUnit`, `IfcConversionBasedUnit`,
 *   `IfcMeasureWithUnit`, `IfcUnitAssignment`, …): their numbers define units, not
 *   data, and must survive verbatim.
 * - Georeferencing (`IfcMapConversion`): its offsets are in the map/CRS unit,
 *   independent of the project length unit.
 * - A quantity or property that carries its own explicit unit reference (`Unit`,
 *   or `DefiningUnit`/`DefinedUnit` on `IfcPropertyTableValue`): its value is
 *   already in that unit, not the global one.
 * - Angles, direction ratios, plain `IfcReal` ratios and counts — never typed as a
 *   length/area/volume measure, so they are excluded automatically.
 */

import { getAllAttributesForEntity } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-serialization.js';

/** IFC defined types whose values are lengths (STEP writes them as bare reals). */
const LENGTH_MEASURE_TYPES = new Set([
  'IfcLengthMeasure',
  'IfcPositiveLengthMeasure',
  'IfcNonNegativeLengthMeasure',
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
 * Per-entity plan: which STEP attribute indices carry a length / area / volume,
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
  /**
   * Indices of unit-override attributes (`Unit` / `DefiningUnit` / `DefinedUnit`,
   * typed IfcNamedUnit or the IfcUnit SELECT). When ANY of them is a live
   * reference (not `$`), the entity's value(s) carry their own unit and must NOT
   * be rescaled to the global unit.
   */
  unitGuardIdx: number[];
  /** True when there is neither a value to scale nor a unit override to consider. */
  empty: boolean;
}

const EMPTY_PLAN: EntityLengthPlan = {
  listIdx: [], scalarIdx: [], areaIdx: [], volumeIdx: [], unitGuardIdx: [], empty: true,
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
 * Derive (and cache) the length/area/volume attribute plan for an uppercase STEP
 * type name from the generated schema registry. Excluded types (unit definitions,
 * georeferencing) and unknown/abstract types return the empty plan.
 */
export function getEntityLengthPlan(typeUpper: string): EntityLengthPlan {
  const cached = planCache.get(typeUpper);
  if (cached !== undefined) return cached;
  const plan = buildEntityLengthPlan(typeUpper);
  planCache.set(typeUpper, plan);
  return plan;
}

function buildEntityLengthPlan(typeUpper: string): EntityLengthPlan {
  if (isRescaleExcluded(typeUpper)) return EMPTY_PLAN;

  const attrs = getAllAttributesForEntity(typeUpper);
  if (!attrs || attrs.length === 0) return EMPTY_PLAN;

  const listIdx: number[] = [];
  const scalarIdx: number[] = [];
  const areaIdx: number[] = [];
  const volumeIdx: number[] = [];
  const unitGuardIdx: number[] = [];

  attrs.forEach((a, i) => {
    const { base, isList } = attrBaseType(a.type, a);
    if (LENGTH_MEASURE_TYPES.has(base)) {
      if (isList) listIdx.push(i);
      else scalarIdx.push(i);
    } else if (base === 'IfcAreaMeasure' && !isList) {
      areaIdx.push(i);
    } else if (base === 'IfcVolumeMeasure' && !isList) {
      volumeIdx.push(i);
    }
    // A quantity's Unit is typed IfcNamedUnit; a property's Unit is the IfcUnit
    // SELECT; an IfcPropertyTableValue uses DefiningUnit/DefinedUnit. Any of them,
    // when set, means the value carries its own unit.
    if (UNIT_GUARD_NAMES.has(a.name) && (base === 'IfcNamedUnit' || base === 'IfcUnit')) {
      unitGuardIdx.push(i);
    }
  });

  const empty = listIdx.length === 0 && scalarIdx.length === 0
    && areaIdx.length === 0 && volumeIdx.length === 0 && unitGuardIdx.length === 0;
  return empty ? EMPTY_PLAN : { listIdx, scalarIdx, areaIdx, volumeIdx, unitGuardIdx, empty };
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
  const s = parseFloat(v.toPrecision(12)).toString();
  const e = s.indexOf('e');
  if (e !== -1) {
    let mantissa = s.slice(0, e);
    const exp = s.slice(e + 1);
    if (!mantissa.includes('.')) mantissa += '.';
    return `${mantissa}E${exp}`;
  }
  return s.includes('.') ? s : s + '.';
}

/**
 * Single token matcher used by {@link scaleNumberLiterals}: a full STEP string
 * (kept verbatim, honouring the `''` escape), a `#`-reference (kept verbatim), or
 * a REAL/INTEGER literal (rescaled). Ordering matters — strings and refs are
 * matched first so their inner digits are never treated as numbers. The number
 * alternative consumes an optional exponent as one token, so `1.E-5` / `-2.5E2`
 * scale the mantissa without touching the exponent digits.
 */
const NUMBER_TOKEN_RE = /'(?:[^']|'')*'|#\d+|[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/g;

/**
 * Multiply every bare numeric literal in `text` by `factor`, leaving quoted
 * strings and `#`-references untouched. O(n) single pass — safe for the large
 * coordinate lists of tessellated geometry.
 */
export function scaleNumberLiterals(text: string, factor: number): string {
  return text.replace(NUMBER_TOKEN_RE, (tok) => {
    const c = tok.charCodeAt(0);
    if (c === 0x27 /* ' */ || c === 0x23 /* # */) return tok;
    return toStepRealScaled(parseFloat(tok) * factor);
  });
}

/**
 * Scale the typed measures embedded in property/quantity values. Matches
 * `IFC[POSITIVE|NONNEGATIVE]LENGTHMEASURE(x)` (× lengthFactor), `IFCAREAMEASURE(x)`
 * (× areaFactor) and `IFCVOLUMEMEASURE(x)` (× volumeFactor), but never inside a
 * quoted string (the string alternative is matched first and returned verbatim).
 *
 * A single non-word delimiter (`(`, `,`, whitespace, or start-of-input) is
 * captured before the keyword and restored, so a keyword can never be matched as
 * the suffix of a longer identifier — without a lookbehind, which some engines
 * (older Safari) reject at construction time and would break importing this module.
 */
const TYPED_MEASURE_RE =
  /('(?:[^']|'')*')|(^|[^A-Za-z0-9_])(IFC(?:POSITIVE|NONNEGATIVE)?LENGTHMEASURE|IFCAREAMEASURE|IFCVOLUMEMEASURE)\(([^)]*)\)/gi;

export function scaleTypedMeasures(
  text: string,
  lengthFactor: number,
  areaFactor: number,
  volumeFactor: number,
): string {
  return text.replace(
    TYPED_MEASURE_RE,
    (full, str, delim, keyword, num) => {
      if (str !== undefined) return full; // inside a quoted string
      const kw = keyword.toUpperCase();
      const factor = kw === 'IFCAREAMEASURE' ? areaFactor
        : kw === 'IFCVOLUMEMEASURE' ? volumeFactor
        : lengthFactor; // any *LENGTHMEASURE
      return `${delim}${keyword}(${scaleMeasureNumber(num, factor)})`;
    },
  );
}

/** Scale the numeric content of one typed-measure token, preserving non-numeric ($) content. */
function scaleMeasureNumber(num: string, factor: number): string {
  const trimmed = num.trim();
  const n = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(n)) return num;
  return toStepRealScaled(n * factor);
}

/** Scale a single scalar attribute token by `factor` (skips `$`/`*`/non-bare-number). */
function scaleScalarArg(arg: string, factor: number): string {
  const trimmed = arg.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*') return arg;
  const n = Number(trimmed);
  // Only a bare real is a directly-typed length; a typed token (IFC…MEASURE(…))
  // is left to the measure pass, so it is never scaled twice.
  if (!Number.isFinite(n)) return arg;
  return toStepRealScaled(n * factor);
}

/**
 * Locate the outer STEP argument list of one entity line: the first `(` (nothing
 * is quoted before the type name) and its matching `)`, honouring quoted strings
 * (with the `''` escape) so a literal `)` inside a string never closes early.
 * Returns `null` for a line without arguments.
 */
function findOuterArgs(line: string): { open: number; close: number } | null {
  const open = line.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "'") {
        if (line[i + 1] === "'") i++; // escaped quote
        else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/**
 * Rescale every length/area/volume-valued datum of one STEP entity line.
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
): string {
  if (lengthFactor === 1 && areaFactor === 1 && volumeFactor === 1) return line;
  if (!Number.isFinite(lengthFactor) || !Number.isFinite(areaFactor) || !Number.isFinite(volumeFactor)) return line;
  if (isRescaleExcluded(typeUpper)) return line;

  const plan = getEntityLengthPlan(typeUpper);
  const hasStructural = plan.listIdx.length > 0 || plan.scalarIdx.length > 0
    || plan.areaIdx.length > 0 || plan.volumeIdx.length > 0;

  // Fast path: nothing structural, no unit override to weigh, and no typed measure.
  if (!hasStructural && plan.unitGuardIdx.length === 0 && !line.includes('MEASURE')) return line;

  const bounds = findOuterArgs(line);
  if (!bounds) return line;
  let inner = line.slice(bounds.open + 1, bounds.close);

  let skipValues = false;
  if (hasStructural || plan.unitGuardIdx.length > 0) {
    const args = splitTopLevelStepArguments(inner);

    // A live unit-override reference means the value is already in its own unit.
    skipValues = plan.unitGuardIdx.some((idx) => {
      const u = args[idx]?.trim();
      return u !== undefined && u !== '' && u !== '$' && u !== '*';
    });

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
      inner = args.join(',');
    }
  }

  // Typed measures live in property/quantity value slots (an IfcValue SELECT is
  // written with its explicit type). Skipped when the entity declares its own unit.
  if (!skipValues && inner.includes('MEASURE')) {
    inner = scaleTypedMeasures(inner, lengthFactor, areaFactor, volumeFactor);
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
