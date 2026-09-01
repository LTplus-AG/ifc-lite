/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit extraction for IFC files
 *
 * Extracts length unit scale factor from IFCPROJECT -> IFCUNITASSIGNMENT -> IFCSIUNIT/IFCCONVERSIONBASEDUNIT
 * Used to convert elevation values and other length measurements to meters.
 */

import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import type { IfcSourceBytes } from './source-bytes.js';
import { RelationshipType } from '@ifc-lite/data';

/**
 * SI Prefix multipliers, keyed by the members of the `IfcSIPrefix` EXPRESS
 * enumeration — that enumeration is the authority for which prefixes a unit
 * can carry, so a reader that knows only a subset silently reports the base
 * unit and is wrong by the missing prefix's own factor.
 *
 * Exported for the same reason as {@link CONVERSION_BASED_UNIT_FACTORS}: the
 * georeferencing extractor resolves an `IfcProjectedCRS` MapUnit through the
 * SAME table this one uses for the project length unit. It previously carried
 * a private four-entry copy (MILLI/CENTI/DECI/KILO), so a MapUnit in any
 * other prefix read back as plain metres.
 */
export const SI_PREFIX_MULTIPLIERS: Record<string, number> = {
  'ATTO': 1e-18,
  'FEMTO': 1e-15,
  'PICO': 1e-12,
  'NANO': 1e-9,
  'MICRO': 1e-6,
  'MILLI': 1e-3,   // Most common: millimeters
  'CENTI': 1e-2,   // Centimeters
  'DECI': 1e-1,    // Decimeters
  'DECA': 1e1,
  'HECTO': 1e2,
  'KILO': 1e3,
  'MEGA': 1e6,
  'GIGA': 1e9,
  'TERA': 1e12,
  'PETA': 1e15,
  'EXA': 1e18,
};

/**
 * Known conversion factors for imperial/conversion-based units to meters.
 *
 * Exported so the georeferencing extractor resolves an `IfcProjectedCRS`
 * MapUnit through the SAME table this one uses for the project length unit —
 * two length-unit readers on the same file that disagree would put the model
 * and its map coordinates on different scales.
 */
export const CONVERSION_BASED_UNIT_FACTORS: Record<string, number> = {
  'FOOT': 0.3048,
  'FEET': 0.3048,
  "'FOOT'": 0.3048,
  'INCH': 0.0254,
  "'INCH'": 0.0254,
  'YARD': 0.9144,
  "'YARD'": 0.9144,
  'MILE': 1609.344,
  "'MILE'": 1609.344,
  // The quoted spelling is a real, if rare, branch: a STEP name attribute
  // written as `''FEET''` in the file decodes (doubled-quote escaping) to
  // the four-character string `'FEET'`, complete with embedded quote
  // characters, and is looked up here verbatim. FEET was missing this entry
  // even though every other spelling in the table has one.
  "'FEET'": 0.3048,
};

/**
 * De-duplicates the "unknown unit, defaulting to meters" warning per
 * `entityIndex` (i.e. per parsed model), so a caller that re-derives the
 * scale many times for the same store — {@link extractWallSegmentsForStorey}
 * runs once per storey, {@link resolveSpatialAnchor} once per generated
 * space — doesn't flood the console with the same diagnosis. A different
 * model (a different `entityIndex` object) still gets its own warning: the
 * latch is keyed on object identity, not a module-global boolean.
 */
const warnedEntityIndexes = new WeakSet<object>();

/**
 * Warn once per model that the length unit could not be resolved and the
 * caller is falling back to an unconfirmed 1.0 (meters). See issue #2104:
 * without this, a millimetre model whose unit declaration is malformed reads
 * as metres with no signal that the value is a guess rather than a fact.
 */
function warnUnknownUnit(entityIndex: object, reason: string): void {
  if (warnedEntityIndexes.has(entityIndex)) return;
  warnedEntityIndexes.add(entityIndex);
  console.warn(`[UnitExtractor] ${reason}, defaulting to meters (unconfirmed — see issue #2104)`);
}

