/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6368: a group in the Lists results selects its members — the nested tree's
 * group label (a parent selects every descendant) and the schedule's rows —
 * across a federation, with Ctrl/Shift as in the Hierarchy panel, and a plain
 * click never isolates or X-rays.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { act } from 'react';
import { ProjectUnits } from '@ifc-lite/parser';
import type { ListGrouping, ListResult } from '@ifc-lite/lists';
import { installLayout } from '@/test/dom-layout.js';
import { activate, advance, cleanup, click, press, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { entityRefToString, useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { ListResultsTable } from './ListResultsTable.js';

// Two federated models whose local express ids collide; only the global id
// (local + idOffset) tells them apart.
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
const byStoreyType: ListGrouping = { columnId: 'storey', columnIds: ['storey', 'type'], sumColumnIds: [], view: 'nested' };
const modelUnits = new Map([['a', ProjectUnits.empty()], ['b', ProjectUnits.empty()]]);

const WALLS_A = [11, 12];
const DOOR_B = [11 + OFFSET_B];
const WALL_B2 = [21 + OFFSET_B];

let restoreLayout: () => void;
let initialState: ReturnType<typeof useViewerStore.getState>;

beforeEach(() => {
  initialState = useViewerStore.getState();
  restoreLayout = installLayout();
  useViewerStore.setState(fixtureModels(fixtureModel('a'), fixtureModel('b', { idOffset: OFFSET_B })));
});
afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  restoreLayout();
  useViewerStore.setState(initialState, true);
});

async function mount(grouping: ListGrouping): Promise<HTMLElement> {
  const ui = render(<ListResultsTable result={result} grouping={grouping} modelUnits={modelUnits} />);
  // No geometry is loaded, so "visible only" would hide every row.
  click(ui.querySelector('button[aria-label="Showing visible objects only"]')!);
  await advance(5);
  return ui;
}

/** The first select control (group label, member row or schedule row) whose
 *  text starts with `label` — or, with `anywhere`, merely contains it. */
function selectButton(ui: HTMLElement, label: string, anywhere = false): HTMLButtonElement {
  const button = [...ui.querySelectorAll<HTMLButtonElement>('button[aria-pressed]:not([aria-label])')]
    .find((b) => (anywhere ? b.textContent?.includes(label) : b.textContent?.startsWith(label)));
  assert.ok(button, `a select button for "${label}" must be rendered`);
  return button;
}

function selectedIds(): number[] {
  return [...useViewerStore.getState().selectedEntityIds].sort((x, y) => x - y);
}

describe('#6368 nested tree: clicking a group label selects its members', () => {
  it('selects every member across federated models, and marks the label pressed', async () => {
    const ui = await mount(byType);
    const walls = selectButton(ui, 'Wall');
    assert.equal(walls.getAttribute('aria-pressed'), 'false');

    click(walls);

    assert.deepEqual(selectedIds(), [...WALLS_A, ...WALL_B2]);
    const refs = useViewerStore.getState().selectedEntitiesSet;
    for (const ref of [{ modelId: 'a', expressId: 11 }, { modelId: 'a', expressId: 12 }, { modelId: 'b', expressId: 21 }]) {
      assert.ok(refs.has(entityRefToString(ref)), `model-aware channel must hold ${entityRefToString(ref)}`);
    }
    assert.equal(selectButton(ui, 'Wall').getAttribute('aria-pressed'), 'true');
    // Selection never isolates or X-rays.
    assert.equal(useViewerStore.getState().isolatedEntities, null);
    assert.equal(useViewerStore.getState().ghostExceptEntities, null);
  });

  it('the chevron still expands and collapses without changing the selection', async () => {
    const ui = await mount(byType);
    const chevron = ui.querySelector<HTMLButtonElement>('button[aria-label="Expand Wall"]');
    assert.ok(chevron);
    click(chevron);
    assert.equal(ui.querySelector('button[aria-label="Collapse Wall"]')?.getAttribute('aria-expanded'), 'true');
    assert.ok(ui.textContent?.includes('Wall A1'), 'expanding shows the members');
    assert.deepEqual(selectedIds(), []);
  });

  it('Ctrl adds a group and toggles it back off; Shift selects the range', async () => {
    const ui = await mount(byType);
    click(selectButton(ui, 'Wall'));
    click(selectButton(ui, 'Door'), { ctrlKey: true });
    assert.deepEqual(selectedIds(), [...WALLS_A, ...WALL_B2, ...DOOR_B].sort((x, y) => x - y));

    click(selectButton(ui, 'Door'), { ctrlKey: true });
    assert.deepEqual(selectedIds(), [...WALLS_A, ...WALL_B2]);

    click(selectButton(ui, 'Door'));
    click(selectButton(ui, 'Wall'), { shiftKey: true });
    assert.deepEqual(selectedIds(), [...WALLS_A, ...WALL_B2, ...DOOR_B].sort((x, y) => x - y));
  });

  it('a parent group selects all its descendants', async () => {
    const ui = await mount(byStoreyType);
    click(selectButton(ui, 'EG'));
    assert.deepEqual(selectedIds(), [...WALLS_A, ...DOOR_B]);
    assert.equal(selectButton(ui, 'EG').getAttribute('aria-pressed'), 'true');
    assert.equal(selectButton(ui, 'OG').getAttribute('aria-pressed'), 'false');
  });

  it('works from the keyboard, modifiers included', async () => {
    const ui = await mount(byType);
    activate(selectButton(ui, 'Door'), 'Enter');
    assert.deepEqual(selectedIds(), DOOR_B);
    press(selectButton(ui, 'Wall'), ' ', { ctrlKey: true });
    assert.deepEqual(selectedIds(), [...WALLS_A, ...WALL_B2, ...DOOR_B].sort((x, y) => x - y));
  });

  it('a member row still selects just itself', async () => {
    const ui = await mount(byType);
    click(ui.querySelector<HTMLButtonElement>('button[aria-label="Expand Wall"]')!);
    click(selectButton(ui, 'Wall B2', true));
    assert.deepEqual(selectedIds(), WALL_B2);
    assert.equal(selectButton(ui, 'Wall B2', true).getAttribute('aria-pressed'), 'true');
    assert.equal(selectButton(ui, 'Wall').getAttribute('aria-pressed'), 'false');
  });
});

