/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { arrayCopyTransforms } from './copy-array.js';
import { copyBatchInStore, copySourcesInStore, copiedProductsInStore } from './copy-batch.js';
import { createCopyContext, productStoreyOrigin } from './copy-product.js';
import { addColumnToStore } from './column.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

// #6232 D5: real Bonsai source products and authored overlays share copy policy.
const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
let store: IfcDataStore;
let view: MutablePropertyView;
let editor: StoreEditor;
beforeEach(async () => {
  const bytes = readFileSync(sample);
  store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  view = new MutablePropertyView(null, 'm');
  editor = new StoreEditor(store, view);
});

it('copies a selection once per transform, carrying each selected window with its wall', () => {
  const ctx = createCopyContext(store, editor);
  const shown = copiedProductsInStore(ctx, [1222]);
  expect(shown).toHaveLength(3);
  const selection = [1222, ...shown.slice(1), 1222];
  expect(copySourcesInStore(ctx, selection)).toEqual({ ids: [1222] });
  const made = copyBatchInStore(store, editor, selection, [{ offset: [0, 3, 0] }, { offset: [0, 6, 0] }]);
  expect(made).toHaveLength(2);
  for (const copy of made) {
    expect(copy.openingIds).toHaveLength(2);
    expect(copy.fillingIds).toHaveLength(2);
    expect(copy.copiedFrom.get(copy.copyId)).toBe(1222);
    expect(copiedProductsInStore(createCopyContext(store, editor), [copy.copyId])).toEqual(copy.meshed);
  }
  const source = productStoreyOrigin(ctx, 1222)!;
  const origins = made.map(({ copyId }) => productStoreyOrigin(createCopyContext(store, editor), copyId)!.origin);
  expect(origins).toEqual([3, 6].map((dy) => [source.origin[0], source.origin[1] + dy, source.origin[2]]));
  const rootGuids = made.map(({ copyId }) => editor.getNewEntity(copyId)!.attributes[0]);
  expect(new Set(rootGuids).size).toBe(2);
});

it('uses Duplicate naming without changing the source Name and preserves exported host relations', async () => {
  const sourceName = createCopyContext(store, editor).read(1222)!.attributes[2];
  const [made] = copyBatchInStore(store, editor, [1222], [{ offset: [2, 0, 0] }], { duplicate: {} });
  expect(editor.getNewEntity(made.copyId)!.attributes[2]).toBe(`${sourceName} (copy)`);
  expect(createCopyContext(store, editor).read(1222)!.attributes[2]).toBe(sourceName);
  const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const reparsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const reparsedContext = createCopyContext(reparsed, new StoreEditor(reparsed, new MutablePropertyView(null, 'reparsed')));
  expect(reparsedContext.voids.get(made.copyId)?.map(({ id }) => id)).toEqual(made.openingIds);
  for (const [index, opening] of made.openingIds.entries()) expect(reparsedContext.fills.get(opening)?.map(({ id }) => id)).toEqual([made.fillingIds[index]]);
});

it('deep-copies authored shapes while retaining the source graph', () => {
  const source = addColumnToStore(editor, resolveSpatialAnchor(store, 42, view), { Position: [1, 2, 0], Width: .3, Depth: .4, Height: 3, Name: 'Overlay' });
  const records = structuredClone(editor.getNewEntities());
  const [made] = copyBatchInStore(store, editor, [source.columnId], [{ offset: [2, 0, 0], turn: Math.PI / 2 }], { duplicate: { name: 'Chosen copy' } });
  const original = editor.getNewEntity(source.columnId)!;
  const copy = editor.getNewEntity(made.copyId)!;
  expect(copy.attributes[6]).not.toBe(original.attributes[6]);
  expect(copy.attributes[0]).not.toBe(original.attributes[0]);
  expect(copy.attributes[2]).toBe('Chosen copy');
  expect(editor.getNewEntities().slice(0, records.length)).toEqual(records);
  expect(productStoreyOrigin(createCopyContext(store, editor), made.copyId)!.origin).toEqual([0, 1.0000000000000002, 0]);
});

it('rolls back an entire array when a later transform targets an unreadable storey', () => {
  const records = structuredClone(editor.getNewEntities());
  const journal = structuredClone(view.getMutations());
  const next = view.peekNextExpressId();
  expect(() => copyBatchInStore(store, editor, [1222], [{ offset: [0, 3, 0] }, { targetStoreyId: 99999999 }])).toThrow();
  expect(editor.getNewEntities()).toEqual(records);
  expect(view.getMutations()).toEqual(journal);
  expect(view.peekNextExpressId()).toBe(next);
});

