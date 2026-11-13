/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act, Profiler } from 'react';
import { StepExporter } from '@ifc-lite/export';
import { EntityExtractor } from '@ifc-lite/parser';
import { cleanup, render, advance, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from '../HierarchyPanel';
import { WorkspaceStoreyControl } from './WorkspaceStoreyChip';

let column: number;
let restore = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  const made = useViewerStore.getState().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: .3, Depth: .3, Height: 3 });
  assert.ok('expressId' in made); column = made.expressId;
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  useViewerStore.setState({ hierarchyMode: 'spatial', selectedStoreys: new Set(), isolatedEntities: null, classFilter: null });
});
afterEach(() => { cleanup(); restore(); useViewerStore.getState().exitModelWorkspace(); });

for (const [name, Panel] of [['storey control', WorkspaceStoreyControl], ['spatial hierarchy', HierarchyPanel]] as const) {
  it(`#9296 ${name} ignores column Move/Undo but updates its storey Name on edit/undo/redo`, async () => {
    let commits = 0;
    const ui = render(<SourceHostProvider><Profiler id={name} onRender={() => commits++}><Panel /></Profiler></SourceHostProvider>);
    await advance(100); // initial expansion and idle projection are outside the edit
    const before = commits;
    act(() => { assert.ok(useViewerStore.getState().translateEntity(MODEL_ID, column, [.5, 0, 0]).ok); });
    assert.equal(commits, before, 'unrelated placement does not schedule this panel');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.equal(commits, before, 'unrelated undo does not schedule this panel');
    act(() => { recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(STOREY, 2, 'Renamed level')); });
    assert.match(ui.textContent ?? '', /Renamed level/);
    assert.ok(commits > before, 'its own data schedules the panel');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.doesNotMatch(ui.textContent ?? '', /Renamed level/);
    act(() => useViewerStore.getState().redo(MODEL_ID));
    assert.match(ui.textContent ?? '', /Renamed level/);
  });
}

it('#9296 the storey control snapshot stays stable while a loaded model has no overlay yet', async () => {
  useViewerStore.setState({ mutationViews: new Map() });
  const ui = render(<WorkspaceStoreyControl />);
  await advance(0);
  assert.ok(ui.querySelector('[data-workspace-storey-chip]'), 'loaded storeys remain usable before overlay registration');
});


it('#9296 spatial hierarchy refreshes product labels and deletion through undo/redo', async () => {
  const ui = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  await advance(100);
  const search = ui.querySelector('input');
  assert.ok(search);
  type(search, 'Column label');
  act(() => { recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(column, 2, 'Column label')); });
  assert.match(ui.textContent ?? '', /Column label/);
  assert.doesNotMatch(ui.textContent ?? '', /No matches/);
  act(() => useViewerStore.getState().undo(MODEL_ID));
  assert.match(ui.textContent ?? '', /No matches/);
  act(() => useViewerStore.getState().redo(MODEL_ID));
  assert.doesNotMatch(ui.textContent ?? '', /No matches/);
  act(() => { assert.ok(useViewerStore.getState().removeEntity(MODEL_ID, column)); });
  assert.match(ui.textContent ?? '', /No matches/);
  act(() => useViewerStore.getState().undo(MODEL_ID));
  assert.doesNotMatch(ui.textContent ?? '', /No matches/);
  act(() => useViewerStore.getState().redo(MODEL_ID));
  assert.match(ui.textContent ?? '', /No matches/);
});


it('#9296 a loaded column with an initially empty overlay does not invalidate the spatial hierarchy', async () => {
  const s = useViewerStore.getState();
  const data = s.models.get(MODEL_ID)!.ifcDataStore!;
  const { content } = new StepExporter(data, s.mutationViews.get(MODEL_ID)!).export({ schema: 'IFC4', applyMutations: true });
  await seedModelingSession({ step: new TextDecoder().decode(content) });
  useViewerStore.setState({ hierarchyMode: 'spatial' });
  const entities = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.entities;
  const loadedColumn = [...entities.expressId].find(id => entities.getTypeName(id) === 'IfcColumn');
  assert.ok(loadedColumn);
  const store = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!;
  const extractor = new EntityExtractor(store.source);
  const read = (id: number) => {
    const ref = store.entityIndex.byId.get(id);
    assert.ok(ref);
    const entity = extractor.extractEntity(ref);
    assert.ok(entity);
    return entity;
  };
  const placement = Number(read(loadedColumn).attributes[5]);
  const axis = Number(read(placement).attributes[1]);
  const point = Number(read(axis).attributes[0]);
  const coordinates = read(point).attributes[0];
  assert.ok(Array.isArray(coordinates));
  const moved = coordinates.map(Number);
  moved[0] += .5;
  let commits = 0;
  render(<SourceHostProvider><Profiler id="loaded-hierarchy" onRender={() => commits++}><HierarchyPanel /></Profiler></SourceHostProvider>);
  await advance(100);
  const before = commits;
  // The unit fixture has no captured native admission artifact. Exercise the
  // actual positional leaf write through the same atomic store publication;
  // the F5 GPU probe separately exercises the real admitted Move gesture.
  act(() => { recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(point, 0, moved)); });
  assert.equal(commits, before, 'the first positional override changes no spatial row');
  act(() => useViewerStore.getState().undo(MODEL_ID));
  assert.equal(commits, before, 'returning to an empty overlay changes no spatial row');
});
