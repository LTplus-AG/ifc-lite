// SPDX-License-Identifier: MPL-2.0
import type { EntityChangeTracker, MutablePropertyView } from '@ifc-lite/mutations';
import type { AnchorEntityReader } from '../resolve-anchor.js';
import type { StoreyInventory, StoreyRelationship } from './storey-model.js';
import type { IfcDataStore } from '@ifc-lite/parser';

export interface SpatialGraph {
  readonly relationships: readonly StoreyRelationship[];
  readonly outgoing: ReadonlyMap<number, readonly StoreyRelationship[]>;
  readonly incoming: ReadonlyMap<number, readonly StoreyRelationship[]>;
}
interface Entry {
  readonly store: IfcDataStore;
  readonly changes?: EntityChangeTracker;
  readonly deleted: Set<number>;
  graph?: SpatialGraph;
  signature?: string;
  sourceSignature?: readonly unknown[];
  revision: number;
  /** A separate reader is used by each request; cached data contains IDs only. */
  planner?: object;
  placementParents?: ReadonlyMap<number, number | null>;
  dirty: Set<number>;
}
const entries = new WeakMap<MutablePropertyView, Entry>();

/** One graph per effective topology, shared by unchanged detached drafts.
 * Restorations and structural edits invalidate it; geometry leaves and ordinary
 * property edits do not require re-walking every containment relationship. */
export function storeyInventoryCache(
  store: IfcDataStore, view: MutablePropertyView, reader: AnchorEntityReader, readParent: (view: MutablePropertyView) => void,
): Entry {
  // Read-tracking proxies intentionally omit subscription capabilities: every
  // point read must reach their dependency recorder, without a retained cursor.
  if (typeof view.trackEntityChanges !== 'function') return {
    store, deleted: new Set(view.getTombstones()), revision: view.getMutationRevision(), dirty: new Set(),
  };
  let entry = entries.get(view);
  if (entry?.store !== store) { entry?.changes?.dispose(); entry = undefined; }
  if (!entry) {
    const changes = view.trackEntityChanges();
    entry = { store, changes, deleted: new Set(view.getTombstones()), revision: view.getMutationRevision(), dirty: new Set() };
    entries.set(view, entry);
    const origin = changes.origin;
    if (origin && view.getMutationRevision() === origin.revision && origin.view.getMutationRevision() === origin.revision) {
      readParent(origin.view);
      const parent = entries.get(origin.view);
      if (parent?.store === store) Object.assign(entry, { graph: parent.graph, planner: parent.dirty.size ? undefined : parent.planner,
        signature: parent.signature, placementParents: parent.placementParents });
    }
  }
  // Parsed/deferred tables may finish streaming without an overlay write.
  // Invalidate on the same source identities/revisions used by indexed reads.
  // @raw-entity-enumeration-ok source identity and size checks only; readStoreyInventory enumerates through AnchorEntityReader's effective IDs, and changes.take() invalidates overlay edits below.
  const sourceSignature = [store.source, store.entityIndex, store.entityIndex.byType, store.entityIndex.byId.size,
    store.deferredEntityIndex, store.deferredEntityIndex?.size, store.entities?.typeRevision, store.entities?.expressId?.length];
  if (entry.sourceSignature && sourceSignature.some((value, i) => value !== entry.sourceSignature![i])) {
    entry.graph = undefined; entry.planner = undefined; entry.dirty.clear();
  }
  entry.sourceSignature = sourceSignature;
  const dirty = entry.changes?.take() ?? null;
  if (dirty === null) {
    entry.graph = undefined; entry.planner = undefined; entry.dirty.clear(); entry.deleted.clear();
    for (const id of view.getTombstones()) entry.deleted.add(id);
  }
  else for (const id of dirty) {
    entry.dirty.add(id);
    const deleted = view.isDeleted(id);
    if (deleted !== entry.deleted.has(id)) { entry.graph = undefined; entry.planner = undefined; }
    if (deleted) entry.deleted.add(id); else entry.deleted.delete(id);
    // @raw-entity-enumeration-ok point classification of an invalidated ID; this cache must not borrow every new geometry payload during ordinary creation.
    const type = deleted ? undefined : (view.getEntityTypeMutation(id)?.newType ?? view.getNewEntityType(id) ?? store.entityIndex.byId.get(id)?.type)?.toUpperCase();
    // A deleted end changes the live relationship graph. Placement topology,
    // grid bindings and source property records may change many classifications.
    if (!type || type.startsWith('IFCREL') || type.startsWith('IFCPROPERTY') || type.startsWith('IFCGRID')
      || type === 'IFCVIRTUALGRIDINTERSECTION') {
      entry.graph = undefined; entry.planner = undefined;
    }
    if (entry.planner && type === 'IFCLOCALPLACEMENT') {
      const raw = reader.entity(id)?.attributes[0];
      const parent = typeof raw === 'number' ? raw : typeof raw === 'string' && /^#[1-9][0-9]*$/.test(raw) ? Number(raw.slice(1)) : null;
      if (!entry.placementParents?.has(id) || entry.placementParents.get(id) !== parent) entry.planner = undefined;
    }
  }
  // A changed detached draft must never mutate the parent's shared inventory.
  if (dirty?.size && entry.changes?.origin) entry.planner = undefined;
  if (!entry.planner) entry.dirty.clear();
  entry.revision = view.getMutationRevision();
  return entry;
}

/** Only topology/identity affects classification; changing a floor elevation
 * reads current geometry through the request's reader without dropping IDs. */
export function validateStoreyInventoryCache(entry: Entry, inventory: StoreyInventory): void {
  const signature = JSON.stringify(inventory.storeys.map(s => [s.expressId, s.GlobalId, s.Name, s.parentId, s.placementId]));
  if (entry.signature !== signature) entry.planner = undefined;
  entry.signature = signature;
}

export function plannerCache(inventory: StoreyInventory): { value: object | undefined; dirty: ReadonlySet<number>; save(value: object, parents: ReadonlyMap<number, number | null>): void } {
  const entry = entries.get(inventory.view);
  if (!entry || entry.store !== inventory.store) return { value: undefined, dirty: new Set(), save() {} };
  return {
    value: entry.planner, dirty: entry.dirty,
    save(value, parents) { entry.planner = value; entry.placementParents = parents; entry.dirty.clear(); },
  };
}
