// SPDX-License-Identifier: MPL-2.0
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
const TYPE = 'IFCRELVOIDSELEMENT';
const sources = new WeakMap<IfcDataStore, { signature: unknown[]; buckets: Map<number | null, number[]>; order: Map<number, number> }>();

/** Include unresolved hosts globally: their old conservative refusal is part
 * of the contract. Source projections are immutable; authored projections are
 * maintained by mutation maps, including nested drafts and escaped arrays. */
export function hostOpeningCandidates(store: IfcDataStore, host: number, view?: MutablePropertyView | null): Iterable<number> {
  const reader = new AnchorEntityReader(store, view);
  if (!view || typeof view.getNewEntityReferenceSlotIds !== 'function') return reader.ids(TYPE);
  // @raw-entity-enumeration-ok source identity/size only; canonical reader supplies records.
  const signature = [store.source, store.entityIndex, store.entityIndex.byType, store.entityIndex.byId.size,
    store.deferredEntityIndex, store.deferredEntityIndex?.size, store.entities.typeRevision, store.entities.expressId.length];
  let source = sources.get(store);
  if (!source || signature.some((v, i) => v !== source!.signature[i])) {
    source = { signature, buckets: new Map(), order: new Map() };
    const base = new AnchorEntityReader(store, null);
    for (const id of base.ids(TYPE)) {
      source.order.set(id, source.order.size);
      const key = refId(base.entity(id)?.attributes[4]);
      const bucket = source.buckets.get(key) ?? [];
      bucket.push(id); source.buckets.set(key, bucket);
    }
    sources.set(store, source);
  }
  const candidates = new Set([...(source.buckets.get(host) ?? []), ...(source.buckets.get(null) ?? []),
    ...view.getNewEntityReferenceSlotIds(TYPE, 4, host), ...view.getNewEntityReferenceSlotIds(TYPE, 4, null),
    ...view.getAttributeOverrideEntityIds([TYPE])]);
  const ranks = new Map<number, number>();
  const matches: number[] = [];
  for (const id of candidates) {
    if (view.isDeleted(id)) continue;
    const row = reader.entity(id);
    if (row && row.type.toUpperCase() !== TYPE) continue;
    const target = refId(row?.attributes[4]);
    if (target !== null && target !== host) continue;
    const created = view.getNewEntityCreationOrder(id);
    const rank = source.order.get(id);
    // Retyped source ordering still follows the canonical reader.
    if (created === null && rank === undefined) return reader.ids(TYPE);
    ranks.set(id, created === null ? rank! : source.order.size + created);
    matches.push(id);
  }
  return matches.sort((a, b) => ranks.get(a)! - ranks.get(b)!);
}
