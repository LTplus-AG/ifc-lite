/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { isPhysicalObjectType } from '@/lib/physical-objects';
import { effectiveSpatialProject } from './effectiveStoreyNodes';

// Spatial rows read names, classes, ownership and containment, not product
// geometry. Storey placement leaves DO matter; effectiveSpatialProject tracks
// those reads, including helpers shared with another product (#9296).
const PLACEMENTS = new Set(['IFCCARTESIANPOINT', 'IFCDIRECTION', 'IFCAXIS2PLACEMENT3D', 'IFCAXIS2PLACEMENT2D', 'IFCLOCALPLACEMENT']);
const snapshots = new WeakMap<IfcDataStore, WeakMap<MutablePropertyView, { revision: number; signature: string }>>();
function signature(store: IfcDataStore, view: MutablePropertyView): string {
  let byView = snapshots.get(store);
  if (!byView) snapshots.set(store, byView = new WeakMap());
  const revision = view.getMutationRevision();
  const cached = byView.get(view);
  if (cached?.revision === revision) return cached.signature;
  const typeOf = (id: number) => view.readNewEntity(id)?.type ?? store.entities.getTypeName(id);
  const attributes = (type: string, values: unknown[]) => isPhysicalObjectType(type)
    ? values.map((value, index) => index === 5 || index === 6 ? null : value) : values;
  const created = view.readNewEntities().filter(row => !PLACEMENTS.has(row.type.toUpperCase()))
    .map(row => [row.expressId, row.type, attributes(row.type, row.attributes)]);
  const overrides = view.getAttributeOverrideEntityIds().flatMap(id => {
    const type = typeOf(id);
    if (PLACEMENTS.has(type.toUpperCase())) return [];
    const physical = isPhysicalObjectType(type);
    return [[id,
      view.getAttributeMutationsForEntity(id).filter(row => !physical || (row.name !== 'ObjectPlacement' && row.name !== 'Representation')),
      [...(view.getPositionalMutationsForEntity(id) ?? [])].filter(([index]) => !physical || (index !== 5 && index !== 6)),
    ]];
  }).filter(row => (row[1] as unknown[]).length || (row[2] as unknown[]).length);
  const next = JSON.stringify([created, overrides, [...view.getTypeMutations()], [...view.getTombstones()]]);
  byView.set(view, { revision, signature: next });
  return next;
}

/** A panel subscription, not a memo after the panel already rendered. Other
 * groupings read different IFC data and retain conservative invalidation. */
export function createSpatialMutationSelector(): (state: ViewerState) => number {
  let previous: unknown[] = [];
  let token = 0;
  return state => {
    const next: unknown[] = [state.hierarchyMode];
    if (state.hierarchyMode !== 'spatial') next.push(state.mutationVersion);
    else for (const [id, view] of state.mutationViews) {
      const store = state.models.get(id)?.ifcDataStore ?? state.ifcDataStore;
      next.push(id, store, view);
      if (store) next.push(effectiveSpatialProject(store, view), signature(store, view));
      else next.push(view.getMutationRevision());
    }
    if (next.length !== previous.length || next.some((item, index) => item !== previous[index])) {
      previous = next;
      token++;
    }
    return token;
  };
}
