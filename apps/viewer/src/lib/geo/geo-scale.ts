/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute the effective horizontal scale to apply to viewer-space coordinates
 * (which are already in metres) when transforming through IfcMapConversion.
 *
 * Per the IFC schema, IfcMapConversion.Scale converts LOCAL ENGINEERING
 * coordinates (in the project's length unit) to MAP coordinates (in the map
 * CRS unit). For a typical file with mm project units and m map units, the
 * Scale attribute is 0.001.
 *
 * The IFC formula is:
 *   E_map_units = Eastings + (X_local * absc - Y_local * ordi) * Scale
 *
 * To produce metres for proj4, we multiply by mapUnitScale; and X_local can be
 * recovered from the metre-converted geometry as X_metres / lengthUnitScale.
 * Substituting:
 *   E_metres = mapUnitScale * Eastings
 *            + (mapUnitScale * Scale / lengthUnitScale)
 *              * (X_metres * absc - Y_metres * ordi)
 *
 * So when geometry has already been converted to metres (as ifc-lite does),
 * the effective horizontal scale is (Scale * mapUnitScale) / lengthUnitScale.
 * For files where Scale is set per IFC spec to bridge the unit difference
 * (Scale = lengthUnitScale / mapUnitScale), this evaluates to 1.0 and the
 * geometry passes through unchanged. Applying the raw Scale would otherwise
 * double-scale and shrink/expand the model — see issue #595.
 */
export function getEffectiveHorizontalScale(
  ifcMapConversionScale: number | undefined,
  mapUnitScale: number,
  lengthUnitScale: number,
): number {
  return getEffectiveAxisScales({ scale: ifcMapConversionScale }, mapUnitScale, lengthUnitScale).x;
}

/** The Scale and IfcMapConversionScaled factors a placement reads. */
export type ScaleFields = { scale?: number; factorX?: number; factorY?: number; factorZ?: number };
type Axis = 'x' | 'y' | 'z';
type AxisScales = Record<Axis, number>;
const AXES: readonly Axis[] = ['x', 'y', 'z'];
const FACTOR_KEY = { x: 'factorX', y: 'factorY', z: 'factorZ' } as const;
const FACTOR_NAME = { x: 'FactorX', y: 'FactorY', z: 'FactorZ' } as const;
/** An IfcMapConversionScaled factor attribute, by its EXPRESS name. */
export type FactorName = (typeof FACTOR_NAME)[Axis];
/** The factors the conversion authors at a value other than exactly 1, by name. */
export function authoredNonUnitFactors(conversion: ScaleFields): FactorName[] {
  return AXES.filter((a) => (conversion[FACTOR_KEY[a]] ?? 1) !== 1).map((a) => FACTOR_NAME[a]);
}
/** A coefficient this close to 1 bridges the units (and raises no warning). */
const NEAR_UNITY = 0.005;
const offUnity = (value: number) => Math.abs(value - 1);
const worstAxis = (s: AxisScales): Axis => AXES.reduce((a, b) => (offUnity(s[b]) > offUnity(s[a]) ? b : a));

/** `Scale x Factor x mapUnitScale / lengthUnitScale` per axis, an absent value read as 1. */
function specAxisScales(c: ScaleFields, mus: number, lus: number): AxisScales {
  // Divide last: (1 * 0.3048 * 1) / 0.3048 is exactly 1.
  const axis = (a: Axis) => ((c.scale ?? 1) * (c[FACTOR_KEY[a]] ?? 1) * mus) / lus;
  return { x: axis('x'), y: axis('y'), z: axis('z') };
}

/**
 * Effective per-axis scales for metre viewer geometry (Scale, or Scale x
 * FactorX/Y/Z for IfcMapConversionScaled). The single home of the #595 rule.
 *
 * Spec: Scale converts LOCAL ENGINEERING coords (project length unit) to MAP
 * coords (MapUnit). Geometry is already metres, so the effective coefficient
 * is (Scale * mapUnitScale) / lengthUnitScale; a file with mm project units
 * and m map units MUST set Scale=0.001, and the coefficient evaluates to 1.
 *
 * Reality: Bonsai/IfcOpenShell, Revit's IFC exporter, and many CAD tools
 * either leave Scale unset (default 1.0) or hard-code Scale=1 regardless of
 * unit pairing. The author's intent is "geometry and offsets share the same
 * metric unit", but the spec-strict formula then multiplies viewer metres by
 * 1/lengthUnitScale (1000x for mm projects), far enough that proj4
 * extrapolates to the antipode (Hans's `IXAS_KW 018_georeffed.ifc`:
 * 126500/480000 RD offsets + mm units + Scale unset → South Pacific instead of
 * the Netherlands). Files that genuinely use Scale ≠ 1 followed the spec.
 *
 * So the heuristic is decided ONCE for the conversion, then each axis keeps
 * its own factor. It fires when Scale is absent or 1 (NaN included), the
 * project and map units differ, and no authored factor already bridges them:
 * - Scale 1 with factors (1, 1, 1) in a mm project places like the plain
 *   IFCMAPCONVERSION, at 1;
 * - Scale absent with grid factors (0.9996, 0.9996, 1) keeps them, on every axis;
 * - Scale 1 or absent with factors 0.3048 in a feet project bridges the units
 *   and places at 1;
 * - an explicit non-unit Scale (0.001 in a mm project) is spec-strict, and a
 *   factor scales on top of it.
 */
