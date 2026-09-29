/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6368: a group / schedule row's explicit Isolate and X-ray context actions.
 * They write the shared isolate / ghost channels with an ownership claim
 * (`listVisibilityOwned`, `lib/visibility/ownership.ts`), release only what
 * the list installed, and the table's "Visible only" filter ignores the list's
 * own isolation (but not anybody else's).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectUnits } from '@ifc-lite/parser';
import type { ListGrouping, ListResult } from '@ifc-lite/lists';
import { installLayout } from '@/test/dom-layout.js';
import { advance, cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { invalidateVisibleBasketCache } from '@/store/basketVisibleSet';
import { installIdsFocusVisibility } from '@/hooks/ids-focus-visibility';
import { ListResultsTable } from './ListResultsTable.js';

const OFFSET_B = 1_000_000;
const result: ListResult = {
  columns: [
    { id: 'storey', source: 'attribute', propertyName: 'Storey', label: 'Storey' },
    { id: 'type', source: 'attribute', propertyName: 'Type', label: 'Type' },
    { id: 'name', source: 'attribute', propertyName: 'Name', label: 'Name' },
  ],
  rows: [
    { entityId: 11, modelId: 'a', values: ['EG', 'Wall', 'Wall A1'] },
    { entityId: 12, modelId: 'a', values: ['EG', 'Wall', 'Wall A2'] },
    { entityId: 11, modelId: 'b', values: ['EG', 'Door', 'Door B1'] },
    { entityId: 21, modelId: 'b', values: ['OG', 'Wall', 'Wall B2'] },
  ],
  totalCount: 4,
  executionTime: 1,
};
const byType: ListGrouping = { columnId: 'type', columnIds: ['type'], sumColumnIds: [], view: 'nested' };
const schedule: ListGrouping = { columnId: 'storey', columnIds: ['storey', 'type'], sumColumnIds: [], view: 'schedule' };
const modelUnits = new Map([['a', ProjectUnits.empty()], ['b', ProjectUnits.empty()]]);

const WALLS = new Set([11, 12, 21 + OFFSET_B]);
const DOOR = new Set([11 + OFFSET_B]);

/** A federated model with renderable meshes, so "Visible only" has geometry to test. */
function modelWithMeshes(id: string, idOffset: number, localIds: number[], ifcType: string): FederatedModel {
  const base = fixtureModel(id, { idOffset });
  return {
    ...base,
    maxExpressId: 100,
    geometryResult: { meshes: localIds.map((local) => ({ expressId: local + idOffset, ifcType })) },
  } as unknown as FederatedModel;
}

let restoreLayout: () => void;
let initialState: ReturnType<typeof useViewerStore.getState>;

beforeEach(() => {
  initialState = useViewerStore.getState();
  restoreLayout = installLayout();
  invalidateVisibleBasketCache();
  useViewerStore.setState(fixtureModels(
    modelWithMeshes('a', 0, [11, 12], 'IfcWall'),
    modelWithMeshes('b', OFFSET_B, [11, 21], 'IfcWall'),
  ));
});
afterEach(() => {
  cleanup();
  restoreLayout();
  useViewerStore.setState(initialState, true);
});

async function mount(grouping: ListGrouping, { visibleOnly = false } = {}): Promise<HTMLElement> {
  const ui = render(<ListResultsTable result={result} grouping={grouping} modelUnits={modelUnits} />);
  if (!visibleOnly) click(ui.querySelector('button[aria-label="Showing visible objects only"]')!);
  await advance(5);
  return ui;
}

function action(ui: HTMLElement, label: string): HTMLButtonElement {
  const button = ui.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `the "${label}" action must be rendered`);
  return button;
}

/** The member-row buttons currently rendered (a leaf row names its element). */
function renderedRowNames(ui: HTMLElement): string[] {
  return [...ui.querySelectorAll<HTMLButtonElement>('button.absolute[aria-pressed]')]
    .map((b) => b.textContent ?? '')
    .filter((text) => /(Wall|Door) [AB]\d/.test(text))
    .map((text) => text.match(/(Wall|Door) [AB]\d/)![0])
    .sort();
}

const state = () => useViewerStore.getState();

describe('#6368 Isolate / X-ray context row actions', () => {
  it('Isolate on a group isolates its federated members and records the claim, without selecting', async () => {
    const ui = await mount(byType);
    click(action(ui, 'Isolate: Wall'));

    assert.deepEqual(state().isolatedEntities, WALLS);
    assert.equal(state().ghostExceptEntities, null);
    assert.deepEqual(state().listVisibilityOwned, { channel: 'isolate', ids: WALLS });
    assert.equal(action(ui, 'Isolate: Wall').getAttribute('aria-pressed'), 'true');
    assert.equal(action(ui, 'Isolate: Door').getAttribute('aria-pressed'), 'false');
    assert.equal(state().selectedEntityIds.size, 0, 'an action presents; it does not select');
  });

  it('X-ray context on a schedule row ghosts everything but its members', async () => {
    const ui = await mount(schedule);
    click(action(ui, 'X-ray context: EG / Door'));

    assert.deepEqual(state().ghostExceptEntities, DOOR);
    assert.equal(state().isolatedEntities, null);
    assert.deepEqual(state().listVisibilityOwned, { channel: 'ghost', ids: DOOR });
    assert.equal(action(ui, 'X-ray context: EG / Door').getAttribute('aria-pressed'), 'true');
  });

  it('switching Isolate to X-ray replaces the claim, and running the shown action again releases it', async () => {
    const ui = await mount(byType);
    click(action(ui, 'Isolate: Wall'));
    click(action(ui, 'X-ray context: Wall'));
    assert.equal(state().isolatedEntities, null, 'the list released its own isolation');
    assert.deepEqual(state().ghostExceptEntities, WALLS);

    click(action(ui, 'X-ray context: Wall'));
    assert.equal(state().ghostExceptEntities, null);
    assert.equal(state().listVisibilityOwned, null);
    assert.equal(action(ui, 'X-ray context: Wall').getAttribute('aria-pressed'), 'false');
  });

  it('closing the list releases its own isolation', async () => {
    const ui = await mount(byType);
    click(action(ui, 'Isolate: Door'));
    assert.deepEqual(state().isolatedEntities, DOOR);
    cleanup();
    assert.equal(state().isolatedEntities, null);
    assert.equal(state().listVisibilityOwned, null);
  });

  it('never releases a presentation another feature installed over the list', async () => {
    const ui = await mount(byType);
    click(action(ui, 'Isolate: Wall'));
    // Another owner (IDS focus) takes the channel, even with EQUAL content.
    installIdsFocusVisibility('isolate', new Set(WALLS));
    assert.equal(state().listVisibilityOwned, null, 'the hand-off drops the list claim');
    await advance(1);
    assert.equal(action(ui, 'Isolate: Wall').getAttribute('aria-pressed'), 'false');

    cleanup();
    assert.deepEqual(state().isolatedEntities, WALLS, 'IDS isolation survives the list closing');
  });

  it('a user isolation over the list claim invalidates it', async () => {
    const ui = await mount(byType);
    click(action(ui, 'Isolate: Wall'));
    useViewerStore.setState({ isolatedEntities: new Set(DOOR) });
    assert.equal(state().listVisibilityOwned, null);
    cleanup();
    assert.deepEqual(state().isolatedEntities, DOOR);
  });
});

describe('#6368 "Visible only" ignores the list\'s own isolation', () => {
  it('the table does not collapse to the group the list isolated', async () => {
    const ui = await mount(byType, { visibleOnly: true });
    click(ui.querySelector<HTMLButtonElement>('button[aria-label="Expand Wall"]')!);
    click(ui.querySelector<HTMLButtonElement>('button[aria-label="Expand Door"]')!);
    assert.deepEqual(renderedRowNames(ui), ['Door B1', 'Wall A1', 'Wall A2', 'Wall B2']);

    click(action(ui, 'Isolate: Door'));
    await advance(1);
    assert.deepEqual(state().isolatedEntities, DOOR);
    assert.deepEqual(renderedRowNames(ui), ['Door B1', 'Wall A1', 'Wall A2', 'Wall B2']);
  });

  it('an isolation the list does not own still filters', async () => {
    const ui = await mount(byType, { visibleOnly: true });
    useViewerStore.setState({ isolatedEntities: new Set(DOOR) });
    await advance(1);
    click(ui.querySelector<HTMLButtonElement>('button[aria-label="Expand Door"]')!);
    assert.equal(ui.querySelector('button[aria-label="Expand Wall"]'), null, 'the Wall group is filtered out');
    assert.deepEqual(renderedRowNames(ui), ['Door B1']);
  });
});
