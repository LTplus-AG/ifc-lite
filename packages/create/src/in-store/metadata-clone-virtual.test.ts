/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { splitElementInStore } from './element-split.js';
import { copyBatchInStore } from './copy-batch.js';

for (const operation of ['split', 'copy'] as const) it(`#7251 shared native ${operation} carries current virtual Pset/Qto values, typed members and Undo`, async () => {
  const source = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const store = await parse(source), view = new MutablePropertyView(null, 'native'), editor = new StoreEditor(store, view);
  const id = addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  view.setProperty(id, 'Pset_LiveAudit', 'Code', 'original', PropertyValueType.Label, undefined, true, 'IFCIDENTIFIER');
  view.setProperty(id, 'Pset_LiveAudit', 'Code', 'effective', PropertyValueType.Label, undefined, true, 'IFCIDENTIFIER');
  view.setProperty(id, 'Pset_LiveAudit', 'FalseFlag', false, PropertyValueType.Boolean);
  view.setProperty(id, 'Pset_LiveAudit', 'Zero', 0, PropertyValueType.Integer);
  view.setProperty(id, 'Pset_RemovedAudit', 'Gone', 'must not return');
  view.deletePropertySet(id, 'Pset_RemovedAudit');
  view.createQuantitySet(id, 'Qto_LiveAudit', [{ name: 'DeclaredCount', value: 17, quantityType: QuantityType.Count }]);
  const exported = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const before = await parse(exported());
  const originalProperties = extractPropertiesOnDemand(before, id).find(set => set.name === 'Pset_LiveAudit');
  const originalQuantities = extractQuantitiesOnDemand(before, id).find(set => set.name === 'Qto_LiveAudit');
  expect(originalProperties?.properties.find(property => property.name === 'Code')).toMatchObject({ value: 'effective', dataType: 'IFCLABEL' });
  expect(originalQuantities?.quantities.find(quantity => quantity.name === 'DeclaredCount')?.value).toBe(17);
  const historyBefore = view.getMutationCount();
  const added = recordCompoundMutation(view, draft => {
    const writer = new StoreEditor(store, draft);
    if (operation === 'split') return splitElementInStore(store, writer, id, { kind: 'wall', distance: 2 }).addedId;
    return copyBatchInStore(store, writer, [id], [{ offset: [0, 3, 0] }])[0].copyId;
  });
  const after = await parse(exported());
  expect(after.entities.getTypeName(added)).toBe('IfcWall');
  for (const target of [id, added]) {
    const properties = extractPropertiesOnDemand(after, target);
    expect(properties.find(set => set.name === 'Pset_LiveAudit')?.properties).toEqual(originalProperties?.properties);
    expect(properties.some(set => set.name === 'Pset_RemovedAudit')).toBe(false);
    expect(extractQuantitiesOnDemand(after, target).find(set => set.name === 'Qto_LiveAudit')?.quantities).toEqual(originalQuantities?.quantities);
  }
  undoRecordedMutationOperations(view, 1, () => { throw new Error('One native compound must own all clone effects'); });
  expect(view.getMutationCount()).toBe(historyBefore);
  const undone = await parse(exported());
  expect(undone.entities.getTypeName(added)).toBe('Unknown');
  expect(extractPropertiesOnDemand(undone, id).find(set => set.name === 'Pset_LiveAudit')?.properties).toEqual(originalProperties?.properties);
  expect(extractQuantitiesOnDemand(undone, id).find(set => set.name === 'Qto_LiveAudit')?.quantities).toEqual(originalQuantities?.quantities);
});

for (const operation of ['split', 'copy'] as const) for (const quantity of [false, true]) it(`#7251 shared native ${operation} does not resurrect a deleted saved-source ${quantity ? 'quantity' : 'property'} set`, async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let store = await parse(bytes), view = new MutablePropertyView(null, 'native'), editor = new StoreEditor(store, view);
  const id = addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  const setName = quantity ? 'Qto_DeletedSource' : 'Pset_DeletedSource';
  if (quantity) editor.addQuantitySet(id, setName, [{ name: 'KnownBeforeDeletion', value: 17, quantityType: 'COUNT' }]);
  else editor.addPropertySet(id, setName, [{ name: 'KnownBeforeDeletion', value: 'native source membership', type: 'LABEL' }]);
  const save = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  store = await parse(save()); view = new MutablePropertyView(null, 'native'); editor = new StoreEditor(store, view);
  view.setOnDemandExtractor(target => extractPropertiesOnDemand(store, target));
  view.setQuantityExtractor(target => extractQuantitiesOnDemand(store, target));
  const setsFor = (parsed: typeof store, target: number) => quantity ? extractQuantitiesOnDemand(parsed, target) : extractPropertiesOnDemand(parsed, target);
  expect(setsFor(store, id).some(set => set.name === setName)).toBe(true);
  if (quantity) view.deleteQuantitySet(id, setName); else view.deletePropertySet(id, setName);
  const before = await parse(save());
  expect(setsFor(before, id).some(set => set.name === setName)).toBe(false);
  expect(view.getEffectiveChanges()).toContainEqual(expect.objectContaining({ entityId: id, kind: quantity ? 'qset-deleted' : 'pset-deleted', setName }));
  const added = operation === 'split' ? splitElementInStore(store, editor, id, { kind: 'wall', distance: 2 }).addedId
    : copyBatchInStore(store, editor, [id], [{ offset: [0, 3, 0] }])[0].copyId;
  const after = await parse(save());
  for (const target of [id, added]) expect(setsFor(after, target).some(set => set.name === setName)).toBe(false);
});

