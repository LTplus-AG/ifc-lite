/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act, Profiler } from 'react';
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