/**
 * Extract length unit scale factor from IFC file
 *
 * Follows the chain: IFCPROJECT → IFCUNITASSIGNMENT → IFCSIUNIT/IFCCONVERSIONBASEDUNIT
 * Returns the multiplier to convert coordinates to meters.
 *
 * Every `1.0` this function returns for a path OTHER than "IFCSIUNIT length
 * unit with no prefix" is an unconfirmed default, not a confirmed metre
 * declaration — those paths call {@link warnUnknownUnit} exactly once per
 * `entityIndex` so the ambiguity is visible instead of silent (#2104). The
 * no-prefix IFCSIUNIT case is a genuine, confirmed "this file declares
 * meters" and intentionally does not warn.
 *
 * @param source - The IFC file bytes, either raw or behind {@link IfcSourceBytes}
 * @param entityIndex - Entity index with byId and byType maps
 * @returns Scale factor to apply to length values (e.g., 0.001 for millimeters)
 */
export function extractLengthUnitScale(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> }
): number {
  // Find IFCPROJECT
  const projectIds = entityIndex.byType.get('IFCPROJECT') || [];
  if (projectIds.length === 0) {
    warnUnknownUnit(entityIndex, 'No IFCPROJECT found');
    return 1.0;
  }

  return extractLengthUnitScaleForProjectId(projectIds[0], source, entityIndex);
}

/**
 * Same resolution as {@link extractLengthUnitScale}, but for an EXPLICIT
 * `IFCPROJECT` id rather than always the first one found. Factored out so
 * {@link resolveEntityLengthUnitScale} can resolve the scale of a specific
 * project in a multi-project file (a {@link MergedExporter} federated
 * output — see that module) without duplicating the unit-chain walk.
 */
