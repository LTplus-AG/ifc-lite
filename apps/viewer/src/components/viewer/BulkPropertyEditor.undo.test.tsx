/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5958: a Bulk run is one undo step, and Ctrl+Z must reach it.
 *
 * Drives the real dialog (model picker, action form, Execute) and then the
 * real workspace undo (`replayWorkspaceHistory`, what Ctrl+Z and the ribbon
 * Undo call), never `recordMutationBatch` directly: reverting the dialog's
 * recording must turn these red.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels, type FixtureEntity } from '@/test/store-fixture.js';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

const PSET = 'Pset_Test';
const PROP = 'Code';

const walls = (count: number): FixtureEntity[] =>
  Array.from({ length: count }, (_, i) => ({ expressId: i + 1, type: 'IfcWall', name: `Wall ${i + 1}` }));

/** Two loaded models; `model-a` is active. Both overlays exist already. */
function seed(wallCount = 3): Map<string, MutablePropertyView> {
  const views = new Map(['model-a', 'model-b'].map((id) => [id, new MutablePropertyView(null, id)] as const));
  const aModel = fixtureModel('model-a', { entities: walls(wallCount) });
  const bModel = fixtureModel('model-b', { entities: walls(wallCount), idOffset: 100_000 });
  aModel.maxExpressId = wallCount;
  bModel.maxExpressId = wallCount;
  useViewerStore.setState({
    ...fixtureModels(aModel, bModel),
    mutationViews: views,
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    collabRole: null,
    editEnabled: true,
    selectedEntityId: null,
    selectedEntityIds: new Set<number>(),
    searchFilterResult: null,
  });
  return views;
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const input = (placeholder: string) =>
  [...document.body.querySelectorAll('input')].find((i) => i.placeholder === placeholder) as HTMLInputElement | undefined;

/** Open a Radix Select whose trigger shows `current` and choose `option`. */
async function choose(current: string, option: string): Promise<void> {
  const trigger = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent === current);
  assert.ok(trigger, `a Select showing "${current}" must render`);
  click(trigger!);
  await advance(0);
  const item = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === option);
  assert.ok(item, `option "${option}" must render`);
  click(item!);
  await advance(0);
}

async function openDialog(container: HTMLElement): Promise<void> {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
  assert.ok(trigger);
  click(trigger!);
  await advance(0);
}

/** Fill the action form, wait for the match count, Execute, wait for the run. */
async function execute(value: string | null): Promise<void> {
  setNativeValue(input('e.g., Pset_WallCommon')!, PSET);
  setNativeValue(input('e.g., FireRating')!, PROP);
  if (value !== null) setNativeValue(input('Value')!, value);
  await advance(250);
  const executeBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply to'));
  assert.ok(executeBtn, 'Execute must render');
  assert.equal((executeBtn as HTMLButtonElement).disabled, false, 'Execute must be enabled');
  click(executeBtn!);
  await advance(100);
}

const undo = () => replayWorkspaceHistory(useViewerStore.getState(), 'undo');
const redo = () => replayWorkspaceHistory(useViewerStore.getState(), 'redo');

