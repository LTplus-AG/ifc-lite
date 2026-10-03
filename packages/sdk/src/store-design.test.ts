/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: real Bonsai source, graph ownership and atomic refusal through SDK producers. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createModellingStoreBackend } from './store-modelling-backend.js';

const SAMPLE = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
async function setup() {
  const bytes = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const methods = createModellingStoreBackend(modelId => {
    if (modelId !== 'm') throw new Error('Unknown model');
    return { modelId, store, editor, mutationView: view, ownerHistoryId: null };
  });
  return { store, view, editor, methods };
}

describe('#6232 loaded-model design builders', () => {
  it('exports the curtain aggregate and all owned parts and rolls back a late invalid profile', async () => {
    const { store, view, editor, methods } = await setup();
    const add = methods.addCurtainWall;
    expect(add).toBeTypeOf('function');
    if (!add) throw new Error('Missing curtain wall capability');
    const prior = editor.addEntity('IfcCartesianPoint', [[7, 8, 9]]).expressId;
    const params = { Start: [0, 5, 0] as [number, number, number], End: [4, 5, 0] as [number, number, number], Height: 3, UGrid: 2, VGrid: 2 };
    const ref = add('m', 42, params);
    expect(ref.modelId).toBe('m');
    const snapshot = structuredClone({ records: view.getNewEntities(), journal: view.getMutations() }), next = view.peekNextExpressId();
    expect(() => add('m', 42, { ...params, PanelThickness: -1 })).toThrow();
    expect({ records: view.getNewEntities(), journal: view.getMutations() }).toEqual(snapshot);
    expect(view.peekNextExpressId()).toBe(next);
    expect(() => add('other', 42, params)).toThrow(/Unknown model/);
    const saved = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(saved.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(parsed.source);
    const rows = [...parsed.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const);
    expect(rows.find(([id]) => id === ref.expressId)?.[1]?.type).toBe('IFCCURTAINWALL');
    const parts = rows.find(([, e]) => e?.type === 'IFCRELAGGREGATES' && e.attributes[4] === ref.expressId)?.[1]?.attributes[5];
    expect(Array.isArray(parts)).toBe(true);
    if (!Array.isArray(parts)) throw new Error('Missing aggregate');
    expect(parts.length).toBeGreaterThan(4);
    for (const id of parts) {
      const product = rows.find(([rowId]) => rowId === id)?.[1];
      expect(['IFCMEMBER', 'IFCPLATE']).toContain(product?.type);
      expect(product?.attributes[6]).toBeTypeOf('number');
    }
    expect(rows.some(([id]) => id === prior)).toBe(true);
  });

  it('binds to persisted source axes and refuses a stale position without spending IDs or journal entries', async () => {
    const { store, view, methods } = await setup();
    expect(methods.addGrid).toBeTypeOf('function');
    if (!methods.addGrid) throw new Error('Missing grid capability');
    const grid = methods.addGrid('m', 42, { UAxes: [{ Tag: 'U', Start: [0, 0], End: [4, 0] }], VAxes: [{ Tag: 'V', Start: [2, -2], End: [2, 2] }] });
    const saved = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(saved.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(parsed.source);
    const location = parsed.entityIndex.byId.get(grid.expressId);
    if (!location) throw new Error('Missing persisted grid');
    const row = extractor.extractEntity(location);
    const u = row?.attributes[7], v = row?.attributes[8];
    if (!Array.isArray(u) || !Array.isArray(v) || typeof u[0] !== 'number' || typeof v[0] !== 'number') throw new Error('Missing source axes');
    const sourceView = new MutablePropertyView(null, 'm'), sourceEditor = new StoreEditor(parsed, sourceView);
    const sourceMethods = createModellingStoreBackend(modelId => {
      if (modelId !== 'm') throw new Error('Unknown model');
      return { modelId, store: parsed, editor: sourceEditor, mutationView: sourceView, ownerHistoryId: null };
    });
    if (!sourceMethods.addColumnOnGrid) throw new Error('Missing grid column capability');
    const binding = { GridId: grid.expressId, IntersectingAxes: [u[0], v[0]] as const };
    const params = { Position: [2, 0, 0] as [number, number, number], Profile: { Type: 'Circle' as const, Radius: .2 }, Height: 3 };
    const ref = sourceMethods.addColumnOnGrid('m', 42, params, binding);
    expect(sourceView.getNewEntity(ref.expressId)?.type).toBe('IfcColumn');
    expect(sourceView.getNewEntities().some(e => e.type === 'IfcGridPlacement')).toBe(true);
    const before = structuredClone({ records: sourceView.getNewEntities(), journal: sourceView.getMutations() }), next = sourceView.peekNextExpressId();
    expect(() => sourceMethods.addColumnOnGrid?.('m', 42, { ...params, Position: [2.1, 0, 0] }, binding)).toThrow(/no longer matches/);
    expect({ records: sourceView.getNewEntities(), journal: sourceView.getMutations() }).toEqual(before);
    expect(sourceView.peekNextExpressId()).toBe(next);
  });
});
