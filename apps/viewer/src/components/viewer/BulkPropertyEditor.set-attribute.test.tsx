/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5867: the Bulk editor offered "Set Attribute", but the engine skipped the
 * action for every entity and the dialog reported success with nothing
 * written. Drives the real dialog, reads the attribute back through the
 * model's mutation view, then undoes through the real Ctrl+Z path
 * (`replayWorkspaceHistory`).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels, type FixtureEntity } from '@/test/store-fixture.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

const MODEL_ID = 'model-a';

function seed(entities: FixtureEntity[]): MutablePropertyView {
  const view = new MutablePropertyView(null, MODEL_ID);
  useViewerStore.setState({
    ...fixtureModels(fixtureModel(MODEL_ID, { entities })),
    mutationViews: new Map([[MODEL_ID, view]]),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    collabRole: null,
  });
  return view;
}

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

/** Open the dialog, pick Set Attribute -> `attribute`, type `value`, Execute. */
async function setAttribute(container: HTMLElement, attribute: string, value: string): Promise<void> {
  click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open')!);
  await advance(0);
  await choose('Set Property', 'Set Attribute');
  await choose('Select attribute', attribute);
  const input = [...document.body.querySelectorAll('input')].find((i) => i.placeholder === 'Value') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await advance(250);
  const executeBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply to')) as HTMLButtonElement;
  assert.ok(executeBtn && !executeBtn.disabled, 'Execute must be enabled');
  click(executeBtn);
  await advance(100);
}

const attr = (view: MutablePropertyView, id: number, name: string) =>
  view.getAttributeMutationsForEntity(id).find((a) => a.name === name)?.value;

describe('BulkPropertyEditor — Set Attribute writes (#5867)', () => {
  afterEach(() => { cleanup(); });

  it('Name = "X" over two walls writes both, and one Ctrl+Z restores them', async () => {
    const view = seed([
      { expressId: 1, type: 'IfcWall', name: 'Wall A' },
      { expressId: 2, type: 'IfcWall', name: 'Wall B' },
    ]);
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await setAttribute(container, 'Name', 'X');

    assert.equal(attr(view, 1, 'Name'), 'X');
    assert.equal(attr(view, 2, 'Name'), 'X');
    assert.match(document.body.textContent ?? '', /Applied 2 mutations to 2 entities/);

    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(attr(view, 1, 'Name'), undefined, 'wall #1 reads its parsed Name again');
    assert.equal(attr(view, 2, 'Name'), undefined, 'wall #2 reads its parsed Name again');
    replayWorkspaceHistory(useViewerStore.getState(), 'redo');
    assert.equal(attr(view, 1, 'Name'), 'X');
  });

  it('undoing the run restores an earlier edit of the attribute, not the parsed value', async () => {
    const view = seed([{ expressId: 1, type: 'IfcWall', name: 'Wall A' }]);
    useViewerStore.getState().setAttribute(MODEL_ID, 1, 'Name', 'EARLIER', 'Wall A');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await setAttribute(container, 'Name', 'X');

    assert.equal(attr(view, 1, 'Name'), 'X');
    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(attr(view, 1, 'Name'), 'EARLIER', 'the run is undone back to the earlier edit');
    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(attr(view, 1, 'Name'), 'Wall A', 'the earlier edit is its own step');
  });

  it('an entity whose class lacks the attribute is reported, not counted as success', async () => {
    const view = seed([
      { expressId: 1, type: 'IfcWall', name: 'Wall A' },
      { expressId: 2, type: 'IfcWallType', name: 'Type A' },
    ]);
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    await setAttribute(container, 'ObjectType', 'X');

    assert.equal(attr(view, 1, 'ObjectType'), 'X');
    assert.equal(attr(view, 2, 'ObjectType'), undefined);
    assert.match(document.body.textContent ?? '', /IfcWallType has no ObjectType attribute/);
  });
});