describe('BulkPropertyEditor — the run is one undo step Ctrl+Z can reach (#5958)', () => {
  afterEach(() => { cleanup(); });

  it('a run on a model that is not active is reverted by Ctrl+Z and re-applied by Ctrl+Y', async () => {
    const views = seed();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('model-a', 'model-b');
    await execute('X');

    const b = views.get('model-b')!;
    for (const id of [1, 2, 3]) assert.equal(b.getPropertyValue(id, PSET, PROP), 'X', `wall #${id} written`);

    undo();
    for (const id of [1, 2, 3]) assert.equal(b.getPropertyValue(id, PSET, PROP), null, `wall #${id} reverted by one Ctrl+Z`);
    redo();
    for (const id of [1, 2, 3]) assert.equal(b.getPropertyValue(id, PSET, PROP), 'X', `wall #${id} re-applied by one Ctrl+Y`);
  });

  it('#5890: Selection writes only three picked walls across two models, and one undo restores both', async () => {
    const views = seed();
    useViewerStore.setState({ selectedEntityIds: new Set([1, 100_001, 100_002]), selectedEntityId: 1 });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    const source = [...document.body.querySelectorAll('button[role="combobox"]')]
      .find((button) => button.getAttribute('aria-label') === 'Target source');
    assert.equal(source?.textContent, 'Selection');
    await execute('PICKED');
    const a = views.get('model-a')!;
    const b = views.get('model-b')!;
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'PICKED');
    assert.equal(a.getPropertyValue(2, PSET, PROP), null);
    assert.equal(b.getPropertyValue(1, PSET, PROP), 'PICKED');
    assert.equal(b.getPropertyValue(2, PSET, PROP), 'PICKED');
    assert.equal(b.getPropertyValue(3, PSET, PROP), null);
    undo();
    for (const view of [a, b]) for (const id of [1, 2, 3])
      assert.equal(view.getPropertyValue(id, PSET, PROP), null);
    redo();
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'PICKED');
    assert.equal(b.getPropertyValue(1, PSET, PROP), 'PICKED');
    assert.equal(b.getPropertyValue(2, PSET, PROP), 'PICKED');
  });

  it('#5890: undo reaches the model that changed when the active selection was a no-op', async () => {
    const views = seed();
    useViewerStore.getState().setProperty('model-b', 1, PSET, PROP, 'EXISTING', PropertyValueType.Label);
    useViewerStore.setState({ activeModelId: 'model-a', selectedEntityIds: new Set([1, 100_001]), selectedEntityId: 1 });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('Set Property', 'Delete Property');
    await execute(null);

    assert.equal(views.get('model-a')!.getPropertyValue(1, PSET, PROP), null);
    assert.equal(views.get('model-b')!.getPropertyValue(1, PSET, PROP), null);
    assert.equal(useViewerStore.getState().activeModelId, 'model-b', 'Undo targets the model with a recorded mutation');
    undo();
    assert.equal(views.get('model-b')!.getPropertyValue(1, PSET, PROP), 'EXISTING');
  });

  it('#5898: a chunked Query write does not rediscover rule suggestions per chunk', async () => {
    const views = seed(1001);
    const original = useViewerStore.getState().setFilterSchema;
    let discoveries = 0;
    useViewerStore.setState({ setFilterSchema: (...args) => {
      discoveries++;
      original(...args);
    } });
    try {
      const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
      await openDialog(container);
      setNativeValue(input('e.g., Pset_WallCommon')!, PSET);
      setNativeValue(input('e.g., FireRating')!, PROP);
      setNativeValue(input('Value')!, 'CHUNKED');
      await advance(250);
      const beforeRun = discoveries;
      const apply = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Apply to'));
      assert.ok(apply);
      click(apply!);
      await advance(150);
      assert.equal(views.get('model-a')!.getPropertyValue(1001, PSET, PROP), 'CHUNKED');
      assert.ok(discoveries - beforeRun <= 1, 'schema discovery runs at most once after three write chunks');
    } finally {
      useViewerStore.setState({ setFilterSchema: original });
    }
  });

  it('#5898: Cancel before Query preselection writes nothing and reports cancellation', async () => {
    const views = seed(1001);
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    setNativeValue(input('e.g., Pset_WallCommon')!, PSET);
    setNativeValue(input('e.g., FireRating')!, PROP);
    setNativeValue(input('Value')!, 'NEVER');
    await advance(250);
    const apply = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Apply to'));
    assert.ok(apply);
    click(apply!);
    const cancel = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
    assert.ok(cancel, 'the running Query exposes Cancel during preselection');
    click(cancel!);
    await advance(100);
    assert.equal(views.get('model-a')!.getPropertyValue(1, PSET, PROP), null);
    assert.match(document.body.textContent ?? '', /Cancelled after 0 of 0 entities/);
  });

  it('#5890: Search result targets only the displayed one-model filter rows', async () => {
    const views = seed();
    useViewerStore.setState({
      ...fixtureModels(fixtureModel('model-a', { entities: walls(3) })),
      mutationViews: new Map([['model-a', views.get('model-a')!]]),
      searchModalTab: 'filter',
      searchFilterResult: { columns: ['express_id'], rows: [[1], [3]], runMs: 0 },
    });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('Query', 'Search result');
    await execute('FOUND');
    const a = views.get('model-a')!;
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'FOUND');
    assert.equal(a.getPropertyValue(2, PSET, PROP), null);
    assert.equal(a.getPropertyValue(3, PSET, PROP), 'FOUND');
    undo();
    assert.equal(a.getPropertyValue(1, PSET, PROP), null);
    assert.equal(a.getPropertyValue(3, PSET, PROP), null);
  });

  it('#5890: Search result uses the current text search and ignores other walls', async () => {
    const views = seed();
    useViewerStore.setState({
      ...fixtureModels(fixtureModel('model-a', { entities: walls(3) })),
      mutationViews: new Map([['model-a', views.get('model-a')!]]),
      searchModalTab: 'search',
      searchQuery: 'Wall 2',
      searchIndexes: new Map(),
      searchFieldFilter: 'all',
      searchModelFilter: null,
    });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('Query', 'Search result');
    await execute('TEXT');
    const a = views.get('model-a')!;
    assert.equal(a.getPropertyValue(1, PSET, PROP), null);
    assert.equal(a.getPropertyValue(2, PSET, PROP), 'TEXT');
    assert.equal(a.getPropertyValue(3, PSET, PROP), null);
    undo();
    assert.equal(a.getPropertyValue(2, PSET, PROP), null);
  });

  it('#5890: a closed dialog does not rescan IFC when the Search query changes', async () => {
    seed();
    const indexes = new Map();
    const get = indexes.get.bind(indexes);
    let indexReads = 0;
    indexes.get = (key: string) => { indexReads++; return get(key); };
    useViewerStore.setState({ searchModalTab: 'search', searchQuery: 'Wall', searchIndexes: indexes });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('Query', 'Search result');
    assert.ok(indexReads > 0, 'open Search source consults the IFC search index');

    const close = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Close');
    assert.ok(close);
    click(close!);
    await advance(0);
    indexReads = 0;
    act(() => useViewerStore.setState({ searchQuery: 'Wall 2' }));
    assert.equal(indexReads, 0, 'closed Bulk dialog leaves Search query changes to the Search panel');
  });

  it('the model picker defaults to the active model', async () => {
    seed();
    useViewerStore.setState({ activeModelId: 'model-b' });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    const trigger = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent?.startsWith('model-'));
    assert.equal(trigger?.textContent, 'model-b');
  });

  it('undoing an update restores the previous value, not an empty one', async () => {
    const views = seed();
    const earlier = useViewerStore.getState().setProperty('model-a', 2, PSET, PROP, 'OLD', PropertyValueType.Label);
    assert.ok(earlier);
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await execute('NEW');

    const a = views.get('model-a')!;
    assert.equal(a.getPropertyValue(2, PSET, PROP), 'NEW');
    undo();
    assert.equal(a.getPropertyValue(2, PSET, PROP), 'OLD', 'the run is undone back to the earlier edit');
    assert.equal(a.getPropertyValue(1, PSET, PROP), null);
    undo();
    assert.equal(a.getPropertyValue(2, PSET, PROP), null, 'the earlier edit is its own step');
  });

  it('a Bulk delete is restored by one Ctrl+Z', async () => {
    const views = seed();
    for (const id of [1, 2, 3]) useViewerStore.getState().setProperty('model-a', id, PSET, PROP, `V${id}`, PropertyValueType.Label);
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await choose('Set Property', 'Delete Property');
    await execute(null);

    const a = views.get('model-a')!;
    for (const id of [1, 2, 3]) assert.equal(a.getPropertyValue(id, PSET, PROP), null, `wall #${id} deleted`);
    undo();
    for (const id of [1, 2, 3]) assert.equal(a.getPropertyValue(id, PSET, PROP), `V${id}`, `wall #${id} restored`);
  });

  it('an edit made while the run yields is not clobbered by undoing the run', async () => {
    // 600 walls = two 500-entity chunks with a yield between them.
    const views = seed(600);
    const a = views.get('model-a')!;
    // Another writer (the SDK, a script) edits wall #1, already written by
    // the first chunk, while the run yields before its second chunk.
    const write = a.setProperty.bind(a);
    let injected = false;
    a.setProperty = (...args: Parameters<MutablePropertyView['setProperty']>) => {
      if (!injected && args[0] === 501) {
        injected = true;
        useViewerStore.getState().setProperty('model-a', 1, PSET, PROP, 'SDK', PropertyValueType.Label);
      }
      return write(...args);
    };
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await openDialog(container);
    await execute('X');

    assert.ok(injected, 'fixture sanity: the edit landed mid-run');
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'SDK');
    assert.equal(a.getPropertyValue(600, PSET, PROP), 'X');

    undo();
    assert.equal(a.getPropertyValue(600, PSET, PROP), null, 'the part of the run after the edit is undone');
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'SDK', 'the later edit survives');
    undo();
    assert.equal(a.getPropertyValue(1, PSET, PROP), 'X', 'then the edit itself');
    undo();
    assert.equal(a.getPropertyValue(1, PSET, PROP), null, 'then the part of the run before it');
    assert.equal(useViewerStore.getState().undoStacks.get('model-a')!.length, 0);
  });
});
