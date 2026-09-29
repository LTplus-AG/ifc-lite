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

import { EntityExtractor, effectiveStoreyId, resolveEffectiveRelationshipOverlay, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type IfcAttributeValue, type StoreEditor } from '@ifc-lite/mutations';
import { resolvedTypeName } from '@ifc-lite/data';
import { asRef, createStyleEntityReader, refList } from './style-entity-reader.js';
import type { SourceAttributes, SourceAssociation, Vec3 } from './duplicate.js';
import { safeLengthUnitScale } from './length-unit-scale.js';

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

/** A reference slot as the verbatim `#N` token the editor writes back, or null when omitted. */
function refToken(v: unknown): string | null {
  const id = asRef(v);
  return id === null ? null : `#${id}`;
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
  editor?: StoreEditor,
): SourceAttributes {
  if (!store.source) {
    throw new Error('resolveDuplicateSource: data store has no source bytes');
  }
  if (editor?.getMutationView().isDeleted(sourceExpressId)) {
    throw new Error(`resolveDuplicateSource: entity #${sourceExpressId} was deleted`);
  }
  const extractor = new EntityExtractor(store.source);
  // With a session editor, every record is read as the next export writes it:
  // an element created this session (it has no source bytes) and a moved one
  // (its placement point edited) are duplicated as they are now (#6232 C3).
  const read = editor ? createStyleEntityReader(store, editor) : (id: number) => {
    // @raw-entity-enumeration-ok point read of the duplicated source product's own placement chain when no session editor was supplied
    const ref = store.entityIndex.byId.get(id);
    return ref ? extractor.extractEntity(ref) : null;
  };
  const sourceEntity = read(sourceExpressId);
  if (!sourceEntity) {
    throw new Error(`resolveDuplicateSource: entity #${sourceExpressId} not found`);
  }

  const attrs = [...sourceEntity.attributes] as IfcAttributeValue[];
  // OwnerHistory is optional in IFC4, so null is a valid round-trip
  // value here. The duplicate flow re-emits null on the new entity.
  const ownerHistoryId = asRef(attrs[1]);
  const placementId = asRef(attrs[5]);
  const representationId = asRef(attrs[6]);
  // A parsed `#N` is a bare number, which the editor would write back as an
  // INTEGER, not a reference: carry the product's reference slots as `#N`.
  attrs[1] = ownerHistoryId === null ? null : `#${ownerHistoryId}`;
  attrs[6] = representationId === null ? null : `#${representationId}`;

  if (placementId === null) {
    throw new Error(
      `resolveDuplicateSource: #${sourceExpressId} has no ObjectPlacement — only IfcProduct can be duplicated`,
    );
  }
  attrs[5] = `#${placementId}`;

  const placementEntity = read(placementId);
  if (!placementEntity) {
    throw new Error(`resolveDuplicateSource: could not read placement #${placementId}`);
  }

  const parentPlacementId = asRef(placementEntity.attributes[0]);   // PlacementRelTo
  const axisPlacementId = asRef(placementEntity.attributes[1]);     // RelativePlacement
  if (axisPlacementId === null) {
    throw new Error(
      `resolveDuplicateSource: placement #${placementId} has no RelativePlacement`,
    );
  }

  const axisEntity = read(axisPlacementId);
  if (!axisEntity) {
    throw new Error(`resolveDuplicateSource: could not read axis #${axisPlacementId}`);
  }

  const locationId = asRef(axisEntity.attributes[0]);  // Location → IfcCartesianPoint
  const axisRef = refToken(axisEntity.attributes[1]);     // Axis (optional)
  const refDirectionRef = refToken(axisEntity.attributes[2]); // RefDirection (optional)

  let sourceLocation: Vec3 = [0, 0, 0];
  if (locationId !== null) {
    const coords = read(locationId)?.attributes[0];
    if (Array.isArray(coords)) {
      sourceLocation = [
        asNumber(coords[0] as IfcAttributeValue) ?? 0,
        asNumber(coords[1] as IfcAttributeValue) ?? 0,
        asNumber(coords[2] as IfcAttributeValue) ?? 0,
      ];
    }
  }

  // The duplicate must inherit the storey that saving this session would
  // produce, including edited/deleted containment and aggregate ancestors.
  const view = editor?.getMutationView();
  const createdTypes = new Map(view?.getNewEntities().map((e) => [e.expressId, e.type]) ?? []);
  const spatialContext = view?.hasPendingChanges() ? {
    relationships: resolveEffectiveRelationshipOverlay(store, {
      createdEntities: () => view.getNewEntities(),
      mutatedEntityIds: () => view.getEffectiveChanges().map((change) => change.entityId),
      namedAttributes: (id: number) => view.getAttributeMutationsForEntity(id)
        .map(({ name, value }) => [name, value] as const),
      positionalAttributes: (id: number) => view.getPositionalMutationsForEntity(id) ?? [],
      entityType: (id: number) => view.getEntityTypeMutation(id)?.newType,
      isDeleted: (id: number) => view.isDeleted(id),
    }),
    isDeleted: (id: number) => view.isDeleted(id),
    typeName: (id: number) => view.getEntityTypeMutation(id)?.newType
      ?? createdTypes.get(id) ?? store.entities.getTypeName(id),
  } : null;
  const storeyId = effectiveStoreyId(store, sourceExpressId, spatialContext) ?? null;

  // Association rels that reference the source — replayed against
  // the duplicate by `duplicateInStore` so the exported STEP carries
  // the same psets / qsets / material / classifications / documents
  // / type binding.
  const associations = collectSourceAssociations(store, extractor, sourceExpressId, editor);

  // Metres per native unit (0.001 for a millimetre file) — lets the
  // duplicate flow convert its metre offset onto the native-unit
  // sourceLocation. Falls back to 1 (metres) on extraction failure.
  const lengthUnitScale = safeLengthUnitScale(store.source, store.entityIndex, 'resolveDuplicateSource') ?? 1.0;

  // Canonical PascalCase, or the raw STEP type as parsed (#4933).
  const type = resolvedTypeName(store.entities, sourceExpressId) ?? sourceEntity.type;
  if (!type) {
    throw new Error(
      `resolveDuplicateSource: #${sourceExpressId} has no resolvable IFC type — cannot duplicate`,
    );
  }

  return {
    type,
    attributes: attrs,
    placementExpressId: placementId,
    parentPlacementId,
    sourceLocation,
    representationId,
    ownerHistoryId,
    axisRef,
    refDirectionRef,
    storeyId,
    lengthUnitScale,
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
  editor: StoreEditor | undefined,
): SourceAssociation[] {
  const out: SourceAssociation[] = [];
  // The session's effective relationships (#5249): one deleted this session is
  // not replayed onto the duplicate, one created this session (a type binding,
  // a material) is, and a queued edit to a relationship is what gets copied.
  const view = editor?.getMutationView() ?? null;
  const read = editor
    ? createStyleEntityReader(store, editor)
    : (id: number) => {
      // @raw-entity-enumeration-ok point read of one effective candidate's source bytes when no session editor was supplied
      const ref = store.entityIndex.byId.get(id);
      return ref ? extractor.extractEntity(ref) : null;
    };
  for (const { expressId: relId, type } of iterateEffectiveEntityIds(store, view, ASSOCIATION_REL_TYPES)) {
    const entity = read(relId);
    if (!entity) continue;
    // RelatedObjects: a parsed `#N` is a number, an authored one a `#N` string.
    if (!refList(entity.attributes[4]).includes(sourceId)) continue;

    const ownerHistoryId = asRef(entity.attributes[1]);
    const relatingExpressId = asRef(entity.attributes[5]);
    // RelatingPropertyDefinition / RelatingType / etc. is required
    // by the schema, so a missing one is a hard skip. OwnerHistory
    // is optional (IFC4) — null is fine and round-trips cleanly.
    if (relatingExpressId === null) continue;

    const name = typeof entity.attributes[2] === 'string' ? entity.attributes[2] : null;
    const description = typeof entity.attributes[3] === 'string' ? entity.attributes[3] : null;

    // Canonical PascalCase when the table has it; association rels are
    // usually categorised out of the `EntityTable` entirely, so the
    // effective STEP class the iterator reports is the fallback.
    const canonicalRelType = resolvedTypeName(store.entities, relId) ?? type;
    out.push({
      relType: canonicalRelType,
      ownerHistoryId,
      name,
      description,
      relatingExpressId,
    });
  }
  return out;
}
