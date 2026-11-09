/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { propertyKey, quantityKey, type Mutation, type EffectiveChange, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';

/** #7251: virtual and edited source sets have effective values that raw
 * relationship sharing cannot carry. Use the same overlay API after memberships,
 * preserving the native builder's same-name metadata priority. Current edits
 * are authoritative; append-only history must never resurrect an undone set. */
const writesByEditor = new WeakMap<StoreEditor, number>();
const MAX_EFFECTIVE_METADATA_WRITES = 10000;

/** Atomic split/copy batches share one draft editor; the budget therefore covers
 * the complete operation, including assembly parts and repeated source copies. */
export function cloneEffectiveMetadata(view: MutablePropertyView, editor: StoreEditor, source: number, targets: number[]): void {
  if (!view.hasChanges(source)) return;
  // Older structural implementations may ignore the new optional entity ID.
  const changes = view.getEffectiveChanges(source).filter(row => row.entityId === source);
  const propertyNames = new Set(changes.filter(row => row.kind === 'pset-added' || row.kind === 'property').map(row => row.setName));
  const quantityNames = new Set(changes.filter(row => row.kind === 'qset-added' || row.kind === 'quantity').map(row => row.setName));
  const deletedProperties = new Set<string>();
  for (const change of changes) if (change.kind === 'property' && change.deleted && change.setName !== undefined && change.name !== undefined) {
    deletedProperties.add(propertyKey(source, change.setName, change.name));
  }
  const properties = namedMembers(view.getForEntity(source).filter(set => propertyNames.has(set.name)), set => set.properties);
  const quantities = namedMembers(view.getQuantitiesForEntity(source).filter(set => quantityNames.has(set.name)), set => set.quantities);
  const writes = targets.length * (properties.reduce((sum, set) => sum + 1 + set.members.length
    + set.members.filter(property => property.dataType !== undefined).length, 0)
    + quantities.reduce((sum, set) => sum + 1 + set.members.length, 0)
    + changes.filter(change => change.deleted).length);
  const total = (writesByEditor.get(editor) ?? 0) + writes;
  if (total > MAX_EFFECTIVE_METADATA_WRITES) throw new Error('Effective metadata cloning exceeds 10000 writes in one operation; no metadata is silently omitted');
  writesByEditor.set(editor, total);
  for (const target of targets) {
    const existingProperties = new Set(view.getForEntity(target).map(set => set.name));
    const existingQuantities = new Set(view.getQuantitiesForEntity(target).map(set => set.name));
    for (const set of properties) {
      if (existingProperties.has(set.name)) continue;
      const mutation = view.createPropertySet(target, set.name, set.members.map(property => ({ name: property.name, value: property.value, type: property.type, unit: property.unit })));
      retainDeletedMembers(view, mutation, changes);
      // The constructor preserves empty/null members; typed values also retain
      // their native declared data type through the normal mutation writer.
      for (const property of set.members) if (property.dataType !== undefined && !deletedProperties.has(propertyKey(source, set.name, property.name))) {
        view.setProperty(target, set.name, property.name, property.value, property.type, property.unit, false, property.dataType);
      }
      existingProperties.add(set.name);
    }
    for (const change of changes) {
      if (change.kind === 'quantity' && change.deleted && change.setName !== undefined
        && !quantities.some(set => set.name === change.setName)) view.deleteQuantitySet(target, change.setName);
    }
    for (const set of quantities) {
      if (existingQuantities.has(set.name)) continue;
      const mutation = view.createQuantitySet(target, set.name, set.members.map(quantity => ({ name: quantity.name, value: quantity.value, quantityType: quantity.type, unit: quantity.unit })));
      retainDeletedMembers(view, mutation, changes);
      existingQuantities.add(set.name);
    }
  }
}

/** Named mutations claim the first owning instance of each member. Keep that
 * priority in the overlay while export retains the distinct saved definitions. */
function namedMembers<S extends { name: string }, M extends { name: string }>(
  sets: readonly S[], members: (set: S) => readonly M[],
): { name: string; members: M[] }[] {
  const groups = new Map<string, { name: string; members: M[]; names: Set<string> }>();
  for (const set of sets) {
    const group = groups.get(set.name) ?? { name: set.name, members: [], names: new Set<string>() };
    for (const member of members(set)) if (!group.names.has(member.name)) {
      group.names.add(member.name); group.members.push(member);
    }
    groups.set(set.name, group);
  }
  return [...groups.values()];
}

/** A whole-set snapshot journals deleted members too, so Undo/Redo and export
 * cannot resurrect a saved member absent from the effective source (#9296). */
function retainDeletedMembers(view: MutablePropertyView, mutation: Mutation, changes: readonly EffectiveChange[]): void {
  const after = mutation.setOverlay?.after;
  if (!after) return;
  const deleted = changes.filter(change => change.deleted && change.setName === after.setName && change.name !== undefined
    && change.kind === (after.kind === 'property' ? 'property' : 'quantity'));
  if (!deleted.length) return;
  if (after.kind === 'property') for (const change of deleted) {
    after.entries = after.entries.filter(([key]) => key !== propertyKey(after.entityId, after.setName, change.name!));
    after.entries.push([propertyKey(after.entityId, after.setName, change.name!), { operation: 'DELETE' }]);
  }
  else for (const change of deleted) {
    after.entries = after.entries.filter(([key]) => key !== quantityKey(after.entityId, after.setName, change.name!));
    after.entries.push([quantityKey(after.entityId, after.setName, change.name!), { operation: 'DELETE' }]);
  }
  view.restoreSetOverlay(after);
}
