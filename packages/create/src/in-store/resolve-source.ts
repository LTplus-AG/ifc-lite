/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pull the `SourceAttributes` shape consumed by `duplicateInStore`
 * from a parsed `IfcDataStore`. Resolves the source entity's
 * positional attributes, walks the placement chain to find its
 * cartesian-point location and parent placement, and looks up the
 * containing storey.
 *
 * Lives in @ifc-lite/create alongside the in-store builders so the
 * backend layer can call it without needing parser internals.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import type { SourceAttributes, Vec3 } from './duplicate.js';

function asString(v: IfcAttributeValue | undefined): string {
  if (v === null || v === undefined) return '$';
  if (typeof v === 'number') return `#${v}`;
  if (typeof v === 'string') return v;
  return '$';
}

function asNumber(v: IfcAttributeValue | undefined): number | null {
  if (typeof v === 'number') return v;
  return null;
}

/**
 * Resolve everything `duplicateInStore` needs to clone a source
 * IfcRoot product. Throws when the source isn't an IfcProduct
 * (no ObjectPlacement at index 5).
 */
export function resolveDuplicateSource(
  store: IfcDataStore,
  sourceExpressId: number,
): SourceAttributes {
  if (!store.source) {
    throw new Error('resolveDuplicateSource: data store has no source bytes');
  }
  const sourceRef = store.entityIndex.byId.get(sourceExpressId);
  if (!sourceRef) {
    throw new Error(`resolveDuplicateSource: entity #${sourceExpressId} not found`);
  }

  const extractor = new EntityExtractor(store.source);
  const sourceEntity = extractor.extractEntity(sourceRef);
  if (!sourceEntity) {
    throw new Error(`resolveDuplicateSource: could not parse #${sourceExpressId}`);
  }

  const attrs = sourceEntity.attributes;
  const ownerHistoryId = asNumber(attrs[1]);
  const placementId = asNumber(attrs[5]);
  const representationId = asNumber(attrs[6]);

  if (ownerHistoryId === null) {
    throw new Error(
      `resolveDuplicateSource: #${sourceExpressId} has no OwnerHistory — only IfcRoot products can be duplicated`,
    );
  }
  if (placementId === null) {
    throw new Error(
      `resolveDuplicateSource: #${sourceExpressId} has no ObjectPlacement — only IfcProduct can be duplicated`,
    );
  }

  const placementRef = store.entityIndex.byId.get(placementId);
  if (!placementRef) {
    throw new Error(`resolveDuplicateSource: placement #${placementId} missing from index`);
  }
  const placementEntity = extractor.extractEntity(placementRef);
  if (!placementEntity) {
    throw new Error(`resolveDuplicateSource: could not parse placement #${placementId}`);
  }

  const parentPlacementId = asNumber(placementEntity.attributes[0]);   // PlacementRelTo
  const axisPlacementId = asNumber(placementEntity.attributes[1]);     // RelativePlacement
  if (axisPlacementId === null) {
    throw new Error(
      `resolveDuplicateSource: placement #${placementId} has no RelativePlacement`,
    );
  }

  const axisPlacementRef = store.entityIndex.byId.get(axisPlacementId);
  if (!axisPlacementRef) {
    throw new Error(`resolveDuplicateSource: axis placement #${axisPlacementId} missing`);
  }
  const axisEntity = extractor.extractEntity(axisPlacementRef);
  if (!axisEntity) {
    throw new Error(`resolveDuplicateSource: could not parse axis #${axisPlacementId}`);
  }

  const locationId = asNumber(axisEntity.attributes[0]);  // Location → IfcCartesianPoint
  const axisRef = asString(axisEntity.attributes[1]);     // Axis (optional)
  const refDirectionRef = asString(axisEntity.attributes[2]); // RefDirection (optional)

  let sourceLocation: Vec3 = [0, 0, 0];
  if (locationId !== null) {
    const pointRef = store.entityIndex.byId.get(locationId);
    if (pointRef) {
      const pointEntity = extractor.extractEntity(pointRef);
      const coords = pointEntity?.attributes[0];
      if (Array.isArray(coords)) {
        sourceLocation = [
          asNumber(coords[0]) ?? 0,
          asNumber(coords[1]) ?? 0,
          asNumber(coords[2]) ?? 0,
        ];
      }
    }
  }

  // Containing storey lookup via the pre-built spatial hierarchy.
  // Falls back to null when the entity sits outside the spatial tree.
  const storeyId = store.spatialHierarchy?.elementToStorey?.get(sourceExpressId) ?? null;

  return {
    type: sourceEntity.type.toUpperCase(),
    attributes: attrs,
    placementExpressId: placementId,
    parentPlacementId,
    sourceLocation,
    representationId,
    ownerHistoryId,
    axisRef,
    refDirectionRef,
    storeyId,
  };
}
