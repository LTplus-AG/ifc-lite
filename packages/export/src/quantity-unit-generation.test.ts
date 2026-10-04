/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, replayQuantityMutation, type Mutation } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { getCompleteEntityIndex } from './entity-iteration.js';

async function fixture() {
  const bytes = await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, view };
}

async function readExport({ store, view }: Awaited<ReturnType<typeof fixture>>, name: string) {
  const content = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const parsed = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  const row = [...getCompleteEntityIndex(parsed)].map(([expressId, location]) => extractor.extractEntity({ ...location, expressId, lineNumber: 0 })!).find(entity => entity.attributes[0] === name)!;
  return { row, parsed, extractor };
}

it('#6232 generated quantities retain an existing resolvable metre unit through actual export and parser', async () => {
  const model = await fixture();
  const reader = new EntityExtractor(model.store.source);
  const metre = model.store.entityIndex.byType.get('IFCSIUNIT')!.find(id => String(reader.extractEntity(model.store.entityIndex.byId.get(id)!)!.attributes[1]).includes('LENGTHUNIT'))!;
  expect(metre).toBeGreaterThan(0);
  new StoreEditor(model.store, model.view).addQuantitySet(1222, 'Qto_UnitWitness', [{ name: 'WitnessLength', value: 2.5, quantityType: 'LENGTH', unit: 'METRE' }]);
  const { row, parsed, extractor } = await readExport(model, 'WitnessLength');
  expect(row.attributes[2]).toBe(metre);
  expect(row.attributes[3]).toBe(2.5);
  expect(extractor.extractEntity(parsed.entityIndex.byId.get(metre)!)!.attributes).toEqual(reader.extractEntity(model.store.entityIndex.byId.get(metre)!)!.attributes);
});

// #6232 / #6765 review 4175656844: the current resolver knows only length
// units. Other quantity classes must retain '$', never a LENGTHUNIT reference.
for (const [type, ifcType] of [
  [QuantityType.Area, 'IFCQUANTITYAREA'], [QuantityType.Volume, 'IFCQUANTITYVOLUME'],
  [QuantityType.Weight, 'IFCQUANTITYWEIGHT'], [QuantityType.Count, 'IFCQUANTITYCOUNT'],
  [QuantityType.Time, 'IFCQUANTITYTIME'],
] as const) {
  it(`#6232 exports ${ifcType} without a wrong-dimensional metre reference`, async () => {
    const model = await fixture();
    model.view.createQuantitySet(1222, 'Qto_DimensionWitness', [{ name: 'WitnessDimension', value: 2.5, quantityType: type, unit: 'METRE' }]);
    const { row } = await readExport(model, 'WitnessDimension');
    expect(row.type).toBe(ifcType);
    expect(row.attributes[2]).toBeNull();
    expect(row.attributes[3]).toBe(2.5);
    expect(model.view.getQuantitiesForEntity(1222)[0].quantities[0].unit).toBe('METRE');
  });
}

it('#6232 serialized class Undo/Redo keeps metadata while export resolves only length units', async () => {
  const model = await fixture();
  model.view.createQuantitySet(1222, 'Qto_ReplayWitness', [{ name: 'WitnessReplay', value: 2.5, quantityType: QuantityType.Length, unit: 'METRE' }]);
  const mutation: Mutation = JSON.parse(JSON.stringify(model.view.setQuantity(1222, 'Qto_ReplayWitness', 'WitnessReplay', 3.5, QuantityType.Area)));
  expect((await readExport(model, 'WitnessReplay')).row.attributes[2]).toBeNull();
  replayQuantityMutation(model.view, mutation, 'undo', true);
  const { row: undone, parsed, extractor } = await readExport(model, 'WitnessReplay');
  expect(undone.type).toBe('IFCQUANTITYLENGTH');
  expect(undone.attributes[2]).toBeGreaterThan(0);
  expect(extractor.extractEntity(parsed.entityIndex.byId.get(Number(undone.attributes[2]))!)!.attributes[1]).toBe('.LENGTHUNIT.');
  expect(undone.attributes[3]).toBe(2.5);
  expect(model.view.getQuantitiesForEntity(1222)[0].quantities[0]).toMatchObject({ type: QuantityType.Length, unit: 'METRE' });
  replayQuantityMutation(model.view, mutation, 'redo', true);
  const { row: redone } = await readExport(model, 'WitnessReplay');
  expect(redone.type).toBe('IFCQUANTITYAREA');
  expect(redone.attributes[2]).toBeNull();
  expect(redone.attributes[3]).toBe(3.5);
  expect(model.view.getQuantitiesForEntity(1222)[0].quantities[0]).toMatchObject({ type: QuantityType.Area, unit: 'METRE' });
});
