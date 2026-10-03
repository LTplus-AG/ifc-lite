/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import { type MutablePropertyView } from '@ifc-lite/mutations';
import { collectRefsInByteRange } from './reference-collector.js';
import { getCompleteEntityIndex } from './entity-iteration.js';
import { effectiveCreatedRecord, effectiveSourceRecord } from './effective-source-record.js';

/** The parsed source/index are immutable. Build their reverse references once
 * per loaded model; only the live overlay is rescanned for each edit. */
const sourceReferences = new WeakMap<IfcDataStore, {
  source: IfcDataStore['source'];
  primary: IfcDataStore['entityIndex']['byId'];
  deferred: IfcDataStore['deferredEntityIndex'];
  inverse: Map<number, number[]>;
}>();

function sourceInverse(store: IfcDataStore): Map<number, number[]> {
  const cached = sourceReferences.get(store);
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
  sourceReferences.set(store, { source: store.source, primary: store.entityIndex.byId, deferred: store.deferredEntityIndex, inverse });
  return inverse;
}

/** In-place writes may only affect the requested products. A shared geometry
 * or placement leaf is refused before writing rather than moving/resizing a
 * second occurrence. Reverse walks stop at products and are iterative. */
export function editOwnershipRefusal(
  store: IfcDataStore, view: MutablePropertyView, writtenIds: readonly number[], allowedProducts: ReadonlySet<number>,
): string | null {
  if (writtenIds.length === 0) return null;
  const baseline = sourceInverse(store), inverse = new Map<number, number[]>();
  const changed = new Set(view.getEffectiveChanges().map(change => change.entityId));
  for (const entity of view.getNewEntities()) changed.add(entity.expressId);
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  for (const expressId of changed) {
    if (view.getTombstones().has(expressId)) continue;
    const created = effectiveCreatedRecord(view, expressId, store.schemaVersion);
    // Raw point lookup supplies only a changed record's immutable byte range.
    const source = created ? undefined : store.entityIndex.byId.get(expressId);
    let refs: number[];
    if (created) {
      const bytes = encoder.encode(created.text);
      refs = collectRefsInByteRange(bytes, 0, bytes.length);
    } else if (source) {
      if (view.getPositionalMutationsForEntity(expressId)?.size || view.getAttributeMutationsForEntity(expressId).length || view.getEntityTypeMutation(expressId)) {
        const text = decoder.decode(store.source.slice(source.byteOffset, source.byteOffset + source.byteLength));
        const effective = effectiveSourceRecord(view, expressId, text, source.type, store.schemaVersion);
        const bytes = encoder.encode(effective.text);
        refs = collectRefsInByteRange(bytes, 0, bytes.length);
      } else refs = collectRefsInByteRange(store.source, source.byteOffset, source.byteLength);
    } else continue;
    for (const ref of new Set(refs)) {
      if (ref === expressId) continue;
      const parents = inverse.get(ref) ?? [];
      parents.push(expressId); inverse.set(ref, parents);
    }
  }
  const queue = [...writtenIds], visited = new Set<number>();
  while (queue.length) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (view.getTombstones().has(id)) continue;
    const type = view.getEntityTypeMutation(id)?.newType ?? view.getNewEntity(id)?.type ?? store.entityIndex.byId.get(id)?.type;
    if (type && getInheritanceChainAcrossSchemas(type).includes('IfcProduct')) {
      if (!allowedProducts.has(id)) return `The edit shares placement or geometry with #${id}; shared occurrences cannot be edited in place`;
      continue;
    }
    for (const parent of baseline.get(id) ?? []) if (!changed.has(parent)) queue.push(parent);
    queue.push(...(inverse.get(id) ?? []));
  }
  return null;
}
