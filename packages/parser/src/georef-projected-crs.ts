/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one `IfcProjectedCRS`, resolving its MapUnit to a metre scale. Split
 * out of `georef-extractor.ts` to keep that module under its size budget.
 */

import { inferMapUnitScaleFromLabel } from './map-unit-label.js';
import type { IfcEntity } from './entity-extractor.js';
import type { ProjectedCRS } from './georef-extractor.js';
import { getString, getReference } from './attribute-helpers.js';
import { CONVERSION_BASED_UNIT_FACTORS, SI_PREFIX_MULTIPLIERS } from './unit-extractor.js';

/**
 * Resolve an `IfcMeasureWithUnit` reference to metres.
 *
 * `IFCMEASUREWITHUNIT: [0] ValueComponent, [1] UnitComponent` — the value is
 * expressed IN the unit component, so a prefixed SI component multiplies it
 * (0.3048 expressed in millimetres is not 0.3048 metres).
 */
function resolveMeasureWithUnit(
  ref: unknown,
  resolveEntity: (id: number) => IfcEntity | undefined,
): number | undefined {
  const measureRef = getReference(ref);
  if (measureRef === undefined) return undefined;
  const measure = resolveEntity(measureRef);
  if (!measure) return undefined;

  const valueAttr = measure.attributes?.[0];
  let value: number | undefined;
  if (typeof valueAttr === 'number') {
    value = valueAttr;
  } else if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number') {
    // Typed value, e.g. ['IFCLENGTHMEASURE', 0.3048]
    value = valueAttr[1];
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

  // The factor is a multiple of its component unit: it must name an SI LENGTH unit (whose prefix is applied). An
  // absent component, one that is not in the file, a non-length unit, or a conversion-based one (a chain of 66
  // FEET, which would need its own factor) leaves the factor unstated.
  const componentRef = getReference(measure.attributes?.[1]);
  const component = componentRef === undefined ? undefined : resolveEntity(componentRef);
  if (!component || (component.type ?? '').toUpperCase() !== 'IFCSIUNIT') return undefined;
  if (String(component.attributes?.[1] ?? '').replace(/\./g, '').toUpperCase() !== 'LENGTHUNIT') return undefined;
  let componentScale = 1;
  const prefix = component.attributes?.[2];
  if (typeof prefix === 'string' && prefix !== '$') {
    const prefixScale = SI_PREFIX_MULTIPLIERS[prefix.replace(/\./g, '').toUpperCase()];
    if (prefixScale !== undefined) componentScale = prefixScale;
  }

  return value * componentScale;
}

