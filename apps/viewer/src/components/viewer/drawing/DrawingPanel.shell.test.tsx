/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Drawing panel shell (#5494): its toolbar writes the store, its status
 *  line follows the active tool, and its Export menu follows the drawing. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { DrawingPanel } from './DrawingPanel';
import { DrawingRuntimeHost } from './DrawingRuntimeHost';

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
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true, custom: undefined }, ...patch });
}

const byLabel = (ui: ParentNode, label: string) => {
  const el = ui.querySelector(`[aria-label="${label}"]`);
  assert.ok(el, `a control labelled "${label}"`);
  return el;
};
const statusText = (ui: HTMLElement) => ui.querySelector('[role="status"]')?.textContent ?? '';

beforeEach(() => seed());
afterEach(() => cleanup());

it('the markup tool segmented control writes annotation2DActiveTool', () => {
  const ui = render(<DrawingPanel />);
  click(byLabel(ui, 'Distance'));
  assert.equal(useViewerStore.getState().annotation2DActiveTool, 'measure');
  assert.equal(byLabel(ui, 'Distance').getAttribute('aria-checked'), 'true');
  click(byLabel(ui, 'Cloud'));
  assert.equal(useViewerStore.getState().annotation2DActiveTool, 'cloud');
  click(byLabel(ui, 'Select'));
  assert.equal(useViewerStore.getState().annotation2DActiveTool, 'none');
});

it('the display chips write drawing2DDisplayOptions', () => {
  const ui = render(<DrawingPanel />);
  const before = useViewerStore.getState().drawing2DDisplayOptions;
  click(byLabel(ui, '3D overlay'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.show3DOverlay, !before.show3DOverlay);
  assert.equal(byLabel(ui, '3D overlay').getAttribute('aria-pressed'), String(!before.show3DOverlay));
  click(byLabel(ui, 'Annotations'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showIfcAnnotations, !before.showIfcAnnotations);
  click(byLabel(ui, 'Projection'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showConstructionProjection, !before.showConstructionProjection);
  click(byLabel(ui, 'Symbolic'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.useSymbolicRepresentations, !before.useSymbolicRepresentations);
  click(byLabel(ui, 'Print preview'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showPrintPreview, !before.showPrintPreview);
  assert.equal(byLabel(ui, 'Print preview').getAttribute('aria-pressed'), String(!before.showPrintPreview));
});

it('IFC annotations are offered on plan cuts only, and projection never on a custom plane', () => {
  const s = useViewerStore.getState();
  seed({ sectionPlane: { ...s.sectionPlane, axis: 'front', enabled: true, custom: { normal: [1, 0, 0], distance: 1, pickedAt: [1, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] } } });
  const ui = render(<DrawingPanel />);
  assert.ok((byLabel(ui, 'Annotations') as HTMLButtonElement).disabled, 'annotations chip is disabled on a Front cut');
  assert.ok((byLabel(ui, 'Projection') as HTMLButtonElement).disabled, 'projection chip is disabled on a custom plane');
  const before = useViewerStore.getState().drawing2DDisplayOptions;
  click(byLabel(ui, 'Annotations'));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.showIfcAnnotations, before.showIfcAnnotations, 'a disabled chip writes nothing');
});

it("the status line shows the active tool's hint", () => {
  const ui = render(<DrawingPanel />);
  assert.match(statusText(ui), /Drag to pan/);
  click(byLabel(ui, 'Cloud'));
  assert.match(statusText(ui), /Click to place first corner/);
  click(byLabel(ui, 'Area'));
  assert.match(statusText(ui), /Click to place first vertex/);
  act(() => useViewerStore.getState().addPolygonArea2DPoint({ x: 0, y: 0 }));
  assert.match(statusText(ui), /1 vertices — need at least 3/);
  click(byLabel(ui, 'Text'));
  assert.match(statusText(ui), /Click to place text box/);
  assert.ok(ui.querySelector('.absolute.bottom-2.right-2') === null, 'no tip floats over the canvas any more');
});

it('the status line counts the markup', () => {
  const ui = render(<DrawingPanel />);
  assert.match(statusText(ui), /No markup/);
  act(() => {
    const s = useViewerStore.getState();
    s.addMeasure2DResult({ id: 'm1', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, distance: 1 });
    s.addMeasure2DResult({ id: 'm2', start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, distance: 2 });
  });
  assert.match(statusText(ui), /2 measurements/);
  assert.doesNotMatch(statusText(ui), /No markup/);
});

function exportItems(): Array<{ label: string; disabled: boolean }> {
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
    label: item.textContent ?? '', disabled: item.getAttribute('aria-disabled') === 'true',
  }));
}
function openExport(ui: HTMLElement): void {
  // A Radix dropdown opens on pointerdown and portals its items onto document.body.
  const trigger = byLabel(ui, 'Export');
  act(() => trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' } as PointerEventInit)));
  click(trigger);
}

it('the export items are disabled without a drawing', () => {
  const ui = render(<DrawingPanel />);
  openExport(ui);
  const items = exportItems();
  const files = items.filter((i) => /SVG|DXF|PDF|Print/.test(i.label));
  assert.equal(files.length, 4, `four file exports, got ${JSON.stringify(items)}`);
  assert.ok(files.every((i) => i.disabled), 'all four file exports are disabled');
  assert.ok(items.some((i) => /Save Markup to Model/.test(i.label)), 'saving markup into the model is in the same menu');
});

it('the export items are enabled once the drawing is ready', async () => {
  const ui = render(<><DrawingRuntimeHost mergedGeometry={geometry} /><DrawingPanel /></>);
  for (let i = 0; i < 150 && useViewerStore.getState().drawing2DStatus !== 'ready'; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(useViewerStore.getState().drawing2D, 'the host generated a drawing');
  openExport(ui);
  const files = exportItems().filter((i) => /SVG|DXF|PDF|Print/.test(i.label));
  assert.equal(files.length, 4);
  assert.ok(files.every((i) => !i.disabled), 'all four file exports are enabled');
});
