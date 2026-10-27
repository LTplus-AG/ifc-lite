/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC4X3_ADD1+ coordinate-operation family beside `IfcMapConversion`:
 * `IfcRigidOperation`, its `IfcGeographicCRS` target, and the
 * `IfcWellKnownText` definition any `IfcCoordinateReferenceSystem` may carry.
 *
 * `IfcRigidOperation` is a pure translation (no rotation, no scale): "the
 * whole virtual model is translated in the same way ... using lengths to
 * translate along x,y,z; or using angles for a 2D translation (e.g., lambda,
 * phi), plus a change in height." Both coordinates share one measure type
 * (WHERE SameCoordinateType). It is read into the existing `MapConversion`
 * shape with an identity axis and unit scale so every consumer of
 * `transformMatrix` keeps working; `operation: 'rigidOperation'` records that
 * the source coordinates already ARE target-CRS coordinates.
 */

import type { IfcEntity } from './entity-extractor.js';
import type { MapConversion, ProjectedCRS } from './georef-extractor.js';
import { getNumber, getReference, getString, isUnrepresentableNumericValue } from './attribute-helpers.js';
import { SI_PREFIX_MULTIPLIERS } from './unit-extractor.js';

export type EntityResolver = (id: number) => IfcEntity | undefined;

const DEGREES_PER_RADIAN = 180 / Math.PI;
const MAX_UNIT_DEPTH = 8;

const isType = (entity: IfcEntity | undefined, upper: string): boolean =>
  (entity?.type ?? '').toUpperCase() === upper;

/** `['IFCLENGTHMEASURE', 0]` → `{ type, value }`; a bare or unrepresentable value is refused. */
function typedMeasure(raw: unknown): { type: string; value: number } | 'unrepresentable' | null {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string') return null;
  if (isUnrepresentableNumericValue(raw[1])) return 'unrepresentable';
  const value = getNumber(raw[1]);
  return value === undefined ? null : { type: raw[0].toUpperCase(), value };
}

/**
 * Degrees per unit of an `IfcNamedUnit` used as a plane-angle unit, or
 * `undefined` when it is not one this reader can confirm. A conversion-based
 * unit is resolved through its own declared factor (an `IfcMeasureWithUnit`
 * in a radian-based SI unit), so `DEGREE`, `GRAD` and any other spelling read
 * the same way without a name table.
 */
export function planeAngleUnitToDegrees(unitRef: unknown, resolve: EntityResolver, depth = 0): number | undefined {
  // A conversion-based unit may reference another; a cycle must not recurse
  // forever (the Rust twin's MAX_UNIT_DEPTH). Real files nest one level.
  if (depth > MAX_UNIT_DEPTH) return undefined;
  const id = getReference(unitRef);
  const unit = id === undefined ? undefined : resolve(id);
  if (!unit || getString(unit.attributes?.[1])?.replace(/\./g, '').toUpperCase() !== 'PLANEANGLEUNIT') return undefined;
  if (isType(unit, 'IFCSIUNIT')) {
    // [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
    if (getString(unit.attributes?.[3])?.replace(/\./g, '').toUpperCase() !== 'RADIAN') return undefined;
    const prefix = getString(unit.attributes?.[2])?.replace(/\./g, '').toUpperCase();
    const multiplier = prefix ? SI_PREFIX_MULTIPLIERS[prefix] : 1;
    return multiplier === undefined ? undefined : multiplier * DEGREES_PER_RADIAN;
  }
  if (isType(unit, 'IFCCONVERSIONBASEDUNIT')) {
    // [3] ConversionFactor: IfcMeasureWithUnit([0] ValueComponent, [1] UnitComponent)
    const measureId = getReference(unit.attributes?.[3]);
    const measure = measureId === undefined ? undefined : resolve(measureId);
    const raw = measure?.attributes?.[0];
    const value = Array.isArray(raw) ? getNumber(raw[1]) : getNumber(raw);
    const componentDegrees = planeAngleUnitToDegrees(measure?.attributes?.[1], resolve, depth + 1);
    if (value === undefined || !(value > 0) || componentDegrees === undefined) return undefined;
    return value * componentDegrees;
  }
  return undefined;
}

/**
 * Degrees per unit of the project's plane-angle unit: `IfcProject.UnitsInContext`
 * → `IfcUnitAssignment.Units`. With no plane-angle unit assigned the SI default
 * (radian) applies; an assigned unit this reader cannot confirm is `undefined`.
 */
