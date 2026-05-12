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
import type { SourceAttributes, SourceAssociation, Vec3 } from './duplicate.js';

/**
 * Rel types whose `RelatedObjects` list is replayed against a
 * duplicate so the export carries the same psets / qsets / material /
 * classifications / documents / type binding as the source.
 *
 * `IFCRELCONTAINEDINSPATIALSTRUCTURE` is intentionally excluded — the
 * duplicate flow already emits a fresh one anchored to the source's
 * storey (see `duplicate.ts` step 5).
 */
const ASSOCIATION_REL_TYPES = [
  'IFCRELDEFINESBYPROPERTIES',     // psets + qsets (RelatingPropertyDefinition)
  'IFCRELDEFINESBYTYPE',           // type binding
  'IFCRELASSOCIATESMATERIAL',
  'IFCRELASSOCIATESCLASSIFICATION',
  'IFCRELASSOCIATESDOCUMENT',
] as const;

function asString(v: IfcAttributeValue | undefined): string {
  if (v === null || v === undefined) return '$';
  if (typeof v === 'number') return `#${v}`;
  if (typeof v === 'string') return v;
  return '$';
}

/**
 * Like asString but maps the omitted-token sentinel (`$`) to `null`.
 * The editor serialises plain strings as quoted STEP literals, so the
 * verbatim `'$'` would land as `'$'` in output instead of the bare token.
 */
function asRefOrNull(v: IfcAttributeValue | undefined): string | null {
  const s = asString(v);
  return s === '$' ? null : s;
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
  // OwnerHistory is optional in IFC4, so null is a valid round-trip
  // value here. The duplicate flow re-emits null on the new entity.
  const ownerHistoryId = asNumber(attrs[1]);
  const placementId = asNumber(attrs[5]);
  const representationId = asNumber(attrs[6]);

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
  const axisRef = asRefOrNull(axisEntity.attributes[1]);     // Axis (optional)
  const refDirectionRef = asRefOrNull(axisEntity.attributes[2]); // RefDirection (optional)

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

  // Association rels that reference the source — replayed against
  // the duplicate by `duplicateInStore` so the exported STEP carries
  // the same psets / qsets / material / classifications / documents
  // / type binding.
  const associations = collectSourceAssociations(store, extractor, sourceExpressId);

  return {
    // Canonical PascalCase (e.g. "IfcWall"); falls back to the raw
    // extractor type when the entity table doesn't recognise the id
    // (vendor extensions etc).
    type: store.entities.getTypeName(sourceExpressId) || sourceEntity.type,
    attributes: attrs,
    placementExpressId: placementId,
    parentPlacementId,
    sourceLocation,
    representationId,
    ownerHistoryId,
    axisRef,
    refDirectionRef,
    storeyId,
    associations,
  };
}

/**
 * Walk the parsed entity index for every association rel type and
 * gather the ones whose `RelatedObjects` list contains `sourceId`.
 * Returns one `SourceAssociation` per matching rel — duplicate flow
 * emits a fresh rel of the same type pointing at the duplicate.
 */
function collectSourceAssociations(
  store: IfcDataStore,
  extractor: EntityExtractor,
  sourceId: number,
): SourceAssociation[] {
  const out: SourceAssociation[] = [];
  for (const relType of ASSOCIATION_REL_TYPES) {
    const ids = store.entityIndex.byType.get(relType);
    if (!ids || ids.length === 0) continue;
    for (const relId of ids) {
      const ref = store.entityIndex.byId.get(relId);
      if (!ref) continue;
      const entity = extractor.extractEntity(ref);
      if (!entity) continue;

      const related = entity.attributes[4];
      // RelatedObjects is a STEP set serialised as a JS array. The
      // parser returns each `#N` as a plain number — we look for the
      // source id by direct membership, not by string match.
      if (!Array.isArray(related)) continue;
      let referencesSource = false;
      for (const member of related) {
        if (typeof member === 'number' && member === sourceId) {
          referencesSource = true;
          break;
        }
      }
      if (!referencesSource) continue;

      const ownerHistoryId = asNumber(entity.attributes[1]);
      const relatingExpressId = asNumber(entity.attributes[5]);
      // RelatingPropertyDefinition / RelatingType / etc. is required
      // by the schema, so a missing one is a hard skip. OwnerHistory
      // is optional (IFC4) — null is fine and round-trips cleanly.
      if (relatingExpressId === null) continue;

      const name = typeof entity.attributes[2] === 'string' ? entity.attributes[2] : null;
      const description = typeof entity.attributes[3] === 'string' ? entity.attributes[3] : null;

      // Use the entity table's canonical name so the duplicate replays
      // a PascalCase type into the editor (e.g. "IfcRelDefinesByProperties"),
      // not the byType map's UPPERCASE storage key.
      const canonicalRelType = store.entities.getTypeName(relId) || relType;
      out.push({
        relType: canonicalRelType,
        ownerHistoryId,
        name,
        description,
        relatingExpressId,
      });
    }
  }
  return out;
}
