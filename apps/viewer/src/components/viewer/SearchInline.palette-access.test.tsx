/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, advance, cleanup, click, mouseDown, press, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { loadRecentSearches, pushRecentSearch, clearRecentSearches } from '@/lib/search/recent-searches';
import { paletteSurfaceCommands } from './surface-commands.js';
import { canRunPaletteCommand } from './palette-availability.js';
import { SearchInline } from './SearchInline.js';
import { MobileSearchInline } from './MobileSearchInline.js';
import { RecentsPopoverBody, SearchPopoverBody } from './SearchInlinePopoverBody.js';

const initial = useViewerStore.getState();
const savedRecents = localStorage.getItem('ifc-lite:search:recents');
afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState(initial, true));
  if (savedRecents === null) localStorage.removeItem('ifc-lite:search:recents');
  else localStorage.setItem('ifc-lite:search:recents', savedRecents);
});
function inlineCommand() {
  const row = paletteSurfaceCommands({ canEditInSession: true }, () => {}).find(c => c.id === 'search:inline');
  assert.ok(row);
  return row;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  assert.ok(found, text);
  return found;
}
function seed() {
  clearRecentSearches();
  pushRecentSearch('Wall');
  const model = fixtureModel('m');
  model.ifcDataStore = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
    { expressId: 42, type: 'IfcWall', name: 'Wall A' },
    { expressId: 43, type: 'IfcWall', name: 'Wall B' },
  ] });
  useViewerStore.setState({ ...fixtureModels(model), searchQuery: '', searchOpen: false,
    searchVimCycle: null, searchIndexes: new Map(), searchModalOpen: false });
}

describe('inline palette access (#8947)', () => {
  for (const mobile of [false, true]) it(`reaches recents, live scan, cycle and clear on ${mobile ? 'mobile' : 'desktop'}`, async () => {
    seed();
    const ui = render(mobile ? <MobileSearchInline /> : <SearchInline compact />);
    const command = inlineCommand();
    assert.equal(canRunPaletteCommand(command), true);
    act(() => command.action());
    const input = ui.querySelector('input')!;
    assert.equal(document.activeElement, input);
    assert.equal(input.closest('[hidden]'), null, 'mobile host revealed before focus');
    assert.equal(useViewerStore.getState().searchModalOpen, false);
    activate(button('Wall'), ' ');
    assert.equal(useViewerStore.getState().searchQuery, 'Wall');
    await advance(100);
    press(input, 'Enter');
    assert.equal(useViewerStore.getState().searchVimCycle?.results.length, 2);
    assert.equal(useViewerStore.getState().selectedEntity?.expressId, 42);
    // Canonical cycle handler, with focus outside the editable field.
    act(() => input.blur());
    press(window, 'n');
    assert.equal(useViewerStore.getState().selectedEntity?.expressId, 43);
    act(() => { useViewerStore.getState().setSearchQuery(''); command.action(); });
    activate(button('Clear'), 'Enter');
    assert.deepEqual(loadRecentSearches(), []);
    cleanup();
    assert.equal(canRunPaletteCommand(command), false, 'stale row refuses after the field owner unmounts');
  });

  for (const key of ['Enter', ' '] as const) it(`native ${JSON.stringify(key)} invokes recents and advanced controls once`, () => {
    let picked = ''; let clears = 0; let advanced = 0; let selections = 0;
    render(<RecentsPopoverBody recents={['Wall']} onPick={q => { picked += q; }} onClear={() => { clears++; }} />);
    activate(button('Wall'), key);
    activate(button('Clear'), key);
    assert.equal(picked, 'Wall');
    assert.equal(clears, 1);
    render(<SearchPopoverBody results={[{ modelId: 'm', expressId: 42, typeName: 'IfcWall', name: 'Wall A', globalId: '', description: '', objectType: '', score: 1, matchField: 'name' }]}
      query="Wall" highlightIndex={0} modelsCount={1} indexingCount={0}
      onSelect={() => { selections++; }} onHover={() => {}} onOpenAdvanced={() => { advanced++; }} />);
    const result = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(b => b.textContent?.includes('Wall A'))!;
    activate(result, key);
    assert.equal(selections, 1);
    const advancedButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Advanced'))!;
    activate(advancedButton, key);
    assert.equal(advanced, 1);
    mouseDown(result);
    assert.equal(selections, 1, 'pointer down only retains focus');
    click(result, { detail: 1 });
    assert.equal(selections, 2, 'one pointer sequence commits once');
  });

  for (const key of ['Enter', ' '] as const) it(`native ${JSON.stringify(key)} clears real rules and opens the filter tab`, () => {
    seed();
    const ui = render(<SearchInline />);
    act(() => useViewerStore.getState().addFilterRule({ kind: 'ifcType', op: 'in', values: ['IfcWall'] }));
    const clear = ui.querySelector<HTMLButtonElement>('button[aria-label="Clear filters"]')!;
    activate(clear, key);
    assert.equal(useViewerStore.getState().searchFilter.groups.flatMap(g => g.rules).length, 0);
    const advanced = ui.querySelector<HTMLButtonElement>('button[aria-label="Advanced filter"]')!;
    activate(advanced, key);
    assert.equal(useViewerStore.getState().searchModalOpen, true);
    assert.equal(useViewerStore.getState().searchModalTab, 'filter');
  });
});