export function projectPlaneAngleUnitToDegrees(
  projectIds: readonly number[],
  resolve: EntityResolver,
): number | undefined {
  const project = projectIds.length > 0 ? resolve(projectIds[0]) : undefined;
  const assignmentId = getReference(project?.attributes?.[8]);
  const assignment = assignmentId === undefined ? undefined : resolve(assignmentId);
  const units = assignment?.attributes?.[0];
  if (Array.isArray(units)) {
    for (const ref of units) {
      const id = getReference(ref);
      const unit = id === undefined ? undefined : resolve(id);
      if (getString(unit?.attributes?.[1])?.replace(/\./g, '').toUpperCase() === 'PLANEANGLEUNIT') {
        return planeAngleUnitToDegrees(ref, resolve);
      }
    }
  }
  return DEGREES_PER_RADIAN;
}

/**
 * `IfcGeographicCRS`: [0] Name, [1] Description, [2] GeodeticDatum,
 * [3] PrimeMeridian, [4] AngleUnit, [5] HeightUnit. Carried in the
 * `ProjectedCRS` shape (as the legacy IfcSite fallback already does for
 * EPSG:4326) with `kind: 'geographic'`; coordinates are lon/lat degrees.
 */
export function extractGeographicCRS(entity: IfcEntity): ProjectedCRS {
  return {
    id: entity.expressId,
    kind: 'geographic',
    name: getString(entity.attributes[0]) || '',
    description: getString(entity.attributes[1]),
    geodeticDatum: getString(entity.attributes[2]),
    mapUnit: 'DEGREE',
  };
}

/** The first `IfcWellKnownText` literal whose CoordinateReferenceSystem is `crsId`. */
export function wellKnownTextFor(
  crsId: number,
  wktIds: readonly number[],
  resolve: EntityResolver,
): string | undefined {
  for (const id of wktIds) {
    const entity = resolve(id);
    if (!entity || getReference(entity.attributes?.[1]) !== crsId) continue;
    const text = getString(entity.attributes?.[0])?.trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * Read one `IfcRigidOperation` — [0] SourceCRS, [1] TargetCRS,
 * [2] FirstCoordinate, [3] SecondCoordinate, [4] Height? — or refuse it.
 *
 * Length measures translate map coordinates (first = easting, second =
 * northing). Plane-angle measures are only meaningful against an
 * `IfcGeographicCRS` and translate (lambda, phi) = (longitude, latitude);
 * `angleUnitToDegrees` converts them, and they are refused when it is unknown
 * rather than read in a guessed unit.
 */
export function extractRigidOperation(
  entity: IfcEntity,
  target: { geographic: boolean; angleUnitToDegrees?: number },
): MapConversion | null {
  const refuse = (why: string): null => {
    console.warn(`[georef-extractor] IfcRigidOperation #${entity.expressId} ${why}; refusing the coordinate operation.`);
    return null;
  };
  const first = typedMeasure(entity.attributes[2]);
  const second = typedMeasure(entity.attributes[3]);
  if (first === 'unrepresentable' || second === 'unrepresentable' || isUnrepresentableNumericValue(entity.attributes[4])) {
    return refuse('has a coordinate outside the IEEE-754 double range');
  }
  if (!first || !second) return refuse('has no typed FirstCoordinate/SecondCoordinate');
  if (first.type !== second.type) return refuse(`mixes ${first.type} and ${second.type} (WHERE SameCoordinateType)`);

  let eastings = first.value;
  let northings = second.value;
  if (first.type === 'IFCPLANEANGLEMEASURE') {
    if (!target.geographic) return refuse('uses plane angles against a non-geographic TargetCRS');
    const factor = target.angleUnitToDegrees;
    if (factor === undefined || !Number.isFinite(factor) || factor <= 0) return refuse('uses a plane-angle unit that cannot be resolved');
    eastings *= factor;
    northings *= factor;
  } else if (first.type !== 'IFCLENGTHMEASURE') {
    return refuse(`uses ${first.type}; only IFCLENGTHMEASURE or IFCPLANEANGLEMEASURE are allowed`);
  } else if (target.geographic) {
    return refuse('uses lengths against a geographic TargetCRS');
  }

  return {
    id: entity.expressId,
    operation: 'rigidOperation',
    sourceCRS: getReference(entity.attributes[0]) || 0,
    targetCRS: getReference(entity.attributes[1]) || 0,
    eastings,
    northings,
    orthogonalHeight: getNumber(entity.attributes[4]) ?? 0,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
  };
}
