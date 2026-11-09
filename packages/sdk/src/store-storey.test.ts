/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: bim.store storey authoring runs the shared create path; headless records one undo per call. */
import * as create from '@ifc-lite/create';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
// Through the package index: with the split reverted the name is undefined (an assertion fails), not an import error.
import * as sdkIndex from './index.js';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { createStoreyStoreBackend } from './store-storey-backend.js';
import { createRecordedModellingBackend } from './headless/headless-backend-modelling.js';

/** #9013: the storey API through the package boundary. A revert of production fails this assertion, not a module load. */
function api<K extends keyof typeof create>(name: K): (typeof create)[K] {
  expect(typeof create[name], `${String(name)} is exported by @ifc-lite/create`).toBe('function');
  return create[name];
}


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
    for (const method of [addStorey, planStoreyEdit, editStorey, listStoreyLevels, deleteStorey, renameStorey]) expect(method).toBeTypeOf('function');
    if (!addStorey || !planStoreyEdit || !editStorey || !listStoreyLevels || !deleteStorey || !renameStorey) return;

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
    expect(api('readStoreyInventory')(reloaded, new MutablePropertyView(null, 'r')).storeys.map((s) => [s.Name, s.elevation])).toEqual([['My Storey', 0], ['Upper', 3.4]]);

    deleteStorey(level2, { kind: 'empty' });
    expect(listStoreyLevels('m').map((row) => row.Name)).toEqual(['My Storey']);
  });

  it('refuses a reviewed plan once the model has changed under it (#9013 review)', async () => {
    const { resolve } = await model();
    const { addStorey, planStoreyEdit, editStorey, planStoreyDelete, deleteStorey, listStoreyLevels } = createModellingStoreBackend(resolve);
    for (const method of [addStorey, planStoreyEdit, editStorey, planStoreyDelete, deleteStorey, listStoreyLevels]) expect(method).toBeTypeOf('function');
    if (!addStorey || !planStoreyEdit || !editStorey || !planStoreyDelete || !deleteStorey || !listStoreyLevels) return;
    const level2 = addStorey('m', { Name: 'Level 2', Elevation: 3 });

    // A plan reviewed for another edit is not this edit's plan.
    const other = planStoreyEdit('m', { kind: 'floorHeight', storeyId: 42, Height: 3.6 });
    expect(() => editStorey('m', { kind: 'floorHeight', storeyId: 42, Height: 3.4 }, other)).toThrow('planned against a model that has changed');
    const reviewed = planStoreyEdit('m', { kind: 'floorHeight', storeyId: 42, Height: 3.4 });
    expect(editStorey('m', { kind: 'floorHeight', storeyId: 42, Height: 3.4 }, reviewed)).toEqual([level2]);

    // A deletion reviewed while Level 2 was empty does not delete a wall placed on it since.
    const mode = { kind: 'deleteContents' } as const;
    const reviewedDelete = planStoreyDelete(level2, mode);
    expect(reviewedDelete.contents).toEqual([]);
    const { editor } = resolve('m');
    const wall = editor.addEntity('IfcWall', ['3JUHrTM_j3UxZiBnyBfByx', null, 'Late', null, null, null, null, null, null]).expressId;
    editor.addEntity('IfcRelContainedInSpatialStructure', ['3tI3d7B1T4ivX8X0SA4yuM', null, null, null, [`#${wall}`], `#${level2.expressId}`]);
    expect(() => deleteStorey(level2, mode, reviewedDelete)).toThrow('planned against a model that has changed');
    expect(listStoreyLevels('m').map((row) => [row.Name, row.elementCount])).toEqual([['Level 2', 1], ['My Storey', 4]]);
    deleteStorey(level2, mode, planStoreyDelete(level2, mode));
    expect(listStoreyLevels('m').map((row) => row.Name)).toEqual(['My Storey']);
  });

  it('records each headless storey write as one undo step', async () => {
    const { view, resolve } = await model();
    const recorded = createRecordedModellingBackend(resolve);
    expect('addStorey' in recorded, 'the headless backend records storey writes').toBe(true);
    const level2 = recorded.addStorey('m', { Name: 'Level 2', Elevation: 3 });
    const afterAdd = structuredClone(view.getNewEntities());
    recorded.editStorey('m', { kind: 'elevation', storeyId: level2.expressId, Elevation: 3.6 });
    expect(recorded.listStoreyLevels('m')[0].elevation).toBe(3.6);
    undoRecordedMutationOperations(view, 1, () => { throw new Error('one compound storey edit expected'); });
    expect(recorded.listStoreyLevels('m')[0].elevation).toBe(3);
    expect(view.getNewEntities()).toEqual(afterAdd);
  });

  // #9200: the viewer builds its modelling methods at startup and brings its
  // own storey methods. A factory without the storey spread lets that bundle
  // leave the storey planners out, so it must be exactly the full factory
  // minus the storey methods, and the full factory must keep them.
  it('the factory without storeys is the full factory minus exactly the storey methods (#9200)', async () => {
    const { resolve } = await model();
    const slim = (sdkIndex as Record<string, unknown>).createModellingStoreBackendWithoutStoreys;
    expect(slim, 'createModellingStoreBackendWithoutStoreys is exported').toBeTypeOf('function');
    const without = (slim as typeof createModellingStoreBackend)(resolve);
    const full = createModellingStoreBackend(resolve);
    const storeyKeys = Object.keys(createStoreyStoreBackend(resolve));
    expect(storeyKeys).toContain('addStorey');
    for (const key of storeyKeys) {
      expect(full[key as keyof typeof full], `the full factory keeps ${key}`).toBeTypeOf('function');
      expect(key in without, `${key} is left out`).toBe(false);
    }
    expect(Object.keys(without).sort()).toEqual(Object.keys(full).filter((key) => !storeyKeys.includes(key)).sort());
  });
});