export function getEffectiveAxisScales(
  conversion: ScaleFields,
  mapUnitScale: number,
  lengthUnitScale: number,
): AxisScales {
  const lus = lengthUnitScale > 0 ? lengthUnitScale : 1;
  const mus = mapUnitScale > 0 ? mapUnitScale : 1;
  const spec = specAxisScales(conversion, mus, lus);
  const scaleUnset = !(conversion.scale != null && Math.abs(conversion.scale - 1) > 1e-9);
  const factorBridgesUnits = AXES.some(
    (a) => conversion[FACTOR_KEY[a]] !== undefined && offUnity(spec[a]) <= NEAR_UNITY,
  );
  if (!scaleUnset || Math.abs(mus - lus) <= 1e-9 || factorBridgesUnits) return spec;
  return { x: conversion.factorX ?? 1, y: conversion.factorY ?? 1, z: conversion.factorZ ?? 1 };
}

export interface ScaleUnitMismatch {
  /**
   * Scale ifc-lite ACTUALLY applies to viewer-space (metre) geometry on the
   * reported axis — {@link getEffectiveAxisScales}, heuristic included.
   */
  effectiveScale: number;
  /**
   * Scale the spec-strict formula implies on the reported axis,
   * `(Scale × Factor × mapUnitScale) / lengthUnitScale`. Differs from
   * `effectiveScale` exactly when the unset-Scale heuristic fired.
   */
  specEffectiveScale: number;
  /**
   * True when that heuristic already neutralised the file's deviation, i.e.
   * `effectiveScale ≈ 1` while `specEffectiveScale` is not. The file is still
   * off-spec (worth telling the author, because a spec-strict tool WILL render
   * it at `specEffectiveScale`), but nothing is mis-sized here — callers must
   * not claim otherwise. Issue #2526: the panel reported "Geometry is being
   * placed at 1000× its physical size" about geometry ifc-lite places at
   * exactly 1×. It was the only warning that file raised, so it sent the
   * reader chasing a non-problem while the real placement defect went
   * unmentioned.
   */
  compensated: boolean;
  /**
   * The attribute to change on the reported axis. Scale when compensated or
   * when every axis reads the same (changing it fixes all of them); otherwise that axis's
   * IfcMapConversionScaled factor, since a new Scale would move the axes that
   * are already right.
   */
  attribute: 'Scale' | FactorName;
  /** The file's value of `attribute` (absent reads as 1). */
  authoredValue: number;
  /**
   * The value of `attribute` that brings the reported axis to 1. For Scale:
   * lengthUnitScale / mapUnitScale, divided by that axis's factor.
   */
  expectedValue: number;
  /** Map unit → metres factor (e.g. 1 for METRE, 0.001 for MILLIMETRE). */
  mapUnitScale: number;
  /** Project length unit → metres factor. */
  lengthUnitScale: number;
}

/**
 * Detect when IfcMapConversion.Scale (times any IfcMapConversionScaled factor)
 * is inconsistent with the project and map units. Per the IFC schema,
 * Scale × mapUnitScale should equal lengthUnitScale (i.e. an effective scale
 * of 1.0). A deviation usually means the authoring tool forgot to set Scale to
 * bridge a unit difference (e.g. mm project + m map with Scale=1.0). Files
 * like this render at the wrong size in any tool that follows the schema
 * strictly — see issue #595.
 *
 * Every axis is checked (#4615). The numbers reported are for the axis ifc-lite
 * draws furthest from 1, or, when every axis is compensated, the axis furthest
 * from 1 on paper. Returns null when all are consistent (within 0.5% of 1.0).
 * Read `compensated` before choosing the wording: when it is true, the
 * deviation is an authoring defect that ifc-lite absorbs, and the only true
 * statement left to make is about what OTHER tools will do with it.
 */
