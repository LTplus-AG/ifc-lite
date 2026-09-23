/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';

export interface ModelEntry {
  id: string;
  name: string;
  ifcDataStore: IfcDataStore;
  idOffset: number;
  maxExpressId: number;
  /** Live overlay for this model, when one exists (#5207) — same map
   *  `evaluatorModelsFromState` threads into search. A missing
   *  key reads the source model. */
  mutationView: MutablePropertyView | undefined;
}

export type ModelRef = { modelId: string; expressId: number };

/** Keep the columnar table's domain, then let the shared iterator add live creations. */
function* sourceRowIds(store: IfcDataStore): IterableIterator<number> {
  const { entities } = store;
  // @raw-entity-enumeration-ok source table domain only; iterateEffectiveEntityIds applies tombstones and creations
  for (let i = 0; i < entities.count; i++) yield entities.expressId[i];
}

export function effectiveRows(entry: ModelEntry) {
  return iterateEffectiveEntityIds(entry.ifcDataStore, entry.mutationView, undefined, sourceRowIds(entry.ifcDataStore));
}

/** Scan entity array to find the actual maximum expressId */
export function computeMaxExpressId(dataStore: IfcDataStore): number {
  const entities = dataStore.entities;
  // @raw-entity-enumeration-ok legacy source-only id watermark, not the lens entity set
  if (!entities || entities.count === 0) return 0;
  let max = 0;
  // @raw-entity-enumeration-ok legacy source-only id watermark, not the lens entity set
  for (let i = 0; i < entities.count; i++) {
    if (entities.expressId[i] > max) max = entities.expressId[i];
  }
  return max;
}

/**
 * Resolve a global ID to (entry, local expressId).
 * O(m) where m = model count (typically 1–5).
 * Reuses a single result object to avoid per-call allocation during
 * hot-loop lens evaluation (100k+ calls).
 */
const _resolved = { entry: null as unknown as ModelEntry, expressId: 0 };

export function resolveGlobalId(
  globalId: number,
  entries: ModelEntry[],
  resolveRef?: (globalId: number) => ModelRef | null,
): typeof _resolved | null {
  if (resolveRef) {
    const ref = resolveRef(globalId);
    if (!ref) return null;
    const entry = entries.find((candidate) => candidate.id === ref.modelId);
    if (!entry) return null;
    _resolved.entry = entry;
    _resolved.expressId = ref.expressId;
    return _resolved;
  }
  // Source-only callers may omit a resolver; live viewer callers provide the
  // modelSlice resolver so overlay-allocated ids remain addressable.
  for (const entry of entries) {
    const localId = globalId - entry.idOffset;
    if (localId >= 0 && localId <= entry.maxExpressId) {
      _resolved.entry = entry;
      _resolved.expressId = localId;
      return _resolved;
    }
  }
  return null;
}