for (const operation of ['split', 'copy'] as const) for (const quantity of [false, true]) it(`#7251 shared native ${operation} carries a current edit to an existing source ${quantity ? 'quantity' : 'property'} set`, async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let store = await parse(bytes), view = new MutablePropertyView(null, 'native'), editor = new StoreEditor(store, view);
  const id = addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  const name = quantity ? 'Qto_SourceAudit' : 'Pset_SourceAudit';
  if (quantity) editor.addQuantitySet(id, name, [{ name: 'KnownBeforeEdit', value: 17, quantityType: 'COUNT' }, { name: 'UnchangedCount', value: 7, quantityType: 'COUNT' }]);
  else editor.addPropertySet(id, name, [{ name: 'KnownBeforeEdit', value: 'saved source', type: 'LABEL' }, { name: 'UnchangedFlag', value: false, type: 'BOOLEAN' }]);
  const save = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  store = await parse(save()); view = new MutablePropertyView(null, 'native'); editor = new StoreEditor(store, view);
  view.setOnDemandExtractor(target => extractPropertiesOnDemand(store, target));
  view.setQuantityExtractor(target => extractQuantitiesOnDemand(store, target));
  const valueFor = (parsed: typeof store, target: number) => quantity
    ? extractQuantitiesOnDemand(parsed, target).find(set => set.name === name)?.quantities[0].value
    : extractPropertiesOnDemand(parsed, target).find(set => set.name === name)?.properties[0].value;
  expect(valueFor(store, id)).toBe(quantity ? 17 : 'saved source');
  if (quantity) view.setQuantity(id, name, 'KnownBeforeEdit', 23, QuantityType.Count);
  else view.setProperty(id, name, 'KnownBeforeEdit', 'effective edit', PropertyValueType.Label);
  expect(valueFor(await parse(save()), id)).toBe(quantity ? 23 : 'effective edit');
  const added = operation === 'split' ? splitElementInStore(store, editor, id, { kind: 'wall', distance: 2 }).addedId
    : copyBatchInStore(store, editor, [id], [{ offset: [0, 3, 0] }])[0].copyId;
  const after = await parse(save());
  for (const target of [id, added]) {
    expect(valueFor(after, target)).toBe(quantity ? 23 : 'effective edit');
    const sets = quantity ? extractQuantitiesOnDemand(after, target) : extractPropertiesOnDemand(after, target);
    expect(sets.filter(set => set.name === name)).toHaveLength(1);
    if (quantity) expect(extractQuantitiesOnDemand(after, target).find(set => set.name === name)?.quantities.find(row => row.name === 'UnchangedCount')?.value).toBe(7);
    else expect(extractPropertiesOnDemand(after, target).find(set => set.name === name)?.properties.find(row => row.name === 'UnchangedFlag')?.value).toBe(false);
  }
});

it('#7251 native copy refuses aggregate effective metadata work atomically instead of truncating a batch', async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const store = await parse(bytes), view = new MutablePropertyView(null, 'native'), editor = new StoreEditor(store, view);
  const id = addOrdinaryElementInStore(editor, resolveSpatialAnchor(store, 42, view), { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3 } });
  view.createPropertySet(id, 'Pset_BoundedClone', Array.from({ length: 100 }, (_, index) => ({ name: `Code${index}`, value: `native-${index}`, type: PropertyValueType.Label })));
  const saved = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const original = await parse(saved());
  const properties = extractPropertiesOnDemand(original, id).find(set => set.name === 'Pset_BoundedClone')?.properties;
  expect(properties).toHaveLength(100);
  // A single copy is supported; the aggregate is the bounded fan-out case.
  const one = recordCompoundMutation(view, draft => copyBatchInStore(store, new StoreEditor(store, draft), [id], [{ offset: [0, 3, 0] }])[0].copyId);
  expect(extractPropertiesOnDemand(await parse(saved()), one).find(set => set.name === 'Pset_BoundedClone')?.properties).toEqual(properties);
  undoRecordedMutationOperations(view, 1, () => { throw new Error('One native compound owns the copy'); });
  const historyBefore = view.getMutationCount();
  const before = await parse(saved());
  expect(() => copyBatchInStore(store, editor, [id], Array.from({ length: 150 }, (_, index) => ({ offset: [0, index + 1, 0] as const })))).toThrow(/10000 writes in one operation; no metadata is silently omitted/);
  expect(view.getMutationCount()).toBe(historyBefore);
  const after = await parse(saved());
  expect(after.entityIndex.byId.size).toBe(before.entityIndex.byId.size);
  expect(extractPropertiesOnDemand(after, id).find(set => set.name === 'Pset_BoundedClone')?.properties).toEqual(properties);
  // Refusal must not poison the next independently bounded operation.
  const retry = copyBatchInStore(store, editor, [id], [{ offset: [0, 3, 0] }])[0].copyId;
  expect(extractPropertiesOnDemand(await parse(saved()), retry).find(set => set.name === 'Pset_BoundedClone')?.properties).toEqual(properties);
});
