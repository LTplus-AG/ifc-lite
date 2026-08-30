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
 * @param projectId - Optional express id of the specific `IFCPROJECT` to read
 *   units from. Most files declare exactly one, so the default (the file's
 *   first `IFCPROJECT`) is correct for the overwhelmingly common case; pass
 *   this explicitly when resolving units for an entity that may belong to a
 *   later `IFCPROJECT` in a multi-project (federated-merge, see #1332) file
 *   — see {@link resolveOwningProjectId}.
 * @returns Scale factor to apply to length values (e.g., 0.001 for millimeters)
 */
export function extractLengthUnitScale(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  projectId?: number
): number {
  // Find IFCPROJECT
  const projectIds = entityIndex.byType.get('IFCPROJECT') || [];
  const resolvedProjectId = projectId ?? projectIds[0];
  if (resolvedProjectId === undefined) {
    warnUnknownUnit(entityIndex, 'No IFCPROJECT found');
    return 1.0;
  }

  return extractLengthUnitScaleForProjectId(resolvedProjectId, source, entityIndex);
}

/**
 * Same resolution as {@link extractLengthUnitScale}, but for an EXPLICIT
 * `IFCPROJECT` id rather than always the first one found. Factored out so
 * {@link resolveEntityLengthUnitScale} and other {@link resolveOwningProjectId}
 * callers can resolve the scale of a specific project in a multi-project
 * file (a {@link MergedExporter} federated output — see that module)
 * without duplicating the unit-chain walk.
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

/** Minimal relationship-graph surface {@link resolveOwningProjectId} needs. */
interface RelatedLookup {
  getRelated(entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse'): number[];
}

/** Upper bound on the containment walk in {@link resolveOwningProjectId}, so a
 *  malformed file with a containment cycle that the visited-set guard doesn't
 *  catch on its first pass still terminates. Real spatial hierarchies (site →
 *  building → storey → element, occasionally one assembly level deeper) never
 *  come close to this depth. */
const MAX_OWNING_PROJECT_WALK_STEPS = 64;

/**
 * Resolve the express id of the `IFCPROJECT` that owns `expressId`, for files
 * that legitimately contain more than one `IFCPROJECT` — the shape
 * `MergedExporter`'s documented `auto` unit-reconciliation mode produces for
 * a federated merge of differently-unit'd models (see issue #1332). An
 * ordinary IFC file has exactly one `IFCPROJECT` by EXPRESS invariant, so
 * this is a no-op fast path there.
 *
 * `extractLengthUnitScale`/`extractProjectUnits` resolve the file's FIRST
 * `IFCPROJECT` only unless given an explicit `projectId`; every entity
 * belonging to a LATER project in a multi-project file was silently read
 * against the first project's units. Callers needing per-entity correctness
 * (both {@link resolveEntityLengthUnitScale} below and `@ifc-lite/ids`'s
 * area/volume resolution, which needs the project id itself rather than
 * just a length scale) resolve this id first and pass it on to
 * `extractLengthUnitScale`/`extractProjectUnits`'s `projectId` parameter.
 *
 * Walks the entity's real spatial containment up to its own project:
 * `IfcRelContainedInSpatialStructure` (element → structure), then
 * `IfcRelAggregates` (child → parent, repeated to the project), with an
 * `IfcRelDefinesByType` (type → one of the objects it defines) hop for a
 * type entity that has no containment of its own. Containment is tried
 * first since it's the one-hop case for the common "element straight into
 * its storey" shape.
 *
 * @returns The owning project's express id, or `undefined` when the file has
 *   zero or one `IFCPROJECT` (nothing to resolve) or the walk can't reach one
 *   (e.g. a resource-level entity with no containment, a cyclic/malformed
 *   graph). Callers should fall back to the file's default project on
 *   `undefined`, matching prior single-project behaviour.
 */
export function resolveOwningProjectId(
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  relationships: RelatedLookup | undefined,
  expressId: number
): number | undefined {
  const projectIds = entityIndex.byType.get('IFCPROJECT') || [];
  if (projectIds.length <= 1) return undefined;
  if (!relationships) return undefined;

  const projectIdSet = new Set(projectIds);
  const visited = new Set<number>();
  let current: number | undefined = expressId;

  for (let step = 0; current !== undefined && step < MAX_OWNING_PROJECT_WALK_STEPS; step++) {
    if (projectIdSet.has(current)) return current;
    if (visited.has(current)) return undefined; // containment cycle
    visited.add(current);

    const containers = relationships.getRelated(current, RelationshipType.ContainsElements, 'inverse');
    if (containers.length > 0) {
      current = containers[0];
      continue;
    }
    const parents = relationships.getRelated(current, RelationshipType.Aggregates, 'inverse');
    if (parents.length > 0) {
      current = parents[0];
      continue;
    }
    // Resource-level entity with no containment of its own (e.g. a type
    // like IfcWallType): hop to an object it defines and keep walking.
    const definedObjects = relationships.getRelated(current, RelationshipType.DefinesByType, 'forward');
    if (definedObjects.length > 0) {
      current = definedObjects[0];
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Resolve the length unit scale that applies to ONE entity, correctly for a
 * multi-`IfcProject` file (a {@link MergedExporter} `unitReconciliation: 'auto'`
 * federated export: a model whose length unit differs from the first model's
 * keeps its own `IfcProject`/`IfcUnitAssignment` rather than being rescaled —
 * see that module's docs).
 *
 * {@link extractLengthUnitScale} (and the `dataStore.lengthUnitScale` it feeds)
 * answers for the FIRST `IfcProject` only. That is exactly right for the
 * overwhelmingly common single-project file, but silently wrong for a
 * federated entity that belongs to a LATER project: e.g. a material layer's
 * `LayerThickness` is a raw literal in ITS OWN project's unit, and scaling it
 * by the first project's factor corrupts the value by whatever ratio
 * separates the two units (a millimetre federated model read back with the
 * metres factor turns a 300 mm layer into a fabricated "300 m" one).
 *
 * Resolves the entity's owning project via {@link resolveOwningProjectId} and
 * reads that project's units, falling back to the first project's scale when
 * the walk can't place the entity — the same safe-miss direction
 * {@link extractLengthUnitScale} already documents for every other ambiguous
 * case.
 */
export function resolveEntityLengthUnitScale(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  relationships: RelatedLookup,
  expressId: number,
): number {
  const ownerId = resolveOwningProjectId(entityIndex, relationships, expressId);
  return extractLengthUnitScale(source, entityIndex, ownerId);
}
