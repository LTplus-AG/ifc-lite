/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import { type MutablePropertyView } from '@ifc-lite/mutations';
import { collectRefsInByteRange } from './reference-collector.js';
import { getCompleteEntityIndex } from './entity-iteration.js';
import { effectiveCreatedRecord, effectiveSourceRecord } from './effective-source-record.js';

/** The parsed source/index are immutable. Build their reverse references once
 * per loaded model; slot edits and indexed created-reference candidates are read per edit. */
const sourceReferences = new WeakMap<IfcDataStore, {
  source: IfcDataStore['source'];
  primary: IfcDataStore['entityIndex']['byId'];
  deferred: IfcDataStore['deferredEntityIndex'];
  inverse: Map<number, number[]>;
}>();

function sourceInverse(store: IfcDataStore): Map<number, number[]> {
  const cached = sourceReferences.get(store);
  // @raw-entity-enumeration-ok identity comparison only; enumeration below uses the complete index
  if (cached?.source === store.source && cached.primary === store.entityIndex.byId
    && cached.deferred === store.deferredEntityIndex) return cached.inverse;
  const inverse = new Map<number, number[]>();
  for (const [id, record] of getCompleteEntityIndex(store)) {
    for (const ref of new Set(collectRefsInByteRange(store.source, record.byteOffset, record.byteLength))) {
      if (ref === id) continue;
      const parents = inverse.get(ref) ?? [];
      parents.push(id); inverse.set(ref, parents);
    }
  }
  // @raw-entity-enumeration-ok retain immutable index identity only for inverse-cache invalidation
  sourceReferences.set(store, { source: store.source, primary: store.entityIndex.byId, deferred: store.deferredEntityIndex, inverse });
  return inverse;
}

/**
 * The live reverse-reference lookup: which entities reference `id` once the
 * overlay is applied (created records, edited source records and tombstones).
 * The immutable source inverse is cached per model; authored and edited
 * creations are read by indexed reference candidate on demand.
 * Build one lookup per synchronous planning request.
 */
export function effectiveReferencers(store: IfcDataStore, view: MutablePropertyView): (id: number) => readonly number[] {
  const baseline = sourceInverse(store);
  const encoder = new TextEncoder();
  const cached = new Map<number, readonly number[]>();
  return (id) => {
    const found = cached.get(id);
    if (found) return found;
    const parents: number[] = [], original = new Set(baseline.get(id));
    const candidates = new Set([
      ...original, ...view.getAttributeOverrideReferenceCandidates(id),
      ...Array.from(view.getNewEntitiesReferencing(id), entity => entity.expressId),
    ]);
    // Candidate indices may over-count. Only the exact exporter grammar decides
    // whether a queued slot edit actually writes a reference (including REAL
    // rejection, quoted SELECT/string values and deferred source atoms).
    for (const expressId of candidates) {
      if (expressId === id || view.isDeleted(expressId)) continue;
      const created = effectiveCreatedRecord(view, expressId, store.schemaVersion);
      let text: string;
      if (created) text = created.text;
      else {
        if (!view.getPositionalMutationsForEntity(expressId)?.size && !view.getAttributeMutationsForEntity(expressId).length && !view.getEntityTypeMutation(expressId)) {
          if (original.has(expressId)) parents.push(expressId);
          continue;
        }
        // @raw-entity-enumeration-ok point lookup of a candidate's immutable bytes, including deferred atoms
        const source = store.entityIndex.byId.get(expressId) ?? store.deferredEntityIndex?.get(expressId);
        if (!source) continue;
        text = effectiveSourceRecord(view, expressId, store.source.decodeUtf8(source.byteOffset, source.byteOffset + source.byteLength), source.type, store.schemaVersion).text;
      }
      const bytes = encoder.encode(text);
      if (collectRefsInByteRange(bytes, 0, bytes.length).includes(id)) parents.push(expressId);
    }
    cached.set(id, parents);
    return parents;
  };
}

/** In-place writes may only affect the requested products. A shared geometry
 * or placement leaf is refused before writing rather than moving/resizing a
 * second occurrence. Reverse walks stop at products and are iterative. */
export function editOwnershipRefusal(
  store: IfcDataStore, view: MutablePropertyView, writtenIds: readonly number[], allowedProducts: ReadonlySet<number>,
): string | null {
  if (writtenIds.length === 0) return null;
  const referencers = effectiveReferencers(store, view);
  const queue = [...writtenIds], visited = new Set<number>();
  while (queue.length) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (view.isDeleted(id)) continue;
    // @raw-entity-enumeration-ok point class fallback after tombstone, retype and created-record handling
    const type = view.getEntityTypeMutation(id)?.newType ?? view.getNewEntity(id)?.type ?? store.entityIndex.byId.get(id)?.type;
    if (type && getInheritanceChainAcrossSchemas(type).includes('IfcProduct')) {
      if (!allowedProducts.has(id)) return `The edit shares placement or geometry with #${id}; shared occurrences cannot be edited in place`;
      continue;
    }
    queue.push(...referencers(id));
  }
  return null;
}