export function detectScaleUnitMismatch(
  conversion: ScaleFields,
  mapUnitScale: number | undefined,
  lengthUnitScale: number | undefined,
): ScaleUnitMismatch | null {
  const lus = lengthUnitScale && lengthUnitScale > 0 ? lengthUnitScale : 1;
  const mus = mapUnitScale && mapUnitScale > 0 ? mapUnitScale : 1;
  const spec = specAxisScales(conversion, mus, lus);
  const specAxis = worstAxis(spec);
  if (offUnity(spec[specAxis]) <= NEAR_UNITY) return null;
  // Report an axis ifc-lite still draws off-size before one it compensates,
  // so a compensated Z cannot hide X and Y placed at 0.5.
  const placed = getEffectiveAxisScales(conversion, mus, lus);
  const placedAxis = worstAxis(placed);
  const compensated = offUnity(placed[placedAxis]) <= NEAR_UNITY;
  const [axis, scales] = compensated ? [specAxis, spec] : [placedAxis, placed];
  // Advise Scale only when the axes agree (#4675): with Scale 1 x FactorZ 2 in
  // a metre file, Scale 0.5 would halve X and Y, and FactorZ 1 is the fix.
  // When compensated, always Scale: a factor that bridges the units switches
  // the #595 rule off for every axis, which would mis-size a file drawn right.
  const reported = scales[axis];
  const factor = conversion[FACTOR_KEY[axis]] ?? 1;
  const uniform = AXES.every((a) => Math.abs(scales[a] - reported) <= NEAR_UNITY * Math.abs(reported));
  const fix = compensated || uniform
    ? { attribute: 'Scale' as const, authoredValue: conversion.scale ?? 1.0, expectedValue: lus / mus / factor }
    : { attribute: FACTOR_NAME[axis], authoredValue: factor, expectedValue: factor / reported };
  return {
    effectiveScale: placed[axis],
    specEffectiveScale: spec[axis],
    compensated,
    ...fix,
    mapUnitScale: mus,
    lengthUnitScale: lus,
  };
}

export function inferMapUnitScale(
  mapUnit: string | undefined,
  fallback?: number,
): number | undefined {
  if (!mapUnit) return fallback;
  const normalized = mapUnit.toUpperCase();
  if (normalized.includes('US') && (normalized.includes('SURVEY') || normalized.includes('FTUS'))) {
    // 1200/3937 m exactly, the parser's and Rust core's one value (#7775).
    return 1200 / 3937;
  }
  if (normalized.includes('FOOT') || normalized.includes('FEET')) return 0.3048;
  if (normalized.includes('MILLI')) return 0.001;
  if (normalized.includes('CENTI')) return 0.01;
  if (normalized.includes('DECI')) return 0.1;
  if (normalized.includes('KILO')) return 1000;
  if (normalized.includes('METRE') || normalized.includes('METER')) return 1;
  return fallback;
}

/**
 * Resolve the scale factor converting `IfcMapConversion.eastings/northings/
 * orthogonalHeight` into metres (the unit proj4 expects).
 *
 * IFC4 spec: those offsets are in `IfcProjectedCRS.MapUnit`, falling back to
 * the project's `IfcUnitAssignment` LengthUnit when MapUnit is absent.
 *
 * Real-world practice diverges: Bonsai, IfcOpenShell, and most surveying
 * pipelines emit metre values regardless of the project's length unit because
 * survey CRS offsets come in metres. When MapUnit is absent AND the project
 * unit isn't metres, applying the spec interpretation pushes coords miles
 * outside the CRS's valid range, and projections like RD New / OSGB / Lambert
 * extrapolate to the projection's antipode (e.g. an RD easting of `126500`
 * read as mm = `126.5 m` → South Pacific instead of the Netherlands).
 *
 * Heuristic: when no explicit MapUnit is set, treat the offsets as metres.
 * Files that genuinely use non-metre offsets can set MapUnit explicitly
 * (e.g. `IfcProjectedCRS.MapUnit = MILLIMETRE`) to opt out.
 */
export function resolveMapUnitToMetreScale(
  mapUnitScaleFromCrs: number | undefined,
  lengthUnitScale: number,
): number {
  if (mapUnitScaleFromCrs && mapUnitScaleFromCrs > 0) return mapUnitScaleFromCrs;
  void lengthUnitScale; // parameter kept for future spec-strict override
  return 1;
}