describe('#6368 schedule rows are real buttons that select their tuple', () => {
  it('Enter selects a row, aria-pressed reflects it, Ctrl+click adds another', async () => {
    const ui = await mount({ ...byStoreyType, view: 'schedule' });
    const rows = [...ui.querySelectorAll<HTMLButtonElement>('button[aria-pressed]:not([aria-label])')];
    assert.equal(rows.length, 3, 'one button per group-value tuple');
    const egWall = rows.find((b) => b.textContent?.startsWith('EGWall'));
    const egDoor = rows.find((b) => b.textContent?.includes('Door'));
    assert.ok(egWall && egDoor);
    assert.equal(egWall.type, 'button');

    activate(egWall, 'Enter');
    assert.deepEqual(selectedIds(), WALLS_A);
    assert.equal(egWall.getAttribute('aria-pressed'), 'true');
    assert.equal(egDoor.getAttribute('aria-pressed'), 'false');

    click(egDoor, { ctrlKey: true });
    assert.deepEqual(selectedIds(), [...WALLS_A, ...DOOR_B]);
    assert.equal(egDoor.getAttribute('aria-pressed'), 'true');
    assert.equal(useViewerStore.getState().isolatedEntities, null);
  });
});

for (const federated of [false, true]) {
  it(`#11154 selects visible flat and GPU-instanced schedule members (${federated ? 'federated' : 'single model'})`, async () => {
    const modelId = federated ? 'b' : 'legacy';
    const offset = federated ? OFFSET_B : 0;
    const zero = { x: 0, y: 0, z: 0 };
    const bounds = { min: zero, max: zero };
    const geometryResult: GeometryResult = {
      meshes: [{ expressId: offset + 11, ifcType: 'IfcWall', color: [1, 1, 1, 1],
        positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }],
      coordinateInfo: { originShift: zero, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false },
      totalTriangles: 0,
      totalVertices: 0,
    };
    const model = { ...fixtureModel(modelId, { idOffset: offset }), geometryResult, maxExpressId: 13 };
    useViewerStore.setState({
      ...(federated ? fixtureModels({ ...fixtureModel('a'), maxExpressId: 20 }, model) : fixtureModels()),
      ifcDataStore: federated ? null : model.ifcDataStore,
      geometryResult: federated ? null : geometryResult,
      hiddenEntities: new Set([offset + 13]),
      typeViewMode: 'model',
      hasTypeGeometry: true,
    });
    const instances = new Set<number>();
    let onGeometryChange: (() => void) | undefined;
    const scene = {
      getInstancedEntityIds: () => instances.values(),
      getInstancedEntityCount: () => instances.size,
      onGeometryChange: (listener: () => void) => {
        onGeometryChange = listener;
        return () => { onGeometryChange = undefined; };
      },
    };
    setGlobalRendererRef({ current: { getScene: () => scene, getPickGeometryRevision: () => instances.size } as unknown as Renderer });
    const matching: ListResult = {
      ...result,
      totalCount: 3,
      rows: [11, 12, 13].map((entityId) => ({ modelId, entityId, values: ['EG', 'Wall', 'Wall'] })),
    };
    const ui = render(<ListResultsTable result={matching} grouping={{ ...byType, view: 'schedule' }} modelUnits={modelUnits} />);
    await advance(5);

    // A cache hit can publish flat meshes before the renderer receives instances.
    click(selectButton(ui, 'Wall'));
    assert.deepEqual(selectedIds(), [offset + 11]);
    act(() => {
      instances.add(offset + 12);
      instances.add(offset + 13);
      onGeometryChange?.();
    });

    click(selectButton(ui, 'Wall'));

    assert.deepEqual(selectedIds(), [offset + 11, offset + 12]);
    assert.deepEqual(useViewerStore.getState().selectedEntitiesSet, new Set([11, 12].map((expressId) => entityRefToString({ modelId, expressId }))));

    act(() => useViewerStore.setState({ typeViewMode: 'types' }));
    click(selectButton(ui, 'Wall'));
    assert.deepEqual(selectedIds(), [offset + 11]);
  });
}
