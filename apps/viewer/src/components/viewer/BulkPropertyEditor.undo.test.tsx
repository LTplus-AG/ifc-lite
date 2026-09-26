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
  useViewerStore.setState({
    ...fixtureModels(
      fixtureModel('model-a', { entities: walls(wallCount) }),
      fixtureModel('model-b', { entities: walls(wallCount), idOffset: 100_000 }),
    ),
    mutationViews: views,
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    collabRole: null,
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
