/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5861: Bulk edit and CSV import write straight to the model's
 * `MutablePropertyView`. Their runs must land on the undo stack as ONE step
 * (one Ctrl+Z reverts the run, one Ctrl+Y re-applies it), mark the model
 * dirty, and a batch must replay without recursing per mutation.
 *
 * Drives the real `BulkQueryEngine` / `CsvConnector` over a real parsed
 * store, then the real viewer store's `recordMutationBatch` / `undo` / `redo`.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, CsvConnector, MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store/index.js';

const WALLS = [1, 2, 3, 4, 5].map((n) => 100 + n);

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('bulk.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
${WALLS.map((id) => `#${id}=IFCWALL('0Wall00000000000000${id}',$,'W${id}',$,$,$,$,'T${id}',$);`).join('\n')}
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function install(modelIds: readonly string[]): Map<string, MutablePropertyView> {
  const views = new Map(modelIds.map((id) => [id, new MutablePropertyView(null, id)] as const));
  useViewerStore.setState({
    mutationViews: views,
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
  });
  return views;
}

const value = (view: MutablePropertyView, id: number) => view.getPropertyValue(id, 'Pset_Bulk', 'Code');

describe('bulk writers are one undo step (#5861)', () => {
  let store: IfcDataStore;
  beforeEach(async () => { store ??= await parse(); });

  it('a Bulk run over N walls is reverted by one undo and re-applied by one redo', () => {
    const view = install(['m']).get('m')!;
    const engine = new BulkQueryEngine(store.entities, view);
    const ids = engine.select({ entityTypes: [...new Set(WALLS.map((id) => store.entities.getTypeEnum(id)))] });
    assert.deepEqual([...ids].sort(), WALLS);
    const mutations = ids.map((id) => engine.applyAction(id, {
      type: 'SET_PROPERTY', psetName: 'Pset_Bulk', propName: 'Code', value: 'X', valueType: PropertyValueType.Label,
    })).filter((m): m is Mutation => m !== null);

    useViewerStore.getState().recordMutationBatch('m', mutations);
    assert.ok(useViewerStore.getState().dirtyModels.has('m'), 'the run marks the model dirty');

    useViewerStore.getState().undo('m');
    for (const id of WALLS) assert.equal(value(view, id), null, `wall #${id} restored`);
    assert.equal(useViewerStore.getState().undoStacks.get('m')!.length, 0);

    useViewerStore.getState().redo('m');
    for (const id of WALLS) assert.equal(value(view, id), 'X', `wall #${id} re-applied`);
    assert.equal(useViewerStore.getState().redoStacks.get('m')!.length, 0);
  });

  it('a CSV import is reverted by one undo', async () => {
    const view = install(['m']).get('m')!;
    const csv = ['Name,Code', ...WALLS.map((id) => `W${id},C${id}`)].join('\n');
    const stats = await new CsvConnector(store.entities, view, store.strings).importAsync(csv, {
      matchStrategy: { type: 'name', column: 'Name' },
      propertyMappings: [{ sourceColumn: 'Code', targetPset: 'Pset_Bulk', targetProperty: 'Code', valueType: PropertyValueType.Label }],
    }, () => {});
    assert.equal(stats.mutations.length, WALLS.length);
    for (const id of WALLS) assert.equal(value(view, id), `C${id}`);

    useViewerStore.getState().recordMutationBatch('m', stats.mutations);
    useViewerStore.getState().undo('m');
    for (const id of WALLS) assert.equal(value(view, id), null, `wall #${id} restored`);
  });

  it('a cancelled run keeps its applied part undoable, and only the batch is undone', () => {
    const view = install(['m']).get('m')!;
    // An earlier, separate edit that must survive the batch undo.
    const before = view.setProperty(WALLS[4], 'Pset_Bulk', 'Code', 'KEEP', PropertyValueType.Label);
    useViewerStore.getState().recordMutationBatch('m', [before]);
    // The run stopped after two of five entities.
    const applied = WALLS.slice(0, 2).map((id) => view.setProperty(id, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label));
    useViewerStore.getState().recordMutationBatch('m', applied);

    useViewerStore.getState().undo('m');
    assert.equal(value(view, WALLS[0]), null);
    assert.equal(value(view, WALLS[1]), null);
    assert.equal(value(view, WALLS[4]), 'KEEP', 'the undo stops at the batch boundary');
    assert.equal(useViewerStore.getState().undoStacks.get('m')!.length, 1);
  });

  it('a batch lands on the edited model only (N models)', () => {
    const views = install(['a', 'b']);
    const m = views.get('b')!.setProperty(WALLS[0], 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label);
    useViewerStore.getState().recordMutationBatch('b', [m]);
    assert.equal(useViewerStore.getState().undoStacks.get('a'), undefined);
    assert.equal(useViewerStore.getState().undoStacks.get('b')!.length, 1);
    assert.deepEqual([...useViewerStore.getState().dirtyModels], ['b']);
    useViewerStore.getState().undo('a');
    assert.equal(value(views.get('b')!, WALLS[0]), 'X', 'undo on another model leaves it alone');
    useViewerStore.getState().undo('b');
    assert.equal(value(views.get('b')!, WALLS[0]), null);
  });

  it('a Bulk retype (SET_ENTITY_TYPE) is reverted by one undo and re-applied by one redo (#5958)', () => {
    const view = install(['m']).get('m')!;
    const engine = new BulkQueryEngine(store.entities, view);
    const mutations = WALLS.map((id) => engine.applyAction(id, { type: 'SET_ENTITY_TYPE', entityType: 'IfcColumn' }))
      .filter((m): m is Mutation => m !== null);
    assert.equal(mutations.length, WALLS.length);
    useViewerStore.getState().recordMutationBatch('m', mutations);

    useViewerStore.getState().undo('m');
    for (const id of WALLS) assert.equal(view.getEntityTypeMutation(id), null, `wall #${id} keeps its class`);
    useViewerStore.getState().redo('m');
    for (const id of WALLS) assert.equal(view.getEntityTypeMutation(id)?.newType.toUpperCase(), 'IFCCOLUMN', `wall #${id} retyped again`);
  });

  it('chunks recorded under one batch id are one undo step (#5958)', () => {
    const view = install(['m']).get('m')!;
    const write = (ids: readonly number[]) => ids.map((id) => view.setProperty(id, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label));
    const batchId = useViewerStore.getState().recordMutationBatch('m', write(WALLS.slice(0, 2)));
    assert.ok(batchId);
    assert.equal(useViewerStore.getState().recordMutationBatch('m', write(WALLS.slice(2)), batchId), batchId);

    useViewerStore.getState().undo('m');
    for (const id of WALLS) assert.equal(value(view, id), null, `wall #${id} restored`);
    assert.equal(useViewerStore.getState().undoStacks.get('m')!.length, 0);
  });

  it('a chunk never extends a tag map another writer has replaced since (#5958)', () => {
    const view = install(['m']).get('m')!;
    const write = (ids: readonly number[]) => ids.map((id) => view.setProperty(id, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label));
    const batchId = useViewerStore.getState().recordMutationBatch('m', write(WALLS.slice(0, 2)))!;
    const before = useViewerStore.getState().mutationBatchTags;
    // Another writer tags something in between: the map is replaced.
    useViewerStore.getState().tagMutationBatch(['elsewhere'], 'other');
    const later = write(WALLS.slice(2));
    useViewerStore.getState().recordMutationBatch('m', later, batchId);
    assert.ok(later.every((m) => !before.has(m.id)), 'the replaced map is left as it was');
    assert.ok(later.every((m) => useViewerStore.getState().mutationBatchTags.get(m.id) === batchId));
    useViewerStore.getState().undo('m');
    for (const id of WALLS) assert.equal(value(view, id), null, `wall #${id} restored by one undo`);
  });

  it('recording a 100,000-mutation run in 500-mutation chunks stays fast (#5958)', () => {
    const view = install(['m']).get('m')!;
    const chunks: Mutation[][] = [];
    for (let c = 0; c < 200; c += 1) {
      chunks.push(Array.from({ length: 500 }, (_, i) => view.setProperty(c * 500 + i + 1, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label)));
    }
    const t0 = performance.now();
    let batchId: string | undefined;
    for (const chunk of chunks) batchId = useViewerStore.getState().recordMutationBatch('m', chunk, batchId) ?? batchId;
    const elapsed = performance.now() - t0;
    assert.equal(useViewerStore.getState().undoStacks.get('m')!.length, 100_000);
    assert.ok(elapsed < 3_000, `recording took ${elapsed.toFixed(0)} ms`);
    useViewerStore.getState().undo('m');
    assert.equal(useViewerStore.getState().undoStacks.get('m')!.length, 0, 'still one undo step');
  });

  it('every chunk of a run ends the placement redo branch, not only the first (#5958)', () => {
    const view = install(['m']).get('m')!;
    const write = (id: number) => [view.setProperty(id, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label)];
    const batchId = useViewerStore.getState().recordMutationBatch('m', write(WALLS[0]))!;
    // A model move lands mid-run and is undone: it sits on the placement redo branch.
    const move = { timestamp: Date.now() } as ViewerState['modelPlacement']['redo'][number];
    useViewerStore.setState((s) => ({ modelPlacement: { ...s.modelPlacement, undo: [], redo: [move] } }));
    useViewerStore.getState().recordMutationBatch('m', write(WALLS[1]), batchId);
    assert.deepEqual(useViewerStore.getState().modelPlacement.redo, [], 'a new chunk is a new operation');
  });

  it('undoing a 10,000-mutation batch neither overflows the stack nor takes seconds', () => {
    const view = install(['m']).get('m')!;
    const mutations: Mutation[] = [];
    for (let i = 1; i <= 10_000; i += 1) mutations.push(view.setProperty(i, 'Pset_Bulk', 'Code', 'X', PropertyValueType.Label));
    useViewerStore.getState().recordMutationBatch('m', mutations);
    const t0 = performance.now();
    useViewerStore.getState().undo('m');
    const elapsed = performance.now() - t0;
    assert.equal(value(view, 1), null);
    assert.equal(value(view, 10_000), null);
    assert.equal(useViewerStore.getState().redoStacks.get('m')!.length, 10_000);
    assert.ok(elapsed < 2_000, `undo took ${elapsed.toFixed(0)} ms`);
    useViewerStore.getState().redo('m');
    assert.equal(value(view, 10_000), 'X');
  });
});
