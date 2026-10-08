/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: local SDK producer, actual Bonsai graph/atomic replacement contracts. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createModellingStoreBackend } from './store-modelling-backend.js';

const SAMPLE = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
describe.skipIf(!existsSync(SAMPLE))('#6232 source-owned SDK stair/railing commit', () => {
  for (const kind of ['stair', 'railing'] as const) it(`${kind} emits real bodies and retains prior work on late replacement refusal`, async () => {
    const bytes = readFileSync(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
    const prior = editor.addEntity('IfcCartesianPoint', [[7, 8, 9]]).expressId;
    const methods = createModellingStoreBackend(modelId => {
      if (modelId !== 'm') throw new Error('Unknown model');
      return { modelId, store, editor, mutationView: view, ownerHistoryId: null };
    });
    const addStair = methods.addStair, addRailing = methods.addRailing, replace = methods.replaceElement, remove = methods.removeStair;
    expect(addStair).toBeTypeOf('function'); expect(addRailing).toBeTypeOf('function');
    expect(replace).toBeTypeOf('function'); expect(remove).toBeTypeOf('function');
    if (!addStair || !addRailing || !replace || !remove) throw new Error('Missing optional capability');
    const stair = { Position: [1, 2, 0] as [number, number, number], NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1 };
    const railing = { Path: [[1, 2, 0], [3, 2, 0]] as [number, number, number][], Height: 1.1 };
    const ref = kind === 'stair' ? addStair('m', 42, stair) : addRailing('m', 42, railing);
    const snapshot = structuredClone({ records: view.getNewEntities(), journal: view.getMutations() }), next = view.peekNextExpressId();
    expect(() => replace(ref, 42, { kind: 'stair', params: { ...stair, GlobalId: 'invalid' } })).toThrow(/not a valid 22-character IFC GUID/);
    expect({ records: view.getNewEntities(), journal: view.getMutations() }).toEqual(snapshot);
    expect(view.peekNextExpressId()).toBe(next);
    const made = replace(ref, 42, { kind: 'stair', params: stair });
    const saved = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(saved.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(parsed.source);
    const rows = [...parsed.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const);
    expect(rows.find(([id]) => id === ref.expressId)).toBeUndefined();
    expect(rows.find(([id]) => id === made.expressId)?.[1]?.type).toBe('IFCSTAIR');
    const aggregate = rows.find(([, entity]) => entity?.type === 'IFCRELAGGREGATES' && entity.attributes[4] === made.expressId)?.[1];
    const parts = aggregate?.attributes[5];
    if (!Array.isArray(parts) || typeof parts[0] !== 'number') throw new Error('Missing real flight aggregation');
    const flight = rows.find(([id]) => id === parts[0])?.[1];
    expect(flight?.type).toBe('IFCSTAIRFLIGHT'); expect(flight?.attributes[6]).toBeTypeOf('number');
    expect(rows.some(([id]) => id === prior)).toBe(true);
    expect(remove(made)).toBe(true);
    expect(view.isDeleted(made.expressId)).toBe(true); expect(view.isDeleted(parts[0])).toBe(true);
    expect(view.getNewEntity(prior)?.attributes[0]).toEqual([7, 8, 9]);
  });
});
