/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Complete entity iteration for STEP exporters.
 *
 * The parser can defer high-cardinality property *atoms*
 * (IfcPropertySingleValue, IfcQuantity*, IfcPropertyEnumeratedValue, …) out of
 * `entityIndex.byId` and into a secondary `deferredEntityIndex` to cap memory
 * on huge files (the `deferPropertyAtomIndex` parse option). Those atoms are
 * still referenced by the IfcPropertySet / IfcElementQuantity *containers* that
 * remain in `byId`.
 *
 * Any exporter that copies source entities by walking `entityIndex.byId` alone
 * therefore silently drops every deferred atom while keeping the references to
 * them — producing STEP output with dangling `#`-references that strict viewers
 * (e.g. BIM Vision) reject, and that makes lenient viewers fall geometry back to
 * the origin when a placement/type/material chain resolves to a dropped entity.
 *
 * `getCompleteEntityIndex` exposes a single Map-like view over BOTH indexes so
 * exporters preserve referential integrity regardless of how the source was
 * parsed. When nothing was deferred it returns the primary index unchanged, so
 * the common path keeps its existing behaviour and cost.
 */

import type { IfcDataStore } from '@ifc-lite/parser';

/** The subset of an entity reference the exporters read. */
export interface ExportEntityRef {
  type: string;
  byteOffset: number;
  byteLength: number;
}

/**
 * Map-like view over a set of entities. Matches the slice of the
 * `Map` / `CompactEntityIndex` surface the exporters depend on.
 */
export interface CompleteEntityIndex {
  get(id: number): ExportEntityRef | undefined;
  has(id: number): boolean;
  readonly size: number;
  [Symbol.iterator](): IterableIterator<[number, ExportEntityRef]>;
}

/**
 * Returns a view over the COMPLETE set of source entities — the primary
 * `entityIndex.byId` plus any `deferredEntityIndex`. The two indexes are
 * disjoint by construction (deferred atoms are removed from `byId`), so the
 * merged view never yields a duplicate id.
 *
 * Fast path: when there is no deferred index the primary index is returned
 * directly (no wrapper allocation, identical iteration order and cost).
 */
export function getCompleteEntityIndex(dataStore: IfcDataStore): CompleteEntityIndex {
  const byId = dataStore.entityIndex.byId as unknown as CompleteEntityIndex;
  const deferred = dataStore.deferredEntityIndex as unknown as CompleteEntityIndex | undefined;
  if (!deferred || deferred.size === 0) {
    return byId;
  }

  return {
    get: (id: number) => byId.get(id) ?? deferred.get(id),
    has: (id: number) => byId.has(id) || deferred.has(id),
    get size() {
      return byId.size + deferred.size;
    },
    *[Symbol.iterator](): IterableIterator<[number, ExportEntityRef]> {
      yield* byId;
      yield* deferred;
    },
  };
}

/** Largest EXPRESS id across a (complete) entity index. */
export function getMaxExpressId(index: CompleteEntityIndex): number {
  let max = 0;
  for (const [id] of index) {
    if (id > max) max = id;
  }
  return max;
}