export function extractProjectedCRS(
  entity: IfcEntity,
  resolveEntity?: (id: number) => IfcEntity | undefined,
): ProjectedCRS {
  // IfcProjectedCRS attributes (IFC4):
  // [0] Name (IfcLabel)
  // [1] Description (OPTIONAL IfcText)
  // [2] GeodeticDatum (OPTIONAL IfcIdentifier)
  // [3] VerticalDatum (OPTIONAL IfcIdentifier)
  // [4] MapProjection (OPTIONAL IfcIdentifier)
  // [5] MapZone (OPTIONAL IfcIdentifier)
  // [6] MapUnit (OPTIONAL IfcNamedUnit)

  // Resolve MapUnit reference to determine actual unit + scale
  let mapUnit: string | undefined;
  let mapUnitScale: number | undefined;
  let mapUnitResolved: boolean | undefined;
  const mapUnitRef = getReference(entity.attributes[6]);
  if (mapUnitRef) {
    // Reported when the unit cannot be resolved, for consumers that need a
    // scale; `mapUnitResolved: false` says it is a default, not a reading.
    mapUnit = 'METRE';
    mapUnitScale = 1;
    mapUnitResolved = false;
    const unitEntity = resolveEntity?.(mapUnitRef);
    const unitType = (unitEntity?.type ?? '').toUpperCase();
    if (unitEntity && (unitType === 'IFCCONVERSIONBASEDUNIT' || unitType === 'IFCCONVERSIONBASEDUNITWITHOFFSET')) {
      // MapUnit is an IfcNamedUnit, which is IfcSIUnit OR
      // IfcConversionBasedUnit (or its …WithOffset subtype). Attribute 2
      // means something different in each: `Prefix` on the SI unit, `Name`
      // on the conversion-based ones. Reading slot 2 as a prefix
      // unconditionally means a foot-based MapUnit ('FOOT' is not an SI
      // prefix) misses every lookup and falls through to the METRE/1.0
      // default, so a georeference in feet reads back 3.28x wrong. ifc-lite's
      // own exporter writes the IFCCONVERSIONBASEDUNIT form for FOOT and US
      // SURVEY FOOT (packages/export/src/step-georeferencing.ts).
      // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType, [2] Name,
      // [3] ConversionFactor (IfcMeasureWithUnit); …WITHOFFSET adds
      // [4] ConversionOffset. A length with a non-zero offset is not a
      // ratio scale, so it stays unresolved.
      const offset = unitType === 'IFCCONVERSIONBASEDUNITWITHOFFSET' ? unitEntity.attributes?.[4] : 0;
      const rawName = getString(unitEntity.attributes?.[2]);
      const name = rawName?.replace(/^'|'$/g, '').trim().toUpperCase();
      // The name table first (it carries the exact defined ratios, e.g.
      // the US survey foot's 1200/3937), then the file's own declared
      // conversion factor for a unit name we do not know.
      const scale = (name ? CONVERSION_BASED_UNIT_FACTORS[name] : undefined)
        ?? resolveMeasureWithUnit(unitEntity.attributes?.[3], resolveEntity!);
      if (offset === 0 && scale !== undefined && Number.isFinite(scale) && scale > 0) {
        mapUnitScale = scale;
        if (name) {
          mapUnit = name;
          // The name only identifies the unit when the factor the file declares is the one that name means (the
          // writer's own table: SI-prefixed metre, FOOT, US SURVEY FOOT, plus the conversion-based names above).
          // A survey foot named FOOT, a metre declared as 0.3048, or a missing, zero or negative factor is a
          // reading nobody may carry into a write.
          const declared = resolveMeasureWithUnit(unitEntity.attributes?.[3], resolveEntity!);
          const expected = inferMapUnitScaleFromLabel(name) ?? CONVERSION_BASED_UNIT_FACTORS[name];
          mapUnitResolved = declared !== undefined && Number.isFinite(declared) && declared > 0
            && (expected === undefined || Math.abs(declared - expected) / expected <= 1e-7);
        }
      }
    } else if (unitEntity && unitType === 'IFCSIUNIT') {
      // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
      const prefix = unitEntity.attributes?.[2];
      const siName = getString(unitEntity.attributes?.[3])?.replace(/\./g, '').toUpperCase();
      if (prefix != null && prefix !== '$' && typeof prefix === 'string') {
        const prefixStr = prefix.replace(/\./g, '').toUpperCase();
        const prefixScale = SI_PREFIX_MULTIPLIERS[prefixStr];
        if (prefixScale !== undefined) {
          mapUnitScale = prefixScale;
          mapUnit = prefixStr === 'MILLI' ? 'MILLIMETRE' : prefixStr + 'METRE';
          mapUnitResolved = siName === 'METRE';
        }
      } else {
        // No prefix → base METRE → scale = 1
        mapUnitResolved = siName === 'METRE';
      }
    }
  }
  // If mapUnitRef is absent → mapUnit stays undefined, mapUnitScale stays undefined
  // → per IFC spec, MapConversion uses the project's length unit

  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]) || '',
    description: getString(entity.attributes[1]),
    geodeticDatum: getString(entity.attributes[2]),
    verticalDatum: getString(entity.attributes[3]),
    mapProjection: getString(entity.attributes[4]),
    mapZone: getString(entity.attributes[5]),
    mapUnit,
    mapUnitScale,
    ...(mapUnitResolved === undefined ? {} : { mapUnitResolved }),
  };
}
