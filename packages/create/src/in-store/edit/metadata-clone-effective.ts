/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

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
  const changes = view.getEffectiveChanges().filter(row => row.entityId === source);
  const propertyNames = new Set(changes.filter(row => row.kind === 'pset-added' || row.kind === 'property').map(row => row.setName));
  const quantityNames = new Set(changes.filter(row => row.kind === 'qset-added' || row.kind === 'quantity').map(row => row.setName));
  const properties = view.getForEntity(source).filter(set => propertyNames.has(set.name));
  const quantities = view.getQuantitiesForEntity(source).filter(set => quantityNames.has(set.name));
  const writes = targets.length * (properties.reduce((sum, set) => sum + 1 + set.properties.length
    + set.properties.filter(property => property.dataType !== undefined).length, 0)
    + quantities.reduce((sum, set) => sum + 1 + set.quantities.length, 0));
  const total = (writesByEditor.get(editor) ?? 0) + writes;
  if (total > MAX_EFFECTIVE_METADATA_WRITES) throw new Error('Effective metadata cloning exceeds 10000 writes in one operation; no metadata is silently omitted');
  writesByEditor.set(editor, total);
  for (const target of targets) {
    const existingProperties = new Set(view.getForEntity(target).map(set => set.name));
    const existingQuantities = new Set(view.getQuantitiesForEntity(target).map(set => set.name));
    for (const set of properties) {
      if (existingProperties.has(set.name)) continue;
      view.createPropertySet(target, set.name, set.properties.map(property => ({ name: property.name, value: property.value, type: property.type, unit: property.unit })));
      // The constructor preserves empty/null members; typed values also retain
      // their native declared data type through the normal mutation writer.
      for (const property of set.properties) if (property.dataType !== undefined) {
        view.setProperty(target, set.name, property.name, property.value, property.type, property.unit, false, property.dataType);
      }
      existingProperties.add(set.name);
    }
    for (const set of quantities) {
      if (existingQuantities.has(set.name)) continue;
      view.createQuantitySet(target, set.name, set.quantities.map(quantity => ({ name: quantity.name, value: quantity.value, quantityType: quantity.type, unit: quantity.unit })));
      existingQuantities.add(set.name);
    }
  }
}
