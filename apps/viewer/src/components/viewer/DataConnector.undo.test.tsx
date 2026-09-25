/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5958: a CSV import is one undo step, and Ctrl+Z must reach it even when
 * the dialog's target model is not the active one. Drives the real upload
 * -> Import flow, then the real workspace undo (`replayWorkspaceHistory`).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { DataConnector } from './DataConnector.js';

const GUIDS = ['2O2Fr$t4X7Zf8NOew3FLOH', '2O2Fr$t4X7Zf8NOew3FLOI'];

function seed(entities = GUIDS.map((globalId, i) => ({ expressId: 40 + i, type: 'IfcWall', name: `Wall ${i}`, globalId }))): Map<string, MutablePropertyView> {
  const views = new Map(['model-a', 'model-b'].map((id) => [id, new MutablePropertyView(null, id)] as const));
  useViewerStore.setState({
    ...fixtureModels(
      fixtureModel('model-a', { entities }),
      fixtureModel('model-b', { entities, idOffset: 100_000 }),
    ),
    mutationViews: views,
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    georefMutations: new Map(),
    scheduleData: null,
    scheduleIsEdited: false,
    scheduleSourceModelId: null,
    collabRole: null,
  });
  return views;
}

async function openDialog(container: HTMLElement): Promise<void> {
  click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open')!);
  await advance(0);
}

async function runImport(): Promise<void> {
  const importBtn = [...document.body.querySelectorAll('button')].find((b) => /^Import( \d+ rows?)?$/.test(b.textContent?.trim() ?? ''));
  assert.ok(importBtn && !importBtn.disabled, 'Import must be enabled');
  click(importBtn!);
  await advance(200);
}

async function uploadCsv(text: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'the CSV file input must render in the open dialog');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'data.csv', { type: 'text/csv' })] });
  act(() => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await advance(50);
}

describe('DataConnector — a CSV import is one undo step Ctrl+Z can reach (#5958)', () => {
  afterEach(() => { cleanup(); });

  it('an import into a model that is not active is reverted by Ctrl+Z', async () => {
    const views = seed();
    const container = render(<DataConnector trigger={<button>Open</button>} />);
    await openDialog(container);

    const picker = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent === 'model-a');
    assert.ok(picker, 'the target-model picker shows the active model');
    click(picker!);
    await advance(0);
    click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'model-b')!);
    await advance(0);

    await uploadCsv(`GlobalId,FireRating\n${GUIDS[0]},REI60\n${GUIDS[1]},REI90\n`);
    await runImport();

    const b = views.get('model-b')!;
    assert.equal(b.getModifiedEntityCount(), 2, 'fixture sanity: the import wrote both walls');

    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(b.getModifiedEntityCount(), 0, 'one Ctrl+Z reverts the whole import');
    replayWorkspaceHistory(useViewerStore.getState(), 'redo');
    assert.equal(b.getModifiedEntityCount(), 2, 'one Ctrl+Y re-applies it');
  });

  it('the target-model picker defaults to the active model', async () => {
    seed();
    useViewerStore.setState({ activeModelId: 'model-b' });
    const container = render(<DataConnector trigger={<button>Open</button>} />);
    await openDialog(container);
    const picker = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent?.startsWith('model-'));
    assert.equal(picker?.textContent, 'model-b');
  });

  it('an edit made while the import yields is not clobbered by undoing the import', async () => {
    // 250 rows = two 200-row apply batches with a yield between them.
    const guid = (i: number) => `2O2Fr$t4X7Zf8NOew${String(i).padStart(5, '0')}`;
    const rows = Array.from({ length: 250 }, (_, i) => ({ expressId: i + 1, type: 'IfcWall', name: `Wall ${i + 1}`, globalId: guid(i + 1) }));
    const a = seed(rows).get('model-a')!;
    // Another writer edits the first imported wall while the import yields
    // before its second batch.
    const write = a.setProperty.bind(a);
    let target: { pset: string; prop: string } | null = null;
    a.setProperty = (...args: Parameters<MutablePropertyView['setProperty']>) => {
      target ??= { pset: args[1], prop: args[2] };
      if (args[0] === 201 && a.getPropertyValue(1, target.pset, target.prop) !== 'SDK') {
        useViewerStore.getState().setProperty('model-a', 1, target.pset, target.prop, 'SDK', PropertyValueType.Label);
      }
      return write(...args);
    };
    const container = render(<DataConnector trigger={<button>Open</button>} />);
    await openDialog(container);
    await uploadCsv(['GlobalId,FireRating', ...rows.map((r) => `${r.globalId},REI${r.expressId}`)].join('\n'));
    await runImport();

    assert.ok(target, 'fixture sanity: the import wrote');
    const { pset, prop } = target!;
    assert.equal(a.getPropertyValue(1, pset, prop), 'SDK', 'fixture sanity: the edit landed mid-import');
    assert.equal(a.getPropertyValue(250, pset, prop), 'REI250');

    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(a.getPropertyValue(250, pset, prop), null, 'the part of the import after the edit is undone');
    assert.equal(a.getPropertyValue(1, pset, prop), 'SDK', 'the later edit survives');
    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(a.getPropertyValue(1, pset, prop), 'REI1', 'then the edit itself');
    replayWorkspaceHistory(useViewerStore.getState(), 'undo');
    assert.equal(a.getPropertyValue(1, pset, prop), null, 'then the part of the import before it');
  });
});
