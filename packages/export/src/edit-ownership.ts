/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { collectRefsInByteRange } from './reference-collector.js';
import { effectiveCreatedRecord, effectiveSourceRecord } from './effective-source-record.js';

/** In-place writes may only affect the requested products. A shared geometry
 * or placement leaf is refused before writing rather than moving/resizing a
 * second occurrence. Reverse walks stop at products and are iterative. */
export function editOwnershipRefusal(
  store: IfcDataStore, view: MutablePropertyView, writtenIds: readonly number[], allowedProducts: ReadonlySet<number>,
): string | null {
  if (writtenIds.length === 0) return null;
  const inverse = new Map<number, number[]>(), productIds = new Set<number>();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  for (const { expressId, type } of iterateEffectiveEntityIds(store, view)) {
    if (getInheritanceChainAcrossSchemas(type).includes('IfcProduct')) productIds.add(expressId);
    const created = effectiveCreatedRecord(view, expressId, store.schemaVersion);
    // @raw-entity-enumeration-ok effective enumeration above; raw bytes are only the unchanged reference baseline
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
    if (productIds.has(id)) {
      if (!allowedProducts.has(id)) return `The edit shares placement or geometry with #${id}; shared occurrences cannot be edited in place`;
      continue;
    }
    queue.push(...(inverse.get(id) ?? []));
  }
  return null;
}
