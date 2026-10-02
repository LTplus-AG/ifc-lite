/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: actual authored axes and AxisTags reach the mounted plan, including
 * a grid outside the imported building's bounds and overlapping federated ids. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { advance, cleanup } from '@/test/render';
import { toHostHiddenIfcTypes } from '@/lib/host-hidden-ifc-types';
import '@/lib/commands/modeling/builtin';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { fixture, MODEL } from '@/test/bonsai-plan-grid-fixture';

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
      hostHiddenIfcTypes: toHostHiddenIfcTypes(['IfcGridAxis']) })));
    await advance(20);
    assert.equal(lines(ui).length, 0, 'a host-hidden grid stays hidden when its toggle is on');
    act(() => useViewerStore.setState({ hostHiddenIfcTypes: null }));
    await advance(20);
    assert.equal(lines(ui).length, 4);
  });

  it('keeps file axes and AxisTags after actual export and reparse in a millimetre, turned storey', async () => {
    const { ui } = await fixture(count, { millimetres: true, rotatedStorey: true, reload: true });
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().length, 0, 'the reloaded grid is source data');
    assert.equal(lines(ui).length, 4);
    assert.deepEqual(tags(ui), ['1', '2', 'A', 'B']);
    const vertical = lines(ui).filter((line) => Math.abs(Number(line.getAttribute('x2')) - Number(line.getAttribute('x1'))) < 1e-6);
    const horizontal = lines(ui).filter((line) => Math.abs(Number(line.getAttribute('y2')) - Number(line.getAttribute('y1'))) < 1e-6);
    assert.equal(vertical.length, 2);
    assert.equal(horizontal.length, 2);
    // Native millimetres must become the same 8 m / 6 m axis spans; the
    // translated/turned parent frame cancels in this storey-local drawing.
    const v = vertical[0], h = horizontal[0];
    const lengths = [Math.abs(Number(v.getAttribute('y2')) - Number(v.getAttribute('y1'))),
      Math.abs(Number(h.getAttribute('x2')) - Number(h.getAttribute('x1')))];
    assert.ok(Math.abs(lengths[0] / lengths[1] - 8 / 6) < 1e-6, 'the independently specified rectangular spans retain their metre ratio');
  });

  it('applies model-qualified grid/axis entity hides and model visibility without hiding the peer model', async () => {
    const { ui, made } = await fixture(count);
    const state = useViewerStore.getState();
    const gridId = toGlobalIdFromModels(state.models, MODEL, made.expressId);
    const axisId = toGlobalIdFromModels(state.models, MODEL, made.build.uAxisIds[0]);
    if (count === 2) {
      const peerGrid = state.mutationViews.get('peer')!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCGRID')!;
      assert.equal(peerGrid.expressId, made.expressId, 'the independently authored grids have overlapping model-local ids');
      act(() => useViewerStore.setState({ hiddenEntities: new Set([toGlobalIdFromModels(state.models, 'peer', peerGrid.expressId)]) }));
      await advance(20);
      assert.equal(lines(ui).length, 4, 'the same express id in a different model does not hide the active grid');
    }
    act(() => useViewerStore.setState({ hiddenEntities: new Set([axisId]) }));
    await advance(20);
    assert.equal(lines(ui).length, 3);
    assert.deepEqual(tags(ui), ['2', 'A', 'B']);
    act(() => useViewerStore.setState({ hiddenEntities: new Set([gridId]) }));
    await advance(20);
    assert.equal(lines(ui).length, 0);
    act(() => useViewerStore.setState({ hiddenEntities: new Set() }));
    await advance(20);
    assert.equal(lines(ui).length, 4);
    act(() => useViewerStore.getState().setModelVisibility(MODEL, false));
    await advance(20);
    assert.equal(lines(ui).length, 0);
    act(() => useViewerStore.getState().setModelVisibility(MODEL, true));
    await advance(20);
    assert.equal(lines(ui).length, 4);
  });

  it('fits the full grid tag bubbles instead of clipping long AxisTags at the canvas edge', async () => {
    const { ui } = await fixture(count, { UTags: ['Structural axis number 01', 'Structural axis number 02'] });
    assert.equal(lines(ui).length, 4);
    assert.deepEqual(tags(ui), ['A', 'B', 'Structural axis number 01', 'Structural axis number 02']);
    for (const bubble of ui.querySelectorAll('[data-plan-layer="design-grids"] circle')) {
      const [x, y, r] = ['cx', 'cy', 'r'].map((name) => Number(bubble.getAttribute(name)));
      assert.ok(x - r >= 0 && x + r <= 1280 && y - r >= 0 && y + r <= 800, `complete label bubble (${x},${y}), r=${r} stays on canvas`);
    }
  });

  it('a real plan click on the reloaded millimetre grid creates the column at the independently calculated storey point', async () => {
    const { ui } = await fixture(count, { millimetres: true, rotatedStorey: true, reload: true });
    const lineFor = (AxisTag: string) => lines(ui).find((line) => line.parentElement?.querySelector('text')?.textContent === AxisTag)!;
    const x = Number(lineFor('B').getAttribute('x1'));
    const y = Number(lineFor('2').getAttribute('y1'));
    const svg = ui.querySelector('[data-plan-canvas]')!;
    const restoreRemesh = setRequestRemesh(() => {}); // This test observes the real IFC commit, not async mesh upload.
    try {
      act(() => {
        useViewerStore.setState({ snapEnabled: false });
        useViewerStore.getState().startCommand('column.place');
        for (const type of ['pointerdown', 'pointerup']) svg.dispatchEvent(new window.PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1,
        }));
      });
      const state = useViewerStore.getState();
      const column = state.mutationViews.get(MODEL)!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCCOLUMN')!;
      assert.ok(column, 'the mounted pointer path committed an IFC column');
      // Grid-local (6,4), turned 90 degrees at (100,200), is storey (96,206).
      // Absolute coordinates catch a missed native-unit conversion; a ratio alone cannot.
      assert.deepEqual(state.readEntityPosition(MODEL, column.expressId)!.map((v) => +v.toFixed(6)), [96, 206, 0]);
      act(() => useViewerStore.getState().undo(MODEL));
      assert.ok(useViewerStore.getState().mutationViews.get(MODEL)!.isDeleted(column.expressId));
      act(() => useViewerStore.getState().redo(MODEL));
      assert.deepEqual(useViewerStore.getState().readEntityPosition(MODEL, column.expressId)!.map((v) => +v.toFixed(6)), [96, 206, 0]);
    } finally {
      restoreRemesh();
    }
  });
});
