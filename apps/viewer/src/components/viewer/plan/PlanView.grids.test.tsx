/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: actual authored axes and AxisTags reach the mounted plan, including
 * a grid outside the imported building's bounds and overlapping federated ids. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { render, advance, cleanup } from '@/test/render';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { toHostHiddenIfcTypes } from '@/lib/host-hidden-ifc-types';
import { PlanView } from './PlanView';

const MODEL = 'bonsai', STOREY = 42;

async function fixture(count: 1 | 2) {
  await seedModelingSession(); // reset the shared session/undo state
  const source = readFileSync(new URL('../../../../public/samples/hello-wall.ifc', import.meta.url));
  const models = new Map(useViewerStore.getState().models);
  models.clear();
  const views = new Map<string, MutablePropertyView>();
  for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
    const bytes = new Uint8Array(source).buffer;
    const parsed = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
    assert.ok(parsed.entityIndex.byType.get('IFCBUILDINGSTOREY')?.includes(STOREY));
    const model = { ...fixtureModel(id, { idOffset: i === 0 ? 0 : 1_000_000 }),
      ifcDataStore: parsed, geometryResult: useViewerStore.getState().geometryResult };
    models.set(id, model);
    views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
  }
  const state = useViewerStore.getState();
  useViewerStore.setState({ models, activeModelId: MODEL, mutationViews: views,
    storeEditors: new Map(), modelPlacement: emptyPlacementState(), hostHiddenIfcTypes: null,
    typeVisibility: { ...state.typeVisibility, ifcGrid: true },
    hiddenEntities: new Set(), selectedEntityId: null, selectedEntityIds: new Set() });
  // Same source express ids in both models. The peer's tags and far-away grid
  // must never leak into the active plan's local frame.
  if (count === 2) {
    const peer = addGridIn(useViewerStore, 'peer', STOREY, {
      Position: [-50, -80, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4],
        UTags: ['peer-1', 'peer-2'], VTags: ['peer-A', 'peer-B'] }),
    });
    assert.ok('expressId' in peer);
  }
  const made = addGridIn(useViewerStore, MODEL, STOREY, {
    Position: [100, 200, 0], Direction: Math.PI / 2,
    ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }), Name: 'Authored design grid',
  });
  assert.ok('expressId' in made);
  assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: MODEL, storeyId: STOREY }));
  const ui = render(<PlanView layout="split" />);
  await advance(450);
  return { ui, made };
}

const lines = (ui: HTMLElement) => [...ui.querySelectorAll('[data-plan-layer="design-grids"] line')];
const tags = (ui: HTMLElement) => [...new Set([...ui.querySelectorAll('[data-plan-layer="design-grids"] text')]
  .map((text) => text.textContent))].sort();

afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  useViewerStore.setState({ hostHiddenIfcTypes: null });
});

for (const count of [1, 2] as const) describe(`#6232 authored plan grid with ${count} real Bonsai models`, () => {
  it('draws the actual four turned axes and exact AxisTags, fitting the distant grid', async () => {
    const { ui } = await fixture(count);
    assert.equal(lines(ui).length, 4);
    assert.deepEqual(tags(ui), ['1', '2', 'A', 'B']);
    // Fit includes the grid at (100,200), well outside the imported wall.
    for (const line of lines(ui)) for (const [name, limit] of [['x1', 1280], ['x2', 1280], ['y1', 800], ['y2', 800]] as const) {
      const value = Number(line.getAttribute(name));
      assert.ok(value >= 0 && value <= limit, `${name}=${value} stays on the plan canvas`);
    }
    const directions = lines(ui).map((line) => [
      Number(line.getAttribute('x2')) - Number(line.getAttribute('x1')),
      Number(line.getAttribute('y2')) - Number(line.getAttribute('y1')),
    ]);
    assert.equal(directions.filter(([x, y]) => Math.abs(x) < 1e-6 && y < 0).length, 2, 'turned V axes run screen-up');
    assert.equal(directions.filter(([x, y]) => x < 0 && Math.abs(y) < 1e-6).length, 2, 'turned U axes run screen-left');
  });

  it('removes and restores the authored grid and tags through one undo and redo', async () => {
    const { ui } = await fixture(count);
    assert.equal(lines(ui).length, 4);
    act(() => useViewerStore.getState().undo(MODEL));
    await advance(200);
    assert.equal(lines(ui).length, 0);
    assert.deepEqual(tags(ui), []);
    act(() => useViewerStore.getState().redo(MODEL));
    await advance(200);
    assert.equal(lines(ui).length, 4);
    assert.deepEqual(tags(ui), ['1', '2', 'A', 'B']);
  });

  it('obeys the shared grid type and embedding-host visibility gates', async () => {
    const { ui } = await fixture(count);
    assert.equal(lines(ui).length, 4);
    act(() => useViewerStore.setState((s) => ({ typeVisibility: { ...s.typeVisibility, ifcGrid: false } })));
    await advance(20);
    assert.equal(lines(ui).length, 0);
    act(() => useViewerStore.setState((s) => ({ typeVisibility: { ...s.typeVisibility, ifcGrid: true },
      hostHiddenIfcTypes: toHostHiddenIfcTypes(['IfcGrid']) })));
    await advance(20);
    assert.equal(lines(ui).length, 0, 'a host-hidden grid stays hidden when its toggle is on');
    act(() => useViewerStore.setState({ hostHiddenIfcTypes: null }));
    await advance(20);
    assert.equal(lines(ui).length, 4);
  });
});
