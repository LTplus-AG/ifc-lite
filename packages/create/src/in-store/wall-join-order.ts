// SPDX-License-Identifier: MPL-2.0
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveReferencers } from '@ifc-lite/export';
import { AnchorEntityReader } from './resolve-anchor.js';

const TYPE = 'IFCRELCONNECTSPATHELEMENTS';
const orders = new WeakMap<IfcDataStore, { signature: unknown[]; ranks: Map<number, number> }>();
function sourceOrder(store: IfcDataStore): ReadonlyMap<number, number> {
  // @raw-entity-enumeration-ok identity and size checks only; the canonical reader enumerates below.
  const signature = [store.source, store.entityIndex, store.entityIndex.byType, store.entityIndex.byId.size,
    store.deferredEntityIndex, store.deferredEntityIndex?.size, store.entities.typeRevision, store.entities.expressId.length];
  let memo = orders.get(store);
  if (!memo || signature.some((value, i) => value !== memo!.signature[i])) {
    memo = { signature, ranks: new Map(Array.from(new AnchorEntityReader(store, null).ids(TYPE), (id, i): [number, number] => [id, i])) };
    orders.set(store, memo);
  }
  return memo.ranks;
}

/** Index lookup order is not creation order: an edited endpoint can enter the
 * candidate set before an older unmodified join. Keep the canonical order so
 * the first duplicate's name and priorities remain the ones a join carries. */
export function orderedWallJoinCandidates(
  store: IfcDataStore, view: MutablePropertyView | null | undefined,
  walls: ReadonlySet<number> | undefined, reader: AnchorEntityReader,
): Iterable<number> {
  if (!walls) return reader.ids(TYPE);
  if (view && (typeof view.getNewEntityCreationOrder !== 'function'
    || typeof view.getNewEntitiesReferencing !== 'function'
    || typeof view.getAttributeOverrideReferenceCandidates !== 'function')) return reader.ids(TYPE);
  const overlay = view ?? new MutablePropertyView(null, 'wall-join-read');
  const referencing = effectiveReferencers(store, overlay);
  const candidates = [...new Set([...walls].flatMap(id => referencing(id)))];
  const source = sourceOrder(store), ranks = new Map<number, readonly [number, number]>();
  const paths: number[] = [];
  for (const id of candidates) {
    if (reader.entity(id)?.type.toUpperCase() !== TYPE) continue;
    const created = overlay.getNewEntityCreationOrder(id);
    if (created !== null) ranks.set(id, [1, created]);
    else {
      const rank = source.get(id);
      // A source record retyped into this class follows the original source
      // bucket in retype insertion order. Preserve the canonical legacy walk.
      if (rank === undefined) return reader.ids(TYPE);
      ranks.set(id, [0, rank]);
    }
    paths.push(id);
  }
  return paths.sort((a, b) => {
    const x = ranks.get(a)!, y = ranks.get(b)!;
    return x[0] - y[0] || x[1] - y[1];
  });
}
