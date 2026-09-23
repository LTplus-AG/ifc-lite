/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { AddElementPanel } from './AddElementPanel.js';
import { handleSelectionClick } from './selectionHandlers.js';

const MODEL_ID = 'storeys.ifc';
// Authored by Bonsai/IfcOpenShell, with one source IfcBuildingStorey (#42).
const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);

const original = useViewerStore.getState();

async function editedStoreys() {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, MODEL_ID);
  const editor = new StoreEditor(store, view);
  assert.equal(editor.removeEntity(42), true);
  const created = editor.addEntity('IfcBuildingStorey', [
    '0Storey000000000000003', null, 'New Level', null, null,
    null, null, null, '.ELEMENT.', 3,
  ]);
  const model = fixtureModel(MODEL_ID);
  Object.assign(model, { ifcDataStore: store });
  useViewerStore.setState({
    ...fixtureModels(model),
    ifcDataStore: store,
    mutationViews: new Map([[MODEL_ID, view]]),
    mutationVersion: original.mutationVersion + 1,
    addElementType: 'column',
    addElementModelId: MODEL_ID,
    addElementStoreyId: 42,
    addElementPendingPoints: [],
  });
  return created.expressId;
}

beforeEach(() => {
  useViewerStore.setState({
    models: new Map(), activeModelId: null, ifcDataStore: null,
    mutationViews: new Map(), addElementModelId: null, addElementStoreyId: null,
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({
    models: original.models,
    activeModelId: original.activeModelId,
    ifcDataStore: original.ifcDataStore,
    mutationViews: original.mutationViews,
    mutationVersion: original.mutationVersion,
    addElementType: original.addElementType,
    addElementModelId: original.addElementModelId,
    addElementStoreyId: original.addElementStoreyId,
    addElementPendingPoints: original.addElementPendingPoints,
    addColumn: original.addColumn,
  });
});

describe('Add Element uses live storeys (#5249)', () => {
  it('drops a deleted source storey and offers an overlay-created storey in the panel', async () => {
    await editedStoreys();
    const ui = render(<AddElementPanel onClose={() => undefined} />);
    assert.match(ui.textContent ?? '', /New Level/);
    assert.doesNotMatch(ui.textContent ?? '', /My Storey/);
    assert.equal(useViewerStore.getState().addElementStoreyId, null);
  });

  it('places on the live created storey when a stale deleted selection reaches the click handler', async () => {
    const createdId = await editedStoreys();
    let chosenStorey: number | null = null;
    useViewerStore.setState({
      addColumn: (_modelId, storeyId) => {
        chosenStorey = storeyId;
        return { expressId: 501 };
      },
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const ctx = {
      canvas: document.createElement('canvas'),
      renderer: {
        raycastSceneMagnetic: () => ({
          intersection: { point: { x: 1, y: 0, z: 2 }, expressId: null },
          snapTarget: null,
        }),
      },
      mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
      activeToolRef: { current: 'addElement' },
      edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
      snapEnabledRef: { current: false },
      hiddenEntitiesRef: { current: new Set<number>() },
      isolatedEntitiesRef: { current: null },
    } as unknown as MouseHandlerContext;
    await handleSelectionClick(ctx, { clientX: 0, clientY: 0 } as MouseEvent);
    assert.equal(chosenStorey, createdId);
  });

  it('uses named Name edits and lets a positional null clear that name', async () => {
    const createdId = await editedStoreys();
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view);
    view.setAttribute(createdId, 'Name', 'Renamed Level');
    view.setPositionalAttribute(createdId, 2, null);
    const ui = render(<AddElementPanel onClose={() => undefined} />);
    assert.doesNotMatch(ui.textContent ?? '', /Renamed Level|New Level/);
    assert.match(ui.textContent ?? '', /Storey #/);
  });
});
