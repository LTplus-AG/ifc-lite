/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute extraction for spatial hierarchy nodes - reads a node's LongName,
 * its IfcBuildingStorey Elevation, and the ObjectPlacement-Z fallback
 * straight off the raw IFC records via `EntityExtractor`.
 *
 * Split out of spatial-hierarchy-builder.ts: these three functions share one
 * concern - resolving values from source bytes when a source is available -
 * distinct from the tree-building recursion in `buildNode` that calls them.
 * Same pattern as spatial-hierarchy-canonical-parent.ts, which split out the
 * cycle-safe canonical-parent resolution for the same reason.
 */

import {
  createLogger,
  IFC_BUILDING_STOREY_ELEVATION_INDEX,
  IFC_BUILDING_STOREY_PLACEMENT_INDEX,
} from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import type { IfcSourceBytes } from './source-bytes.js';
import { getAttributeNamesAcrossSchemas } from './ifc-schema.js';

const log = createLogger('SpatialHierarchy');

/** Source bytes needed to read on-demand attributes off the raw records
 *  (storey elevation, LongName). Present on the fresh-parse / cache-with-source
 *  path, absent on the source-less `buildFromCache` fallback. */
export interface AttributeSource {
  source: Uint8Array | IfcSourceBytes;
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined } };
  lengthUnitScale: number;
}

/**
 * Read an entity's LongName by schema attribute *name*. IfcSite / IfcBuilding /
 * IfcBuildingStorey / IfcSpace (and the IFC4.3 facility/infra containers)
 * declare LongName at index 7, but IfcProject carries it at a different slot,
 * so resolving by name (not a fixed index) stays correct across the IfcRoot
 * family. The lookup spans every bundled schema, so IFC4.3 leaves outside the
 * parser's IFC4 codegen pin resolve too. Returns the trimmed value, or
 * undefined when the type declares no LongName, it is empty, or no source
 * buffer is available (the buildFromCache path).
 */
export function extractLongName(
  expressId: number,
  attrSource: AttributeSource | undefined,
  attrExtractor: EntityExtractor | undefined
): string | undefined {
  if (!attrSource || !attrExtractor) return undefined;
  const ref = attrSource.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  try {
    const entity = attrExtractor.extractEntity(ref);
    if (!entity) return undefined;
    const idx = getAttributeNamesAcrossSchemas(entity.type).indexOf('LongName');
    if (idx < 0) return undefined;
    const raw = (entity.attributes || [])[idx];
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value.length > 0 ? value : undefined;
  } catch (error) {
    log.caught('Failed to extract LongName', error, {
      operation: 'extractLongName',
      entityId: expressId,
    });
    return undefined;
  }
}

/**
 * Extract elevation from an IfcBuildingStorey. Elevation is attribute index 9
 * in both IFC2x3 and IFC4 (GlobalId, OwnerHistory, Name, Description,
 * ObjectType, ObjectPlacement, Representation, LongName, CompositionType,
 * Elevation).
 */
export function extractElevation(
  expressId: number,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined } }
): number | undefined {
  const ref = entityIndex.byId.get(expressId);
  if (!ref) return undefined;

  try {
    const extractor = new EntityExtractor(source);
    const entity = extractor.extractEntity(ref);
    if (!entity) return undefined;

    const attrs = entity.attributes || [];

    // Number from a raw value or a typed value like ['IFCLENGTHMEASURE', 3.0].
    const extractNumber = (val: any): number | undefined => {
      if (typeof val === 'number') return val;
      if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') {
        return val[1];
      }
      return undefined;
    };

    // Read ONLY the Elevation slot: a previous "scan every attribute for a
    // number < 10000" fallback wrongly treated reference attributes (parsed as
    // bare express-id numbers, e.g. OwnerHistory #3628 -> 3628) as elevations,
    // so a storey with a null Elevation got a garbage value instead of falling
    // through to the ObjectPlacement-Z fallback below (#1289).
    if (attrs.length > IFC_BUILDING_STOREY_ELEVATION_INDEX) {
      return extractNumber(attrs[IFC_BUILDING_STOREY_ELEVATION_INDEX]);
    }
  } catch (error) {
    log.caught('Failed to extract elevation', error, {
      operation: 'extractElevation',
      entityId: expressId,
      entityType: 'IfcBuildingStorey',
    });
  }

  return undefined;
}

/**
 * Resolve a storey's elevation from its ObjectPlacement, used as a fallback when
 * the Elevation attribute is null. Walks
 *   IfcBuildingStorey.ObjectPlacement (IfcLocalPlacement)
 *     -> RelativePlacement (IfcAxis2Placement3D)
 *       -> Location (IfcCartesianPoint).Coordinates[2]
 * i.e. the storey's Z relative to its parent spatial container, which matches
 * the semantics of the Elevation attribute and avoids folding in any site-level
 * georeferencing Z. Returns the raw (unscaled) Z, or undefined when the chain
 * can't be resolved.
 */
export function extractPlacementElevation(
  expressId: number,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined } }
): number | undefined {
  try {
    const extractor = new EntityExtractor(source);
    const readAttrs = (id: number): unknown[] | undefined => {
      const ref = entityIndex.byId.get(id);
      if (!ref) return undefined;
      return extractor.extractEntity(ref)?.attributes ?? undefined;
    };

    const placementId = readAttrs(expressId)?.[IFC_BUILDING_STOREY_PLACEMENT_INDEX];
    if (typeof placementId !== 'number') return undefined;

    // IfcLocalPlacement(PlacementRelTo, RelativePlacement) - RelativePlacement
    // (index 1) is the IfcAxis2Placement3D carrying this storey's own offset.
    const axisId = readAttrs(placementId)?.[1];
    if (typeof axisId !== 'number') return undefined;

    // IfcAxis2Placement3D(Location, Axis, RefDirection) - Location (index 0) is
    // an IfcCartesianPoint.
    const locationId = readAttrs(axisId)?.[0];
    if (typeof locationId !== 'number') return undefined;

    // IfcCartesianPoint.Coordinates (index 0) is a list [x, y, z].
    const coords = readAttrs(locationId)?.[0];
    if (Array.isArray(coords) && coords.length >= 3 && typeof coords[2] === 'number') {
      return coords[2];
    }
  } catch (error) {
    log.caught('Failed to extract placement elevation', error, {
      operation: 'extractPlacementElevation',
      entityId: expressId,
      entityType: 'IfcBuildingStorey',
    });
  }

  return undefined;
}
