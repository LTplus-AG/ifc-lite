/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: bim.store storey authoring runs the shared create path; headless records one undo per call. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { readStoreyInventory } from '@ifc-lite/create';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { createRecordedModellingBackend } from './headless/headless-backend-modelling.js';

const SAMPLE = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

async function model() {
  const bytes = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const resolve = (modelId?: string) => {
    if (modelId !== 'm') throw new Error('Unknown model');
    return { modelId, store, editor, mutationView: view, ownerHistoryId: null };
  };
  return { store, view, resolve };
}

describe.skipIf(!existsSync(SAMPLE))('bim.store storey authoring (#9013)', () => {
  it('adds, plans, re-levels and deletes through the shared factory', async () => {
    const { store, view, resolve } = await model();
    const store_ = createModellingStoreBackend(resolve);
    const { addStorey, planStoreyEdit, editStorey, listStoreyLevels, deleteStorey, renameStorey } = store_;
    if (!addStorey || !planStoreyEdit || !editStorey || !listStoreyLevels || !deleteStorey || !renameStorey) throw new Error('Missing storey capability');

    const level2 = addStorey('m', { Name: 'Level 2', Elevation: 3 });
    renameStorey(level2, 'Upper');
    expect(listStoreyLevels('m').map((row) => [row.Name, row.elevation, row.height])).toEqual([['Upper', 3, null], ['My Storey', 0, 3]]);

    const plan = planStoreyEdit('m', { kind: 'floorHeight', storeyId: 42, Height: 3.4 });
    expect(plan.refusals).toEqual([]);
    expect(plan.storeys.map((s) => [s.expressId, s.to])).toEqual([[level2.expressId, 3.4]]);
    // A dry run writes nothing.
    expect(listStoreyLevels('m')[0].elevation).toBe(3);

    expect(editStorey('m', { kind: 'floorHeight', storeyId: 42, Height: 3.4 })).toEqual([level2]);
    expect(() => editStorey('m', { kind: 'elevation', storeyId: level2.expressId, Elevation: 0 }))
      .toThrow('Upper at ±0.00 m would leave no height between it and My Storey');

    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4X3', applyMutations: true }).content);
    const reloaded = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    expect(readStoreyInventory(reloaded, new MutablePropertyView(null, 'r')).storeys.map((s) => [s.Name, s.elevation])).toEqual([['My Storey', 0], ['Upper', 3.4]]);

    deleteStorey(level2, { kind: 'empty' });
    expect(listStoreyLevels('m').map((row) => row.Name)).toEqual(['My Storey']);
  });

  it('records each headless storey write as one undo step', async () => {
    const { view, resolve } = await model();
    const recorded = createRecordedModellingBackend(resolve);
    const level2 = recorded.addStorey('m', { Name: 'Level 2', Elevation: 3 });
    const afterAdd = structuredClone(view.getNewEntities());
    recorded.editStorey('m', { kind: 'elevation', storeyId: level2.expressId, Elevation: 3.6 });
    expect(recorded.listStoreyLevels('m')[0].elevation).toBe(3.6);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('one compound storey edit expected'); });
    expect(recorded.listStoreyLevels('m')[0].elevation).toBe(3);
    expect(view.getNewEntities()).toEqual(afterAdd);
  });
});
