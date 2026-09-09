/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '@ifc-lite/renderer';
import { useModelPlacementSync } from '../useModelPlacementSync';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { act } from 'react';
import { render, cleanup, click, type, press } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useViewerStore } from '@/store';
import { noteDeviationWrite } from '@/lib/model-placement/preview-analysis';
import { emptyPlacementState, displayedTranslation } from '@/lib/model-placement/state';
import { ToolOverlays } from '../ToolOverlays';
import { HomeTab } from '../ribbon/tabs/HomeTab';

function WithPlacementSync({ renderer }: { renderer: Renderer }) {
  useModelPlacementSync({ current: renderer }, true, new Map([['ifc', 0], ['scan', 1]]), null);
  return <ToolOverlays />;
}

function WithShortcuts() { useKeyboardShortcuts(); return <ToolOverlays />; }

function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const el = [...ui.querySelectorAll('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
  assert.ok(el, `button ${label}`); return el;
}
function input(ui: HTMLElement, label: string): HTMLInputElement {
  const el = ui.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(el, `input ${label}`); return el;
}
function select(ui: HTMLElement, label: string, value: string) {
  const el = ui.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(el);
  act(() => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('model repositioning user interactions (#4226)', () => {
  beforeEach(() => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc'), { ...fixtureModel('scan'), ifcDataStore: null }),
      modelPlacement: emptyPlacementState(), repositionOpen: false, repositionNudge: 0.001, activeTool: 'select' });
  });
  afterEach(cleanup);

  for (const tool of ['measure', 'section', 'walk'] as const) it(`opens repositioning from ${tool}`, () => {
    useViewerStore.getState().setActiveTool(tool);
    const ui = render(<><HomeTab /><ToolOverlays /></>);
    click(button(ui, 'Reposition models and pointclouds'));
    assert.ok(ui.querySelector('[aria-label="Reposition models"]'));
    assert.equal(useViewerStore.getState().activeTool, 'select');
    type(input(ui, 'Delta X'), '2 m'); click(button(ui, 'Preview values'));
    assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'ifc')[0], 2);
  });

  it('opens from the ribbon and moves a cloud without requiring an IFC data store', () => {
    const ui = render(<><HomeTab /><ToolOverlays /></>);
    click(button(ui, 'Reposition models and pointclouds'));
    assert.ok(ui.querySelector('[aria-label="Reposition models"]'));
    const checkboxes = ui.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    click(checkboxes[1]); // move IFC and cloud as a group
    type(input(ui, 'Delta X'), '125 mm');
    type(input(ui, 'Delta Y'), '-0.25 m');
    click(button(ui, 'Preview values'));
    assert.match(ui.querySelector('output')!.textContent!, /ΔX 0.1250 · ΔY -0.2500/);
    assert.equal(useViewerStore.getState().modelPlacement.undo.length, 0, 'preview is uncommitted');
    click(button(ui, 'Apply'));
    for (const id of ['ifc', 'scan']) assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, id), [0.125, -0.25, 0]);
    assert.equal(useViewerStore.getState().modelPlacement.undo.length, 1, 'one mixed group command');
    click(button(ui, 'Undo move'));
    for (const id of ['ifc', 'scan']) assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, id), [0, 0, 0]);
    click(button(ui, 'Redo move'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0.125, -0.25, 0]);
  });

  it('honours constraints, supports keyboard nudges and cancels the preview', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    select(ui, 'Movement constraint', 'z');
    type(input(ui, 'Delta X'), '50 m');
    type(input(ui, 'Delta Z'), '10 mm');
    click(button(ui, 'Preview values'));
    assert.match(ui.querySelector('output')!.textContent!, /ΔX 0.0000 · ΔY 0.0000 · ΔZ 0.0100/);
    press(window, 'ArrowUp');
    assert.match(ui.querySelector('output')!.textContent!, /ΔZ 0.0110/);
    press(window, 'Escape');
    assert.equal(ui.querySelector('[aria-label="Reposition models"]'), null);
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });

  it('shows absolute source coordinates and converts typed coordinates into displacement', () => {
    act(() => {
      useViewerStore.getState().openReposition(['scan']);
      useViewerStore.getState().setMoveAnchor('source', { modelId: 'scan', point: [10, 20, 30], kind: 'point' });
    });
    const ui = render(<ToolOverlays />);
    select(ui, 'Coordinate input mode', 'absolute');
    assert.equal(input(ui, 'Source X').value, '10');
    type(input(ui, 'Source X'), '10.001');
    click(button(ui, 'Preview values'));
    const delta = displayedTranslation(useViewerStore.getState().modelPlacement, 'scan');
    assert.ok(Math.abs(delta[0] - 0.001) < 1e-10);
    assert.equal(delta[1], 0); assert.equal(delta[2], 0);
    select(ui, 'Coordinate input mode', 'delta');
    assert.ok(Math.abs(Number(input(ui, 'Delta X').value) - 0.001) < 1e-10);
  });

  it('accepts a signed unit distance along a constrained axis', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    select(ui, 'Movement constraint', 'y');
    type(input(ui, 'Move distance'), '-125 mm');
    click(button(ui, 'Preview distance'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, -0.125, 0]);
    click(button(ui, 'Apply'));
    click(button(ui, 'Undo move'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });

  it('undoes and redoes a committed model move with global shortcuts after the panel closes', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<WithShortcuts />);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values')); click(button(ui, 'Apply'));
    click(button(ui, 'Cancel repositioning'));
    press(window, 'z', { ctrlKey: true });
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
    press(window, 'z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [5, 0, 0]);
  });

  it('branches shared redo history when an authoring edit follows an undone move, and vice versa', () => {
    const view = new MutablePropertyView(null, 'ifc');
    act(() => {
      useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map(), mutationViews: new Map([['ifc', view]]) });
      useViewerStore.getState().openReposition(['scan']);
    });
    const ui = render(<WithShortcuts />);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values')); click(button(ui, 'Apply'));
    click(button(ui, 'Undo move'));
    act(() => { useViewerStore.getState().setAttribute('ifc', 1, 'Name', 'Renamed'); });
    assert.equal(useViewerStore.getState().modelPlacement.redo.length, 0, 'new authoring edit discards the abandoned move branch');
    act(() => useViewerStore.getState().undo('ifc'));
    type(input(ui, 'Delta X'), '7'); click(button(ui, 'Preview values')); click(button(ui, 'Apply'));
    assert.equal(useViewerStore.getState().redoStacks.size, 0, 'new move discards the abandoned authoring branch');
    click(button(ui, 'Undo move')); click(button(ui, 'Redo move'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [7, 0, 0]);
  });

  for (const moveFirst of [true, false]) it(`orders tied-timestamp authoring and placement commands (move first: ${moveFirst}, #4226)`, () => {
    const clock = mock.method(Date, 'now', () => 1000);
    try {
      const view = new MutablePropertyView(null, 'ifc');
      useViewerStore.setState({ undoStacks: new Map(), redoStacks: new Map(), mutationViews: new Map([['ifc', view]]) });
      render(<WithShortcuts />);
      const move = () => { const s = useViewerStore.getState(); s.openReposition(['scan']); s.previewModelTranslation([5, 0, 0]); s.applyModelTranslation(); s.closeReposition(); };
      const rename = () => useViewerStore.getState().setAttribute('ifc', 1, 'Name', 'Renamed');
      act(() => { if (moveFirst) { move(); rename(); } else { rename(); move(); } });
      press(window, 'z', { ctrlKey: true });
      assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan')[0], moveFirst ? 5 : 0);
      assert.equal(view.getAttributeMutationsForEntity(1).find((entry) => entry.name === 'Name')?.value, moveFirst ? undefined : 'Renamed');
      press(window, 'z', { ctrlKey: true });
      assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan')[0], 0);
      assert.equal(view.getAttributeMutationsForEntity(1).find((entry) => entry.name === 'Name')?.value, undefined);
      press(window, 'z', { ctrlKey: true, shiftKey: true });
      assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan')[0], moveFirst ? 5 : 0);
      assert.equal(view.getAttributeMutationsForEntity(1).find((entry) => entry.name === 'Name')?.value, moveFirst ? undefined : 'Renamed');
      press(window, 'z', { ctrlKey: true, shiftKey: true });
      assert.equal(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan')[0], 5);
      assert.equal(view.getAttributeMutationsForEntity(1).find((entry) => entry.name === 'Name')?.value, 'Renamed');
    } finally { clock.mock.restore(); }
  });

  it('ends an old clash solid and its owned visibility when a model moves', () => {
    const renderer = new Renderer(document.createElement('canvas'));
    act(() => {
      const s = useViewerStore.getState();
      s.openReposition(['ifc']); s.setClashSelectedId('old-clash');
      s.setClashSolid({ positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }, 1);
      s.isolateEntities([1]); s.setClashVisibilityOwned({ channel: 'isolate', ids: new Set([1]) });
    });
    const seq = useViewerStore.getState().clashSolidRequestSeq;
    const ui = render(<WithPlacementSync renderer={renderer} />);
    click(button(ui, 'Apply'));
    assert.equal(useViewerStore.getState().clashSolidStatus, 'solid', 'a zero-distance apply does not invalidate spatial results');
    type(input(ui, 'Delta X'), '1'); click(button(ui, 'Preview values'));
    const s = useViewerStore.getState();
    assert.equal(s.clashSolidStatus, 'none'); assert.equal(s.clashSelectedId, null);
    assert.equal(s.isolatedEntities, null, 'the old clash no longer isolates the moving scene');
    assert.ok(s.clashSolidRequestSeq > seq, 'a late solid computation cannot restore the old world-space overlay');
  });

  it('leaves Enter activation to a focused Cancel button or disclosure', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values'));
    for (const target of [button(ui, 'Cancel repositioning'), ui.querySelector('summary')!]) {
      const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      act(() => target.dispatchEvent(key));
      assert.equal(key.defaultPrevented, false, 'native control activation remains available');
      assert.equal(useViewerStore.getState().modelPlacement.undo.length, 0, 'Enter must not commit instead of activating the focused control');
    }
    click(button(ui, 'Cancel repositioning'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });

  for (const finish of ['cancel', 'apply', 'overwritten-deviation'] as const) {
    it(`restores pre-preview analysis only when cancelled safely: ${finish}`, () => {
      const renderer = new Renderer(document.createElement('canvas'));
      const start = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
      act(() => {
        const s = useViewerStore.getState();
        useViewerStore.setState({ measurements: [{ id: 'distance', start, end: { ...start, x: 1 }, distance: 1 }],
          polylineMeasurements: [], angleMeasurements: [], radiusMeasurements: [], placementStaleMeasurements: new Set(),
          pointCloudDeviationComputed: true, pointCloudColorMode: 'deviation' });
        s.setClashResult({ clashes: [], summary: { total: 0, byRule: {}, byTypePair: {},
          bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } }, rulesRun: [],
          settings: { tolerance: 0.002, excludeVoidsAndHosts: true } });
        s.openReposition(['scan']);
      });
      const ui = render(<WithPlacementSync renderer={renderer} />);
      type(input(ui, 'Delta X'), '1'); click(button(ui, 'Preview values'));
      assert.ok(useViewerStore.getState().placementStaleMeasurements.has('distance'));
      assert.equal(useViewerStore.getState().clashResult, null);
      if (finish === 'overwritten-deviation') act(() => {
        noteDeviationWrite(renderer);
        useViewerStore.getState().setPointCloudDeviationComputed(true);
        useViewerStore.getState().setPointCloudColorMode('deviation');
      });
      click(button(ui, finish === 'apply' ? 'Apply' : 'Cancel repositioning'));
      const s = useViewerStore.getState();
      assert.equal(s.placementStaleMeasurements.has('distance'), finish === 'apply');
      assert.equal(s.clashResult?.summary.total, finish === 'apply' ? undefined : 0);
      assert.equal(s.pointCloudDeviationComputed, finish === 'cancel');
      assert.equal(s.pointCloudColorMode, finish === 'cancel' ? 'deviation' : 'rgb');
    });
  }

  for (const locked of [false, true]) it(`closes a removed moving model and can reposition a survivor (locked=${locked})`, () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values'));
    if (locked) click(button(ui, 'Lock scan'));
    act(() => useViewerStore.getState().removeModel('scan'));
    assert.equal(ui.querySelector('[aria-label="Reposition models"]'), null);
    act(() => useViewerStore.getState().openReposition(['ifc']));
    type(input(ui, 'Delta X'), '2'); click(button(ui, 'Preview values')); click(button(ui, 'Apply'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'ifc'), [2, 0, 0]);
  });

  it('cancels with Escape while a coordinate input has focus', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values'));
    press(input(ui, 'Delta X'), 'Escape');
    assert.equal(ui.querySelector('[aria-label="Reposition models"]'), null);
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });

  it('rejects a move while the model is locked and permits it after unlocking', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    click(button(ui, 'Lock scan'));
    type(input(ui, 'Delta X'), '2'); click(button(ui, 'Preview values'));
    assert.match(ui.querySelector('[role="alert"]')!.textContent!, /Unlock/);
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
    click(button(ui, 'Unlock scan'));
    type(input(ui, 'Delta X'), '2'); click(button(ui, 'Preview values')); click(button(ui, 'Apply'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [2, 0, 0]);
  });

  it('rejects malformed input visibly and leaves the existing preview intact', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<ToolOverlays />);
    type(input(ui, 'Delta X'), '3garbage');
    click(button(ui, 'Preview values'));
    assert.match(ui.querySelector('[role="alert"]')!.textContent!, /Enter a number/);
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });

  it('cancels placement when a different tool is selected', () => {
    act(() => useViewerStore.getState().openReposition(['scan']));
    const ui = render(<><HomeTab /><ToolOverlays /></>);
    type(input(ui, 'Delta X'), '5'); click(button(ui, 'Preview values'));
    click(button(ui, 'Select'));
    // Selecting the same tool does not cancel; selecting another one does.
    assert.ok(ui.querySelector('[aria-label="Reposition models"]'));
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [5, 0, 0]);
    act(() => useViewerStore.getState().setActiveTool('walk'));
    assert.equal(ui.querySelector('[aria-label="Reposition models"]'), null);
    assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'scan'), [0, 0, 0]);
  });
});
