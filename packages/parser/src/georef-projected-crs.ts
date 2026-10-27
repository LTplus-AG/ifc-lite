/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one `IfcProjectedCRS`, resolving its MapUnit to a metre scale. Split
 * out of `georef-extractor.ts` to keep that module under its size budget.
 */

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

  let componentScale = 1;
  const componentRef = getReference(measure.attributes?.[1]);
  if (componentRef !== undefined) {
    const component = resolveEntity(componentRef);
    if (component && (component.type ?? '').toUpperCase() === 'IFCSIUNIT') {
      const prefix = component.attributes?.[2];
      if (typeof prefix === 'string' && prefix !== '$') {
        const prefixScale = SI_PREFIX_MULTIPLIERS[prefix.replace(/\./g, '').toUpperCase()];
        if (prefixScale !== undefined) componentScale = prefixScale;
      }
    }
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
  const mapUnitRef = getReference(entity.attributes[6]);
  if (mapUnitRef) {
    mapUnit = 'METRE'; // default if we can't resolve
    mapUnitScale = 1;
    if (resolveEntity) {
      const unitEntity = resolveEntity(mapUnitRef);
      if (unitEntity) {
        // MapUnit is an IfcNamedUnit, which is IfcSIUnit OR
        // IfcConversionBasedUnit. Attribute 2 means something different in
        // each: `Prefix` on the SI unit, `Name` on the conversion-based one.
        // Reading slot 2 as a prefix unconditionally means a foot-based
        // MapUnit ('FOOT' is not an SI prefix) misses every lookup and falls
        // through to the METRE/1.0 default — so a georeference in feet reads
        // back 3.28x wrong, silently. ifc-lite's own exporter writes exactly
        // that IFCCONVERSIONBASEDUNIT form for FOOT and US SURVEY FOOT
        // (packages/export/src/step-georeferencing.ts), and no fixture ever
        // set a non-metre map unit, so the round trip only ever saw METRE.
        if ((unitEntity.type ?? '').toUpperCase() === 'IFCCONVERSIONBASEDUNIT') {
          // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType, [2] Name,
          // [3] ConversionFactor (IfcMeasureWithUnit)
          const rawName = getString(unitEntity.attributes?.[2]);
          const name = rawName?.replace(/^'|'$/g, '').trim().toUpperCase();
          // The name table first (it carries the exact defined ratios, e.g.
          // the US survey foot's 1200/3937), then the file's own declared
          // conversion factor for a unit name we do not know.
          const scale = (name ? CONVERSION_BASED_UNIT_FACTORS[name] : undefined)
            ?? resolveMeasureWithUnit(unitEntity.attributes?.[3], resolveEntity);
          if (scale !== undefined && Number.isFinite(scale) && scale > 0) {
            mapUnitScale = scale;
            if (name) mapUnit = name;
          }
        } else {
          // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
          const prefix = unitEntity.attributes?.[2];
          if (prefix != null && prefix !== '$' && typeof prefix === 'string') {
            const prefixStr = prefix.replace(/\./g, '').toUpperCase();
            const prefixScale = SI_PREFIX_MULTIPLIERS[prefixStr];
            if (prefixScale !== undefined) {
              mapUnitScale = prefixScale;
              mapUnit = prefixStr === 'MILLI' ? 'MILLIMETRE' : prefixStr + 'METRE';
            }
          }
          // No prefix → base METRE → scale = 1
        }
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
  };
}