it('refuses independent hosted selections and non-finite transforms without writes', () => {
  const ctx = createCopyContext(store, editor);
  const window = copiedProductsInStore(ctx, [1222])[1];
  expect(() => copyBatchInStore(store, editor, [window], [{}])).toThrow(/with its wall/);
  expect(() => copyBatchInStore(store, editor, [1222], [{ offset: [NaN, 0, 0] }])).toThrow(/finite/);
  expect(() => copyBatchInStore(store, editor, [1222], [])).toThrow(/transform/);
  expect(editor.getNewEntities()).toEqual([]);
});


it('uses linear fit and polar full-turn semantics on copied real product placements', () => {
  const fitted = arrayCopyTransforms({ mode: 'linear', count: 3, anchor: [0, 0], cursor: [0, 1], distance: 6, fit: true })!;
  expect(fitted).toEqual([{ offset: [0, 3, 0] }, { offset: [0, 6, 0] }]);
  const source = addColumnToStore(editor, resolveSpatialAnchor(store, 42, view), { Position: [1, 0, 0], Width: .3, Depth: .4, Height: 3 });
  const polar = arrayCopyTransforms({ mode: 'polar', count: 4, anchor: [0, 0], angleDegrees: 360 })!;
  expect(polar).toHaveLength(3);
  const made = copyBatchInStore(store, editor, [source.columnId], polar);
  const origins = made.map(({ copyId }) => productStoreyOrigin(createCopyContext(store, editor), copyId)!.origin);
  for (const [i, expected] of [[0, [0, 1, 0]], [1, [-1, 0, 0]], [2, [0, -1, 0]]] as const) {
    expected.forEach((n, axis) => expect(origins[i][axis]).toBeCloseTo(n));
  }
  expect(arrayCopyTransforms({ mode: 'polar', count: 3, anchor: [0, 0], angleDegrees: -180 })!.at(-1)!.turn).toBe(-Math.PI);
  expect(() => arrayCopyTransforms({ mode: 'polar', count: 10002, anchor: [0, 0] })).toThrow(/at most/);
});


it('bounds pruned root fan-out rather than selected hosted children (#6753 review)', () => {
  const ctx = createCopyContext(store, editor), selection = copiedProductsInStore(ctx, [1222]);
  expect(selection).toHaveLength(3);
  expect(copySourcesInStore(ctx, selection, 10000)).toEqual({ ids: [1222] });
  expect(copySourcesInStore(ctx, selection, 10001)).toEqual({ refusal: 'A copy batch may contain at most 10000 product copies' });
  const journal = structuredClone(view.getMutations()), next = view.peekNextExpressId();
  // 5001 roots are admissible even though wall + two selected fillings would
  // exceed the bound before pruning. Inject a late GUID fault at the actual
  // writer to prove this batch reaches it, without allocating 5001 graphs.
  expect(() => copyBatchInStore(store, editor, selection, Array.from({ length: 5001 }, () => ({})), {
    duplicate: { guidRandom: () => { throw new Error('Reached bounded root writer'); } },
  })).toThrow('Reached bounded root writer');
  expect(view.getMutations()).toEqual(journal);
  expect(view.peekNextExpressId()).toBe(next);
  expect(editor.getNewEntities()).toEqual([]);
});

it('rejects unknown array modes and overflowing derived coordinates before copies (#6753 review)', () => {
  const linear = { mode: 'linear' as const, count: 3, anchor: [0,0] as const, cursor: [1,0] as const, distance: 1e308 };
  expect(() => arrayCopyTransforms(linear)).toThrow(/extent.*finite/);
  expect(() => arrayCopyTransforms({ ...linear, count: 2, anchor: [-1e308,0], cursor: [1e308,0] })).toThrow(/direction.*finite/);
  expect(() => arrayCopyTransforms({ ...linear, mode: 'unsupported' as 'linear' })).toThrow(/Unsupported array mode/);
  expect(arrayCopyTransforms({ ...linear, fit: true })).toEqual([{ offset: [5e307,0,0] }, { offset: [1e308,0,0] }]);
  expect(editor.getNewEntities()).toEqual([]);
});
