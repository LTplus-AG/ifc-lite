// SPDX-License-Identifier: MPL-2.0
import { iterateEffectiveEntities } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';
import { sourceInventorySignature } from './source-inventory-signature.js';
const TYPE = 'IFCRELVOIDSELEMENT';
/** Up to this many effective voids, the canonical class walk is cheaper than
 * the source projection, reference-slot queries and override classification,
 * and it is already the reference order. Larger classes use the projection. */
export const CANONICAL_VOID_WALK_LIMIT = 32;
const sources = new WeakMap<IfcDataStore, { signature: unknown[]; buckets: Map<number | null, number[]>; order: Map<number, number> }>();

/** Source overrides are conservatively untyped in the mutation index. Resolve
 * only their classes through the canonical metadata iterator before asking a
 * payload reader to decode them. Missing metadata stays a candidate. */
function openingOverrideIds(store: IfcDataStore, view: MutablePropertyView): number[] {
  const ids = view.getAttributeOverrideEntityIds([TYPE]);
  const sourceIds = ids.filter(id => !view.hasNewEntity(id));
  if (!sourceIds.length) return ids;
  const kinds = new Map(Array.from(iterateEffectiveEntities(store, {
    isDeleted: id => view.isDeleted(id),
    getTypeMutations: () => view.getTypeMutations(),
    hasNewEntity: id => view.hasNewEntity(id),
    // This adapter classifies only the sparse source domain, never creations.
    getNewEntities: () => [],
    readNewEntityKinds: () => [],
  }, undefined, sourceIds), row => [row.expressId, row.type] as const));
  return ids.filter(id => !kinds.has(id) || kinds.get(id) === TYPE);
}


/** The whole effective void class in canonical order, or null once it exceeds
 * the limit. Creations are counted lazily first, so the canonical walk never
 * copies a large authored class; a large source bucket stops at the limit.
 * Kept separate from the projection path: the first opening of a session
 * compiles and runs only this walk (#10555). It is NOT filtered by host:
 * readHostOpeningExtents checks each RelatingBuildingElement itself. */
export function smallVoidClass(reader: AnchorEntityReader, view?: MutablePropertyView | null): number[] | null {
  if (!view || typeof view.readNewEntityKinds !== 'function') return null;
  let authored = 0;
  for (const _row of view.readNewEntityKinds(TYPE)) if (++authored > CANONICAL_VOID_WALK_LIMIT) return null;
  const ids: number[] = [];
  for (const id of reader.ids(TYPE)) if (ids.push(id) > CANONICAL_VOID_WALK_LIMIT) return null;
  return ids;
}

/** Include unresolved hosts globally: their old conservative refusal is part
 * of the contract. Source projections are immutable; authored projections are
 * maintained by mutation maps, including nested drafts and escaped arrays. */
export function hostOpeningCandidates(store: IfcDataStore, host: number, view?: MutablePropertyView | null): Iterable<number> {
  const reader = new AnchorEntityReader(store, view);
  if (!view || typeof view.getNewEntityReferenceSlotIds !== 'function') return reader.ids(TYPE);
  // Same contract as the projection path below: this host's voids plus
  // unresolved targets, in canonical order. Unreadable rows stay candidates.
  const small = smallVoidClass(reader, view);
  if (small) return small.filter(id => { const target = refId(reader.entity(id)?.attributes[4]); return target === null || target === host; });
  const signature = sourceInventorySignature(store);
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
    ...openingOverrideIds(store, view)]);
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
