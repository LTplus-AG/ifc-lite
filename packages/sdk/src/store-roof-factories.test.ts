/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createOrdinaryStoreBackend } from './store-ordinary-backend.js';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { createModellingStoreBackendWithoutStoreys } from './store-modelling-backend-without-storeys.js';
import type { RoofStoreBackendMethods } from './store-roof-types.js';

for (const [name, factory] of [['full', createModellingStoreBackend], ['slim', createModellingStoreBackendWithoutStoreys]] as const) {
  it(`${name} modelling factory rebuilds footprint roofs through editRoof (#9356, #9398)`, async () => {
    const bytes = readFileSync(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'roof-factory');
    const editor = new StoreEditor(store, view);
    const resolve = () => ({ modelId: 'roof-factory', store, editor, mutationView: view, ownerHistoryId: null });
    const roof = createOrdinaryStoreBackend(resolve).addRoof('roof-factory', 42, {
      Position: [0,0,3], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI / 6),
    });
    const originalShape = editor.getNewEntity(roof.expressId)?.attributes[6];
    const backend = factory(resolve);
    const edit = Reflect.get(backend, 'editRoof') as RoofStoreBackendMethods['editRoof'];
    expect(edit, `${name} factory exposes the roof method`).toBeTypeOf('function');
    if (!edit) throw new Error('Missing editRoof');
    expect(edit(roof, { EdgeSlopes: [Math.PI / 6,0,Math.PI / 6,0], Overhang: .5 })).toEqual(roof);
    expect(view.getPositionalMutationsForEntity(roof.expressId)?.get(6)).not.toEqual(originalShape);
    expect(view.getPropertyValue(roof.expressId, 'IfcLite_RoofFootprint', 'Overhang')).toBe(.5);
    const output = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    expect(output).toContain('.GABLE_ROOF.');
  });
}
