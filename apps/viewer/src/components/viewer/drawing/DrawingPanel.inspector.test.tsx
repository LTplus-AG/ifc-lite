/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's inspector column (#5495): the toolbar's Overrides /
 * Sheet / Underlays / Scan toggles share one persisted tab, opening a tab
 * lays it out BESIDE the canvas rather than over it, and the Sheet tab
 * still flips `sheetPanelVisible` — the flag other code (the Esc
 * double-press handler, `sheetSlice.teardown.ts`) still reads.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { DrawingPanel } from './DrawingPanel';

function wallBox(): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { expressId: 1, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length),
    indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}
const zero = { x: 0, y: 0, z: 0 }, max = { x: 10, y: 10, z: 10 };
const geometry: GeometryResult = { meshes: [wallBox()], totalTriangles: 12, totalVertices: 8,
  coordinateInfo: { originShift: zero, originalBounds: { min: zero, max }, shiftedBounds: { min: zero, max }, hasLargeCoordinates: false } };

function seed(patch: Partial<ReturnType<typeof useViewerStore.getState>> = {}): void {
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: null, geometryResult: geometry }),
    modelPlacement: emptyPlacementState(), activeModelId: null, ifcDataStore: null, activeTool: 'select',
    drawing2D: null, drawing2DStatus: 'idle', drawing2DPanelVisible: true, annotation2DActiveTool: 'none',
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true, custom: undefined },
    drawingInspectorTab: null, sheetPanelVisible: false, ...patch });
}

const byLabel = (ui: ParentNode, label: string) => {
  const el = ui.querySelector(`[aria-label="${label}"]`);
  assert.ok(el, `a control labelled "${label}"`);
  return el;
};

beforeEach(() => seed());
afterEach(() => {
  cleanup();
  localStorage.removeItem('ifc-lite:drawing-inspector-v1');
});

describe('Drawing inspector column (#5495)', () => {
  it('the toolbar toggles share one tab; re-toggling the active tab collapses the column', () => {
    const ui = render(<DrawingPanel />);
    assert.equal(useViewerStore.getState().drawingInspectorTab, null);
    assert.equal(document.querySelector('[data-drawing-inspector]'), null, 'no column while collapsed');

    click(byLabel(ui, 'Overrides'));
    assert.equal(useViewerStore.getState().drawingInspectorTab, 'overrides');
    assert.ok(document.querySelector('[data-drawing-inspector]'), 'the column mounts once a tab opens');
    assert.match(ui.textContent ?? '', /Style Presets/, 'the Overrides tab shows DrawingSettingsPanel content');

    click(byLabel(ui, 'Scan'));
    assert.equal(useViewerStore.getState().drawingInspectorTab, 'scan', 'a different toggle switches the tab, not appends one');
    assert.match(ui.textContent ?? '', /Show scan points/, 'the Scan tab shows ScanSectionPanel content');

    click(byLabel(ui, 'Scan'));
    assert.equal(useViewerStore.getState().drawingInspectorTab, null, 'toggling the OPEN tab again collapses the column');
    assert.equal(document.querySelector('[data-drawing-inspector]'), null);
  });

  it('opening a tab sits BESIDE the canvas, not over it', () => {
    const ui = render(<DrawingPanel />);
    click(byLabel(ui, 'Underlays'));

    const canvas = document.querySelector('[data-drawing-canvas]');
    const inspector = document.querySelector('[data-drawing-inspector]');
    assert.ok(canvas, 'the canvas region is still mounted');
    assert.ok(inspector, 'the inspector column is mounted');
    assert.equal(canvas!.parentElement, inspector!.parentElement, 'canvas and inspector are flex siblings, not stacked');
    assert.ok(
      !(inspector as HTMLElement).className.includes('absolute'),
      `the beside-canvas column must not be absolutely positioned over it, got "${(inspector as HTMLElement).className}"`,
    );
  });

  it('selecting the Sheet tab still flips sheetPanelVisible, which other code reads', () => {
    const ui = render(<DrawingPanel />);
    assert.equal(useViewerStore.getState().sheetPanelVisible, false);
    click(byLabel(ui, 'Sheet'));
    assert.equal(useViewerStore.getState().drawingInspectorTab, 'sheet');
    assert.equal(useViewerStore.getState().sheetPanelVisible, true, 'the Sheet tab still enables sheet mode');

    // Switching away from Sheet turns the mirrored flag back off.
    click(byLabel(ui, 'Overrides'));
    assert.equal(useViewerStore.getState().sheetPanelVisible, false);

    // The reverse also holds: an external close (Esc double-press style) of
    // `sheetPanelVisible` closes the Sheet tab in turn.
    click(byLabel(ui, 'Sheet'));
    assert.equal(useViewerStore.getState().drawingInspectorTab, 'sheet');
    useViewerStore.getState().setSheetPanelVisible(false);
    assert.equal(useViewerStore.getState().drawingInspectorTab, null, 'an external sheetPanelVisible(false) closes the Sheet tab');
  });

  it('the open tab is persisted to localStorage', () => {
    const ui = render(<DrawingPanel />);
    click(byLabel(ui, 'Underlays'));
    const raw = localStorage.getItem('ifc-lite:drawing-inspector-v1');
    assert.ok(raw, 'expected the inspector tab to be persisted');
    assert.equal(JSON.parse(raw!).tab, 'underlays');
  });

  it('session reset closes Sheet while preserving the inspector width (#5772)', () => {
    const ui = render(<DrawingPanel />);
    useViewerStore.getState().setDrawingInspectorWidth(360);
    click(byLabel(ui, 'Sheet'));

    useViewerStore.getState().resetViewerState();

    assert.equal(useViewerStore.getState().sheetPanelVisible, false);
    assert.equal(useViewerStore.getState().drawingInspectorTab, null);
    assert.equal(useViewerStore.getState().drawingInspectorWidth, 360);
  });

  for (const tab of ['overrides', 'underlays', 'scan'] as const) {
    it(`session reset preserves the ${tab} workspace preference (#5772)`, () => {
      useViewerStore.getState().toggleDrawingInspectorTab(tab);
      useViewerStore.getState().setDrawingInspectorWidth(360);

      useViewerStore.getState().resetViewerState();

      assert.equal(useViewerStore.getState().drawingInspectorTab, tab);
      assert.equal(useViewerStore.getState().drawingInspectorWidth, 360);
    });
  }
});