function extractLengthUnitScaleForProjectId(
  projectId: number,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> }
): number {
  const extractor = new EntityExtractor(source);

  const projectRef = entityIndex.byId.get(projectId);
  if (!projectRef) {
    warnUnknownUnit(entityIndex, 'IFCPROJECT reference could not be resolved');
    return 1.0;
  }

  const projectEntity = extractor.extractEntity(projectRef);
  if (!projectEntity) {
    warnUnknownUnit(entityIndex, 'IFCPROJECT entity could not be read');
    return 1.0;
  }

  // IFCPROJECT attributes:
  // [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description, [4] ObjectType,
  // [5] LongName, [6] Phase, [7] RepresentationContexts, [8] UnitsInContext
  const attrs = projectEntity.attributes || [];
  const unitsRef = attrs[8];

  if (typeof unitsRef !== 'number') {
    warnUnknownUnit(entityIndex, 'No UnitsInContext reference');
    return 1.0;
  }

  // Resolve IFCUNITASSIGNMENT
  const unitAssignmentRef = entityIndex.byId.get(unitsRef);
  if (!unitAssignmentRef) {
    warnUnknownUnit(entityIndex, 'UnitsInContext reference could not be resolved');
    return 1.0;
  }

  const unitAssignment = extractor.extractEntity(unitAssignmentRef);
  if (!unitAssignment || unitAssignment.type.toUpperCase() !== 'IFCUNITASSIGNMENT') {
    warnUnknownUnit(entityIndex, 'UnitsInContext did not resolve to an IFCUNITASSIGNMENT');
    return 1.0;
  }

  // Guard against missing attributes
  if (!unitAssignment.attributes || !Array.isArray(unitAssignment.attributes)) {
    warnUnknownUnit(entityIndex, 'IFCUNITASSIGNMENT has no readable attributes');
    return 1.0;
  }

  // IFCUNITASSIGNMENT has a single attribute: Units (list of references)
  const unitsList = unitAssignment.attributes[0];
  if (!Array.isArray(unitsList)) {
    warnUnknownUnit(entityIndex, 'IFCUNITASSIGNMENT.Units is not a list');
    return 1.0;
  }

  // Search for length unit
  for (const unitRef of unitsList) {
    if (typeof unitRef !== 'number') continue;

    const unitEntityRef = entityIndex.byId.get(unitRef);
    if (!unitEntityRef) continue;

    const unitEntity = extractor.extractEntity(unitEntityRef);
    if (!unitEntity) continue;

    const unitType = unitEntity.type.toUpperCase();
    const unitAttrs = unitEntity.attributes || [];

    // Handle IFCSIUNIT
    if (unitType === 'IFCSIUNIT') {
      // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
      const unitTypeValue = unitAttrs[1];

      // Check if this is a length unit (enum value like .LENGTHUNIT.)
      const isLengthUnit = typeof unitTypeValue === 'string' &&
        unitTypeValue.replace(/\./g, '').toUpperCase() === 'LENGTHUNIT';

      if (!isLengthUnit) continue;

      // Extract prefix (can be null/$, enum like .MILLI., or string)
      const prefix = unitAttrs[2];

      if (prefix === null || prefix === undefined || prefix === '$') {
        // No prefix = base meters
        return 1.0;
      }

      // Clean up enum value (remove dots)
      const prefixStr = typeof prefix === 'string'
        ? prefix.replace(/\./g, '').toUpperCase()
        : '';

      const multiplier = SI_PREFIX_MULTIPLIERS[prefixStr];
      if (multiplier !== undefined) {
        return multiplier;
      }

      warnUnknownUnit(entityIndex, `Unrecognized SI prefix "${prefixStr}"`);
      return 1.0;
    }

    // Handle IFCCONVERSIONBASEDUNIT (imperial units)
    if (unitType === 'IFCCONVERSIONBASEDUNIT') {
      // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType, [2] Name, [3] ConversionFactor
      const unitTypeValue = unitAttrs[1];

      const isLengthUnit = typeof unitTypeValue === 'string' &&
        unitTypeValue.replace(/\./g, '').toUpperCase() === 'LENGTHUNIT';

      if (!isLengthUnit) continue;

      // Try to get known conversion factor by name
      const unitName = unitAttrs[2];
      if (typeof unitName === 'string') {
        const nameUpper = unitName.toUpperCase();
        const knownFactor = CONVERSION_BASED_UNIT_FACTORS[nameUpper];
        if (knownFactor !== undefined) {
          return knownFactor;
        }
      }

      // Try to extract from ConversionFactor (IFCMEASUREWITHUNIT reference)
      const conversionRef = unitAttrs[3];
      if (typeof conversionRef === 'number') {
        const measureRef = entityIndex.byId.get(conversionRef);
        if (measureRef) {
          const measureEntity = extractor.extractEntity(measureRef);
          if (measureEntity) {
            // IFCMEASUREWITHUNIT: [0] ValueComponent, [1] UnitComponent
            const valueAttr = measureEntity.attributes[0];
            const unitComponentRef = measureEntity.attributes[1];
            let conversionValue: number | undefined;

            if (typeof valueAttr === 'number') {
              conversionValue = valueAttr;
            } else if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number') {
              // Typed value like ['IFCLENGTHMEASURE', 0.3048]
              conversionValue = valueAttr[1];
            } else {
              // Unreadable ValueComponent: default to 1.0 but STILL apply the
              // UnitComponent prefix below — parity with the Rust extractor
              // (rust/core/src/units.rs), which drives geometry scaling. A
              // millimetre-based IfcMeasureWithUnit with a garbled value must
              // resolve to 0.001 on both sides, not fall through to metres
              // here while the meshes scale by 0.001.
              conversionValue = 1.0;
            }

            if (conversionValue !== undefined && conversionValue > 0) {
              // IMPORTANT: ValueComponent is expressed in UnitComponent's units.
              // If UnitComponent is a prefixed SI unit (e.g., millimeters),
              // we must multiply by that unit's scale factor.
              let unitComponentScale = 1.0;

              if (typeof unitComponentRef === 'number') {
                const unitCompEntityRef = entityIndex.byId.get(unitComponentRef);
                if (unitCompEntityRef) {
                  const unitCompEntity = extractor.extractEntity(unitCompEntityRef);
                  if (unitCompEntity && unitCompEntity.type.toUpperCase() === 'IFCSIUNIT') {
                    // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
                    const unitCompAttrs = unitCompEntity.attributes || [];
                    const prefix = unitCompAttrs[2];
                    if (prefix !== null && prefix !== undefined && prefix !== '$') {
                      const prefixStr = typeof prefix === 'string'
                        ? prefix.replace(/\./g, '').toUpperCase()
                        : '';
                      const prefixMultiplier = SI_PREFIX_MULTIPLIERS[prefixStr];
                      if (prefixMultiplier !== undefined) {
                        unitComponentScale = prefixMultiplier;
                      }
                    }
                  }
                }
              }

              return conversionValue * unitComponentScale;
            }
          }
        }
      }
    }
  }

  // No length unit found, default to meters
  warnUnknownUnit(entityIndex, 'No LENGTHUNIT found in IFCUNITASSIGNMENT');
  return 1.0;
}

