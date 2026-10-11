/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getReference } from './attribute-helpers.js';
import { normalizeIfcTypeName } from './ifc-schema.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { resolveEffectiveRelationshipOverlay } from './effective-relationship-overlay.js';

/** Existing normalized document fields; identity describes the associated native target. */
export interface DocumentInfo {
  name?: string;
  description?: string;
  location?: string;
  identification?: string;
  purpose?: string;
  intendedUse?: string;
  revision?: string;
  confidentiality?: string;
  expressId?: number;
  type?: string;
  referencedDocumentId?: number;
  /** Known association with unavailable source fields or an unreadable target. */
  unresolved?: boolean;
  /** Immutable forwarded association rather than a proved current membership. */
  sourceOrigin?: boolean;
}

interface DocumentEdges { references: Map<number, number[]>; types: Map<number, number[]> }
const cache = new WeakMap<IfcDataStore, WeakMap<MetadataReadView, { revision: number; source: IfcDataStore['source']; edges: DocumentEdges }>>();

function effectiveEdges(store: IfcDataStore, view: MetadataReadView): DocumentEdges {
  const revision = view.getMutationRevision();
  const previous = cache.get(store)?.get(view);
  if (previous?.revision === revision && previous.source === store.source) return previous.edges;
  const kinds = ['IFCRELASSOCIATESDOCUMENT', 'IFCRELDEFINESBYTYPE'];
  // @raw-entity-enumeration-ok native source relationship ids feed the canonical effective relationship reader
  const sourceIds = kinds.flatMap(type => store.entityIndex.byType.get(type) ?? []);
  sourceIds.push(...(view.getTypeMutations?.().keys() ?? []));
  const overlay = resolveEffectiveRelationshipOverlay(store.source?.length ? store : { ...store, getEntity: () => null }, {
    createdEntities: () => view.getNewEntities(), mutatedEntityIds: () => sourceIds,
    namedAttributes: id => view.getAttributeMutationsForEntity(id).map(row => [row.name, row.value] as const),
    positionalAttributes: id => view.getPositionalMutationsForEntity(id) ?? [],
    entityType: id => view.getTypeMutations?.().get(id)?.newType,
    isDeleted: id => view.isDeleted(id),
  });
  const edges: DocumentEdges = { references: new Map(), types: new Map() };
  for (const relation of overlay.relationships) {
    const type = relation.relationshipType.toUpperCase();
    const target = type === kinds[0] ? edges.references : type === kinds[1] ? edges.types : null;
    if (!target) continue;
    for (const subject of relation.related) {
      if (view.isDeleted(subject)) continue;
      const values = target.get(subject) ?? [];
      for (const id of relation.relating) if (!values.includes(id)) values.push(id);
      target.set(subject, values);
    }
  }
  let modelCache = cache.get(store);
  if (!modelCache) { modelCache = new WeakMap(); cache.set(store, modelCache); }
  modelCache.set(view, { revision, source: store.source, edges });
  return edges;
}

function forwardedReferences(store: IfcDataStore, subjects: number[]): number[] {
  const references = (id: number) => store.onDemandDocumentMap
    ? store.onDemandDocumentMap.get(id) ?? []
    : store.relationships?.getRelated(id, RelationshipType.AssociatesDocument, 'inverse') ?? [];
  const types = subjects.flatMap(id => store.relationships?.getRelated(id, RelationshipType.DefinesByType, 'inverse') ?? []);
  return [...subjects, ...types].flatMap(references);
}

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
function informationFields(attributes: unknown[]): DocumentInfo {
  return { identification: text(attributes[0]), name: text(attributes[1]), description: text(attributes[2]),
    location: text(attributes[3]), purpose: text(attributes[4]), intendedUse: text(attributes[5]),
    revision: text(attributes[7]), confidentiality: text(attributes[15]) };
}

function documentRecord(store: IfcDataStore, id: number, view?: MetadataReadView): DocumentInfo {
  const record = effectiveMetadataRecord(store, id, view);
  const identity = { expressId: id, type: record ? normalizeIfcTypeName(record.type) : undefined };
  if (!record) return { ...identity, unresolved: true };
  const attrs = record.attributes;
  const unreadable = !store.source?.length && !view?.getNewEntity(id);
  if (record.type.toUpperCase() === 'IFCDOCUMENTINFORMATION') {
    return { ...identity, ...informationFields(attrs), ...(unreadable ? { unresolved: true } : {}) };
  }
  if (record.type.toUpperCase() !== 'IFCDOCUMENTREFERENCE') return { ...identity, unresolved: true };
  const result: DocumentInfo = { ...identity, location: text(attrs[0]), identification: text(attrs[1]), name: text(attrs[2]),
    description: store.schemaVersion === 'IFC2X3' ? undefined : text(attrs[3]), ...(unreadable ? { unresolved: true } : {}) };
  // IFC4 has exactly one ReferencedDocument hop. No recursive document walk.
  const target = store.schemaVersion === 'IFC2X3' ? null : getReference(attrs[4]);
  if (target !== null && target !== undefined) {
    result.referencedDocumentId = target;
    const info = effectiveMetadataRecord(store, target, view);
    if (info?.type.toUpperCase() === 'IFCDOCUMENTINFORMATION') {
      const fields = informationFields(info.attributes);
      result.identification ??= fields.identification;
      result.name ??= fields.name;
      result.description ??= fields.description;
      result.location ??= fields.location;
      result.purpose = fields.purpose; result.intendedUse = fields.intendedUse;
      result.revision = fields.revision; result.confidentiality = fields.confidentiality;
      if (!store.source?.length && !view?.getNewEntity(target)) result.unresolved = true;
    } else result.unresolved = true;
  }
  return result;
}

/** One canonical native document reader for Properties, SDK and selected evidence (#7187). */
export function extractDocumentsOnDemand(store: IfcDataStore, entityId: number, view?: MetadataReadView): DocumentInfo[] {
  if (view?.isDeleted(entityId)) return [];
  const baseId = view?.resolveBaseEntityId?.(entityId) ?? entityId;
  const subjects = baseId === entityId ? [entityId] : [entityId, baseId];
  const edges = view ? effectiveEdges(store, view) : null;
  const live = edges ? [...subjects, ...subjects.flatMap(id => edges.types.get(id) ?? [])]
    .flatMap(id => edges.references.get(id) ?? []) : [];
  if (store.source?.length) {
    return [...new Set(edges ? live : forwardedReferences(store, subjects))].map(id => documentRecord(store, id, view));
  }
  // Retained source closures cannot reconstruct absent bytes. Forwarded graph
  // rows remain known source-origin markers; complete authored rows are separate.
  const original = new Set(forwardedReferences(store, subjects));
  const markers: DocumentInfo[] = [...original].map(id => {
    // @raw-entity-enumeration-ok class identity of a forwarded immutable source-origin marker, not a current entity enumeration
    const type = store.entityIndex.byId.get(id)?.type ?? store.entities.getTypeName(id);
    return { expressId: id, type: normalizeIfcTypeName(type), unresolved: true, sourceOrigin: true };
  });
  return [...markers, ...[...new Set(live)].filter(id => !original.has(id)).map(id => documentRecord(store, id, view))];
}
