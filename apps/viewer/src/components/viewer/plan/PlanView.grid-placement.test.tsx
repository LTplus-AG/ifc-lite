/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: a real grid snap must retain an IFC grid binding, and existing
 * grid-relative products must never present child-local zero as storey position. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { addColumnToStore, gridIntersectionPlacement, rectangularGridAxes, resolveSpatialAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { fixture, MODEL, STOREY } from '@/test/bonsai-plan-grid-fixture';
import { cleanup } from '@/test/render';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { asExpressIdRef, readAttributes } from '@/lib/placement-core';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';

function clickCrossing(ui: HTMLElement, altKey = false) {
  const lines = [...ui.querySelectorAll('[data-plan-layer="design-grids"] line')];
  const lineFor = (tag: string) => lines.find((line) => line.parentElement?.querySelector('text')?.textContent === tag)!;
  const x = Number(lineFor('B').getAttribute('x1'));
  const y = Number(lineFor('2').getAttribute('y1'));
  const svg = ui.querySelector('[data-plan-canvas]')!;
  act(() => {
    useViewerStore.setState({ snapEnabled: true });
    useViewerStore.getState().startCommand('column.place');
    for (const type of ['pointerdown', 'pointerup']) svg.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, altKey,
    }));
  });
}

function placementAncestors(productId: number) {
  const target = modelEditTarget(useViewerStore.getState(), MODEL)!;
  const attrs = (id: number) => readAttributes(target.dataStore, target.view, target.editor, id)!;
  let id = asExpressIdRef(attrs(productId)[5]);
  const seen = new Set<number>();
  const records: { id: number; type: string | undefined; attributes: unknown[] }[] = [];
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const type = target.editor.getEntityType(id);
    const attributes = attrs(id);
    records.push({ id, type, attributes });
    id = type === 'IfcLocalPlacement' ? asExpressIdRef(attributes[0]) : null;
  }
  return { target, records, attrs };
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

for (const count of [1, 2] as const) describe(`#6232 persisted grid placement with ${count} real Bonsai models`, () => {
  it('a mounted snap to file 2/B retains both actual axes in ObjectPlacement, one undo and redo', async () => {
    const { ui, made } = await fixture(count, { millimetres: true, rotatedStorey: true, reload: true });
    const restore = setRequestRemesh(() => {}); // Isolate async upload; the IFC writer and transaction are real.
    try {
      const before = new Set(useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().map((e) => e.expressId));
      clickCrossing(ui);
      const snap = getCommandRuntime().snap;
      assert.equal(snap?.winner?.kind, 'gridIntersection');
      assert.deepEqual(snap.winner.entity, { modelId: MODEL, expressId: made.expressId });
      assert.deepEqual(snap.local.map((v) => +v.toFixed(6)), [96, 206]);
      const view = useViewerStore.getState().mutationViews.get(MODEL)!;
      const column = view.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCCOLUMN')!;
      assert.ok(column, 'actual mounted pointer path wrote an IFC column');
      const { records, attrs } = placementAncestors(column.expressId);
      const grid = records.find((p) => p.type === 'IfcGridPlacement');
      assert.ok(grid, 'the column placement must persist the authored grid crossing');
      // IFC4 has no PlacementRelTo attribute on IfcGridPlacement: Location is slot 0.
      const intersection = asExpressIdRef(grid.attributes[0]);
      assert.ok(intersection !== null);
      assert.deepEqual((attrs(intersection)[0] as unknown[]).map(asExpressIdRef), [made.build.uAxisIds[1], made.build.vAxisIds[1]]);
      const written = view.getNewEntities().filter((e) => !before.has(e.expressId)).map((e) => e.expressId);
      assert.ok(written.includes(grid.id) && written.includes(intersection));
      act(() => useViewerStore.getState().undo(MODEL));
      assert.ok(written.every((id) => useViewerStore.getState().mutationViews.get(MODEL)!.isDeleted(id)),
        'one actual Undo removes the whole new placement, profile, column and containment graph');
      act(() => useViewerStore.getState().redo(MODEL));
      assert.ok(written.every((id) => !useViewerStore.getState().mutationViews.get(MODEL)!.isDeleted(id)),
        'one actual Redo restores the complete graph');
      assert.ok(placementAncestors(column.expressId).records.some((p) => p.type === 'IfcGridPlacement'));
    } finally { restore(); }
  });

  it('Alt bypass leaves an ordinary local placement even at the same crossing', async () => {
    const { ui } = await fixture(count, { millimetres: true, rotatedStorey: true, reload: true });
    const restore = setRequestRemesh(() => {});
    try {
      clickCrossing(ui, true);
      assert.equal(getCommandRuntime().snap?.winner, null);
      const column = useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCCOLUMN')!;
      assert.ok(column);
      assert.ok(placementAncestors(column.expressId).records.every((p) => p.type !== 'IfcGridPlacement'));
      assert.deepEqual(useViewerStore.getState().readEntityPosition(MODEL, column.expressId)!.map((v) => +v.toFixed(6)), [96, 206, 0]);
    } finally { restore(); }
  });

  it('a valid local child of an existing grid placement never reports its local zero as storey position', async () => {
    const { made } = await fixture(count, { millimetres: true, rotatedStorey: true });
    const target = modelEditTarget(useViewerStore.getState(), MODEL)!;
    const anchor = resolveSpatialAnchor(target.dataStore, STOREY, target.view);
    const column = recordModellingEdit(useViewerStore, MODEL, (_methods, draft) => {
      const grid = gridIntersectionPlacement(draft, anchor, {
        Axes: [made.build.uAxisIds[1], made.build.vAxisIds[1]], GridPlacementId: made.build.placementId,
      });
      return addColumnToStore(draft, { ...anchor, storeyPlacementId: grid.placementId }, {
        Position: [0, 0, 0.5], Width: 0.4, Depth: 0.2, Height: 3,
      });
    });
    assert.ok(placementAncestors(column.columnId).records.some((p) => p.type === 'IfcGridPlacement'));
    const position = useViewerStore.getState().readEntityPosition(MODEL, column.columnId);
    // The existing mutable-position API may refuse this frame, or fully resolve
    // it. Returning child-local (0,0,.5) falsely offers editable storey coordinates.
    assert.ok(position === null || position.every((v, i) => Math.abs(v - [96, 206, 0.5][i]) < 1e-6),
      `must resolve actual storey position or refuse, received ${JSON.stringify(position)}`);
  });

  it('the canonical placement writer refuses axes owned by different grids before emitting any entities', async () => {
    const { made } = await fixture(count);
    const other = addGridIn(useViewerStore, MODEL, STOREY, {
      Position: [0, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
    });
    assert.ok('expressId' in other);
    const target = modelEditTarget(useViewerStore.getState(), MODEL)!;
    const anchor = resolveSpatialAnchor(target.dataStore, STOREY, target.view);
    const before = target.view.getNewEntities().length;
    assert.throws(() => gridIntersectionPlacement(target.editor, anchor, {
      Axes: [made.build.uAxisIds[1], other.build.vAxisIds[1]], GridPlacementId: made.build.placementId,
    }), /grid|owner/i);
    assert.equal(target.view.getNewEntities().length, before, 'refusal leaves no partial placement/intersection');
  });
});
