/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** #7251: virtual sets have effective values but no IFC relationship until
 * export. Carry those through the same overlay API, after graph memberships,
 * preserving the native builder's same-name metadata priority. Current edits
 * are authoritative; append-only history must never resurrect an undone set. */
export function cloneVirtualMetadata(store: IfcDataStore, view: MutablePropertyView, source: number, targets: number[]): void {
  if (!view.hasChanges(source)) return;
  const changes = view.getEffectiveChanges().filter(row => row.entityId === source);
  const propertyNames = new Set(changes.filter(row => row.kind === 'pset-added').map(row => row.setName));
  const quantityNames = new Set(changes.filter(row => row.kind === 'qset-added').map(row => row.setName));
  const properties = view.getForEntity(source, id => store.properties.getForEntity(id)).filter(set => propertyNames.has(set.name));
  const quantities = view.getQuantitiesForEntity(source, id => store.quantities.getForEntity(id)).filter(set => quantityNames.has(set.name));
  for (const target of targets) {
    const existingProperties = new Set(view.getForEntity(target, id => store.properties.getForEntity(id)).map(set => set.name));
    const existingQuantities = new Set(view.getQuantitiesForEntity(target, id => store.quantities.getForEntity(id)).map(set => set.name));
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
