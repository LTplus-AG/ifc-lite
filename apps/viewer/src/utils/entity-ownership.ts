/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { storeHasSourceEntity, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { AggregationRelationships } from './aggregation.js';

// Source tables are immutable across overlay edits. Reuse their row domain
// across per-row traversals; membership must not depend on a display class.
const tableDomains = new WeakMap<Uint32Array, { count: number; ids: ReadonlySet<number> }>();

function tableOwns(store: IfcDataStore, id: number): boolean {
  const table = store.entities;
  if (!table?.expressId) return false;
  let domain = tableDomains.get(table.expressId);
  if (!domain || domain.count !== table.count) {
    const ids = new Set<number>();
    // @raw-entity-enumeration-ok exact source-table membership for IFCX/server stores without a STEP byte index; overlays are handled separately
    for (let row = 0; row < table.count; row++) ids.add(table.expressId[row]);
    domain = { count: table.count, ids };
    tableDomains.set(table.expressId, domain);
  }
  return domain.ids.has(id);
}

/** File-authored references do not establish entity ownership (#7890). */
export function entityOwnership(
  store: IfcDataStore | null | undefined,
  view?: Pick<MutablePropertyView, 'getNewEntity' | 'isDeleted'> | null,
): (id: number) => boolean {
  return (id: number): boolean => {
    if (!store || !Number.isSafeInteger(id) || id <= 0 || view?.isDeleted(id)) return false;
    if (view?.getNewEntity(id)) return true;
    // @raw-entity-enumeration-ok source-index availability check before the shared membership primitive; table-backed stores may omit the byte index
    if (store.entityIndex?.byId && storeHasSourceEntity(store, id)) return true;
    return tableOwns(store, id);
  };
}

/** Retain live unmeshed descendants while excluding missing/deleted endpoints. */
export function ownedAggregationRelationships(
  store: IfcDataStore | null | undefined,
  view?: Pick<MutablePropertyView, 'getNewEntity' | 'isDeleted'> | null,
): AggregationRelationships | undefined {
  if (!store?.relationships) return undefined;
  const relationships = store.relationships;
  const owns = entityOwnership(store, view);

  return {
    getRelated(id, type, direction) {
      if (!owns(id)) return [];
      return relationships.getRelated(id, type, direction).filter(owns);
    },
  };
}
