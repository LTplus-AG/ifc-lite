/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, RelationshipType } from '@ifc-lite/data';
import { storeHasSourceEntity, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import type { AggregationRelationships } from './aggregation.js';

// Source tables are immutable across overlay edits. Reuse their row domain
// across per-row traversals; membership must not depend on a display class.
const tableDomains = new WeakMap<Uint32Array, { count: number; ids: ReadonlySet<number> }>();
const emptySourceEntities = new Map<number, never>();

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
  // Table-backed/partial stores may omit the STEP index while retaining a
  // deferred source domain. Normalize only the missing half of the union.
  // @raw-entity-enumeration-ok immutable source membership only; the predicate below separately checks live tombstones and newly created entities
  const source = {
    entityIndex: { byId: store?.entityIndex?.byId ?? emptySourceEntities },
    deferredEntityIndex: store?.deferredEntityIndex,
  };
  return (id: number): boolean => {
    if (!store || !Number.isSafeInteger(id) || id <= 0 || view?.isDeleted(id)) return false;
    if (view?.getNewEntity(id)) return true;
    if (storeHasSourceEntity(source, id)) return true;
    return tableOwns(store, id);
  };
}

/** The session's own `IfcRelAggregates` edges, and the parsed rows they replace. */
interface OverlayAggregates {
  store: IfcDataStore;
  revision: number;
  forward: Map<number, number[]>;
  inverse: Map<number, number[]>;
  supersededSourceIds: ReadonlySet<number>;
}

const overlayAggregatesByView = new WeakMap<MutablePropertyView, OverlayAggregates>();

function pushEdge(edges: Map<number, number[]>, from: number, to: number): void {
  const targets = edges.get(from);
  if (targets) targets.push(to);
  else edges.set(from, [to]);
}

/** One resolve per overlay revision: the trees ask once per row, and resolving walks the whole overlay. */
function overlayAggregatesOf(store: IfcDataStore, view: MutablePropertyView): OverlayAggregates {
  const revision = view.getMutationRevision();
  const known = overlayAggregatesByView.get(view);
  if (known?.store === store && known.revision === revision) return known;
  const overlay = effectiveMutationRelationships(store, view);
  const forward = new Map<number, number[]>();
  const inverse = new Map<number, number[]>();
  for (const relation of overlay.relationships) {
    if (relation.relationshipType.toUpperCase() !== 'IFCRELAGGREGATES') continue;
    for (const parent of relation.relating) {
      for (const child of relation.related) {
        pushEdge(forward, parent, child);
        pushEdge(inverse, child, parent);
      }
    }
  }
  const resolved = { store, revision, forward, inverse, supersededSourceIds: overlay.supersededSourceIds };
  overlayAggregatesByView.set(view, resolved);
  return resolved;
}

/**
 * The model's `IfcRelAggregates` graph as edited: live unmeshed descendants are
 * retained, missing and deleted endpoints excluded, and an aggregate written
 * this session counts. The parsed graph never receives authored edges, so a
 * curtain wall, whose meshes all sit on its overlay-aggregated parts, otherwise
 * reads as a shapeless element (#9026).
 */
export function ownedAggregationRelationships(
  store: IfcDataStore | null | undefined,
  view?: MutablePropertyView | null,
): AggregationRelationships | undefined {
  if (!store?.relationships) return undefined;
  const relationships = store.relationships;
  const owns = entityOwnership(store, view);

  return {
    getRelated(id, type, direction) {
      if (!owns(id)) return [];
      if (type !== RelationshipType.Aggregates || !view?.hasPendingChanges()) {
        return relationships.getRelated(id, type, direction).filter(owns);
      }
      const overlay = overlayAggregatesOf(store, view);
      const superseded = (relationshipId: number) =>
        view.isDeleted(relationshipId) || overlay.supersededSourceIds.has(relationshipId);
      const source = (direction === 'forward' ? relationships.forward : relationships.inverse)
        .getEdges(id, type)
        .filter((edge) => edgeSurvives(edge, superseded))
        .map((edge) => edge.target);
      const authored = (direction === 'forward' ? overlay.forward : overlay.inverse).get(id) ?? [];
      return [...new Set([...source, ...authored])].filter(owns);
    },
  };
}