/** Minimal relationship-graph surface {@link resolveEntityLengthUnitScale} needs. */
interface RelatedLookup {
  getRelated(entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse'): number[];
}

/** Bound on the spatial-containment walk in {@link resolveEntityLengthUnitScale}
 *  (element → storey → building → site → project is 4 hops; double it for an
 *  unusually deep IfcSpatialZone/IfcSpace nesting, never for a real cycle). */
const MAX_PROJECT_WALK_HOPS = 8;

/**
 * Resolve the length unit scale that applies to ONE entity, correctly for a
 * multi-`IfcProject` file (a {@link MergedExporter} `unitReconciliation: 'auto'`
 * federated export: a model whose length unit differs from the first model's
 * keeps its own `IfcProject`/`IfcUnitAssignment` rather than being rescaled —
 * see that module's docs).
 *
 * {@link extractLengthUnitScale} (and the `dataStore.lengthUnitScale` it feeds)
 * answers for the FIRST `IfcProject` only. That is exactly right for the
 * overwhelmingly common single-project file (this function's fast path below
 * returns the identical value), but silently wrong for a federated entity that
 * belongs to a LATER project: e.g. a material layer's `LayerThickness` is a
 * raw literal in ITS OWN project's unit, and scaling it by the first project's
 * factor corrupts the value by whatever ratio separates the two units (a
 * millimetre federated model read back with the metres factor turns a 300 mm
 * layer into a fabricated "300 m" one).
 *
 * Multi-project resolution walks the entity's spatial containment UP the real
 * `IfcRelContainedInSpatialStructure` / `IfcRelAggregates` chain (never an
 * id-ordering guess, which a federated file's per-model id-contiguous blocks
 * would tempt but not guarantee) to find its owning `IfcProject`, then answers
 * for THAT project. Falls back to the first project's scale when the entity
 * (a resource-level entity like `IfcMaterial`, unreachable from any element)
 * has no discoverable containment path, or the walk does not land on a project
 * within {@link MAX_PROJECT_WALK_HOPS} — the same safe-miss direction
 * {@link extractLengthUnitScale} already documents for every other ambiguous
 * case.
 */
export function resolveEntityLengthUnitScale(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  relationships: RelatedLookup,
  expressId: number,
): number {
  const projectIds = entityIndex.byType.get('IFCPROJECT') || [];
  if (projectIds.length <= 1) {
    // Fast path, and the common case: identical to extractLengthUnitScale.
    return extractLengthUnitScale(source, entityIndex);
  }

  const projectIdSet = new Set(projectIds);
  let current = expressId;
  for (let hop = 0; hop < MAX_PROJECT_WALK_HOPS; hop++) {
    if (projectIdSet.has(current)) {
      return extractLengthUnitScaleForProjectId(current, source, entityIndex);
    }
    // An element's container (IfcRelContainedInSpatialStructure, inverse), a
    // spatial node's decomposition parent (IfcRelAggregates, inverse), or —
    // for a TYPE object (an `IfcWallType` carries its own material/pset
    // assignments but is never itself spatially contained) — one of the
    // occurrences it defines (IfcRelDefinesByType, forward: RelatingType →
    // RelatedObjects), so the walk continues from a concrete occurrence.
    // Containment first since it is the one-hop case for the common "element
    // straight into its storey" shape.
    const container = relationships.getRelated(current, RelationshipType.ContainsElements, 'inverse');
    const parent = container.length > 0 ? container
      : relationships.getRelated(current, RelationshipType.Aggregates, 'inverse');
    const next = parent.length > 0 ? parent
      : relationships.getRelated(current, RelationshipType.DefinesByType, 'forward');
    if (next.length === 0) break;
    current = next[0];
  }

  // No discoverable containment path to any project — fall back to the first
  // project's scale (the pre-existing, documented-safe default).
  return extractLengthUnitScale(source, entityIndex);
}
