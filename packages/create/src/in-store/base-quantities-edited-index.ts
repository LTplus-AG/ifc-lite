/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which loaded walls, slabs, roofs, columns and beams the overlay may have
 * reshaped, so an export reads only those for a quantity refresh
 * (`base-quantities-refresh.ts`). A candidate is not yet "edited": the caller
 * compares its live and file geometry. This only keeps the export from
 * deriving every element of a large file.
 *
 * Any edit of an element's shape overrides, retypes or deletes some record the
 * FILE's version of that element reaches: its body, its placement's own axis,
 * one of its openings, or the element itself (a new record the edit adds is
 * reached through an overridden one). So the index maps every record an
 * element's file geometry reaches back to the element, once per store; the
 * file never changes, so the index never goes stale. An opening the session
 * adds to a loaded host names that host itself.
 *
 * Shared records (a storey's placement, the representation context) are not
 * walked: the placement only up to the element's own axis, the context not at
 * all. A shared record that is walked (a type's mapped body) makes every
 * element using it a candidate, which is correct, only slower.
 */

import { RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { BASE_QUANTITY_TYPES, effectiveElementType } from './base-quantities-kinds.js';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';
import { groupRecordReferences } from './group-graph.js';

/** Records one element's file geometry may reach before it counts as a candidate whatever is edited. */
const RECORDS_PER_ELEMENT = 20_000;
/** Records the whole index may visit before every supported element counts as a candidate. */
const RECORDS_PER_STORE = 5_000_000;
const SKIPPED_TYPES = new Set(['IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT']);

interface EditedIndex {
  /** Record id to the supported elements whose file geometry reaches it. */
  readonly reachedBy: Map<number, number[]>;
  /** Elements counted as candidates whatever is edited: a walk ran out of budget. */
  readonly always: number[];
  /** The whole index ran out of budget: every supported element is a candidate. */
  readonly all: number[] | null;
}

const indexes = new WeakMap<IfcDataStore, EditedIndex>();

/** Whether the walk passes through `id`: a record the file has, and not a shared context. */
function walkable(dataStore: IfcDataStore, id: number): boolean {
  // @raw-entity-enumeration-ok the index reads the FILE's geometry on purpose; the overlay is compared by the caller
  const ref = dataStore.entityIndex?.byId.get(id);
  return !!ref && !SKIPPED_TYPES.has(ref.type.toUpperCase());
}

/** The source record's own text, or null for an id the file does not have. */
function recordText(dataStore: IfcDataStore, id: number): string | null {
  // @raw-entity-enumeration-ok the index reads the FILE's geometry on purpose; the overlay is compared by the caller
  const ref = dataStore.entityIndex?.byId.get(id);
  if (!ref || !dataStore.source) return null;
  return dataStore.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
}

function decoded(dataStore: IfcDataStore, extractor: EntityExtractor, id: number): unknown[] | null {
  // @raw-entity-enumeration-ok the index reads the FILE's geometry on purpose; the overlay is compared by the caller
  const ref = dataStore.entityIndex?.byId.get(id);
  return ref ? extractor.extractEntity(ref)?.attributes ?? null : null;
}

function buildIndex(dataStore: IfcDataStore): EditedIndex {
  const reachedBy = new Map<number, number[]>();
  const always: number[] = [];
  const elements: number[] = [];
  for (const type of BASE_QUANTITY_TYPES) {
    // @raw-entity-enumeration-ok the file's own elements; an overlay-created one has its own path
    for (const id of dataStore.entityIndex?.byType.get(type) ?? []) elements.push(id);
  }
  if (!dataStore.source?.length) return { reachedBy, always, all: elements };
  const extractor = new EntityExtractor(dataStore.source);
  let visitedInStore = 0;

  for (const element of elements) {
    const reached = new Set<number>([element]);
    const queue: number[] = [];
    let ok = true;
    const walkFrom = (id: unknown) => {
      const ref = asExpressIdRef(id);
      if (ref === null || reached.has(ref) || !walkable(dataStore, ref)) return;
      reached.add(ref);
      queue.push(ref);
    };
    // The placement only as far as its own axis: what it is placed relative to is shared.
    const placeOf = (attributes: unknown[] | null) => {
      const placement = asExpressIdRef(attributes?.[5]);
      if (placement === null) return;
      reached.add(placement);
      walkFrom(decoded(dataStore, extractor, placement)?.[1]);
    };
    try {
      const attributes = decoded(dataStore, extractor, element);
      placeOf(attributes);
      walkFrom(attributes?.[6]);
      for (const opening of dataStore.relationships?.getRelated(element, RelationshipType.VoidsElement, 'forward') ?? []) {
        for (const rel of dataStore.relationships.getRelationshipsBetween(element, opening)) reached.add(rel.relationshipId);
        reached.add(opening);
        const own = decoded(dataStore, extractor, opening);
        placeOf(own);
        walkFrom(own?.[6]);
      }
      while (queue.length > 0) {
        if (reached.size > RECORDS_PER_ELEMENT) { ok = false; break; }
        const text = recordText(dataStore, queue.pop()!);
        if (text) for (const ref of groupRecordReferences(text)) walkFrom(ref);
      }
    } catch (error) {
      console.warn(`[quantities] #${element}'s geometry could not be indexed; it is read on every export`, error);
      ok = false;
    }
    if (!ok) { always.push(element); continue; }
    visitedInStore += reached.size;
    if (visitedInStore > RECORDS_PER_STORE) {
      console.warn('[quantities] the file is too large to index edited elements; every wall, slab, roof, column and beam is read on export');
      return { reachedBy: new Map(), always: [], all: elements };
    }
    for (const id of reached) {
      const list = reachedBy.get(id);
      if (list) list.push(element);
      else reachedBy.set(id, [element]);
    }
  }
  return { reachedBy, always, all: null };
}

/**
 * Loaded supported elements whose geometry the overlay may have changed.
 * Empty, without building the index, while the overlay touches no file record.
 */
export function editedElementCandidates(dataStore: IfcDataStore, view: MutablePropertyView): Set<number> {
  const candidates = new Set<number>();
  const touched = new Set<number>([...view.getAttributeOverrideEntityIds(), ...view.getTombstones()]);
  for (const rel of view.getNewEntitiesOfType('IFCRELVOIDSELEMENT')) {
    // A host is the relationship's RelatingBuildingElement (4); an authored host has its own path.
    const host = asExpressIdRef(readAttributes(dataStore, view, view, rel.expressId)?.[4]);
    if (host !== null && !view.getNewEntity(host)) candidates.add(host);
  }
  if (touched.size === 0) return candidates;
  for (const id of touched) {
    if (view.getNewEntity(id)) continue;
    const type = effectiveElementType(dataStore, view, id);
    // A loaded element retyped into a supported kind is its own candidate.
    if (BASE_QUANTITY_TYPES.includes(type)) candidates.add(id);
    // A file void relationship re-pointed at another loaded host: the index knows only its old one.
    if (type === 'IFCRELVOIDSELEMENT' && !view.isDeleted(id)) {
      const host = asExpressIdRef(readAttributes(dataStore, view, view, id)?.[4]);
      if (host !== null && !view.getNewEntity(host)) candidates.add(host);
    }
  }
  let index = indexes.get(dataStore);
  if (!index) indexes.set(dataStore, index = buildIndex(dataStore));
  if (index.all) return new Set([...candidates, ...index.all]);
  for (const id of index.always) candidates.add(id);
  for (const id of touched) for (const element of index.reachedBy.get(id) ?? []) candidates.add(element);
  return candidates;
}
