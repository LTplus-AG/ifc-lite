/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9296 round 3: bim.store roofs by footprint through the package boundary; headless records one undo per edit. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createRecordedModellingBackend } from './headless/headless-backend-modelling.js';
import { createRecordedRoofBackend } from './headless/headless-backend-roof.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

const SAMPLE = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const STOREY = 42;
const D = Math.PI / 180;

async function model() {
  const bytes = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const resolve = (modelId?: string) => {
    if (modelId !== 'm') throw new Error('Unknown model');
    return { modelId, store, editor, mutationView: view, ownerHistoryId: null };
  };
  const methods = { ...createRecordedModellingBackend(resolve), ...createRecordedRoofBackend(resolve) };
  // The public namespace over just the store methods this test exercises.
  const bim = new StoreNamespace({ store: methods } as unknown as BimBackend);
  const exported = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
  return { view, bim, exported };
}

/** Overlay records by id: an undo puts a removed record back at the end of the list. */
const byId = (view: MutablePropertyView) => [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId);
const roofType = (text: string) => /IFCROOF\([^;]*,\.([A-Z_]+)\.\);/.exec(text)?.[1];

describe.skipIf(!existsSync(SAMPLE))('bim.store roof by footprint (#9296 round 3)', () => {
  it('addRoof takes a slope per edge; editRoof changes one edge and the overhang as one undoable edit', async () => {
    const { view, bim, exported } = await model();
    const roof = bim.addRoof('m', STOREY, { Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: [30 * D, 30 * D, 30 * D, 30 * D] });
    expect(roofType(exported())).toBe('HIP_ROOF');
    const afterAdd = structuredClone(byId(view));

    bim.editRoof(roof, { EdgeSlopes: [30 * D, 0, 30 * D, 0], Overhang: 0.5 });
    expect(roofType(exported())).toBe('GABLE_ROOF');
    expect(view.getPropertyValue(roof.expressId, 'IfcLite_RoofFootprint', 'Overhang')).toBe(0.5);

    undoRecordedMutationOperations(view, 1, () => { throw new Error('one compound roof edit expected'); });
    expect(roofType(exported())).toBe('HIP_ROOF');
    expect(byId(view)).toEqual(afterAdd);
    expect(view.getPropertyValue(roof.expressId, 'IfcLite_RoofFootprint', 'Overhang')).toBe(0);
  });

  it('a refused edit leaves no record to undo', async () => {
    const { view, bim } = await model();
    const roof = bim.addRoof('m', STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [10, 0], [10, 8], [0, 8]], Thickness: 0.25, EdgeSlopes: [10 * D, 0, 0, 0] });
    const journal = view.getMutations().length;
    expect(() => bim.editRoof(roof, { Edge: { Index: 0, Slope: 10 } })).toThrow(/slopes are radians/);
    expect(view.getMutations()).toHaveLength(journal);
  });

  it('the flat forms keep working unchanged', async () => {
    const { bim, exported } = await model();
    bim.addRoof('m', STOREY, { Position: [0, 0, 3], Width: 6, Depth: 4, Thickness: 0.3 });
    bim.addRoof('m', STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [6, 0], [3, 4]], Thickness: 0.3 });
    const text = exported();
    expect([...text.matchAll(/IFCROOF\([^;]*,\.([A-Z_]+)\.\);/g)].map((m) => m[1])).toEqual(['FLAT_ROOF', 'FLAT_ROOF']);
    expect(text).not.toContain('IfcLite_RoofFootprint');
  });
});
