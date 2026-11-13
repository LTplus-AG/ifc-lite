/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { render, cleanup, mouseDown } from '@/test/render.js';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';
import { useDimension2D, type DimensionTool } from './useDimension2D.js';

const initial = useViewerStore.getState();
const PLANE: DrawnSectionPlane = { axis: 'down', position: 1, flipped: false };
/** The plane the harness passes as drawn; a test changes it, then re-renders through the store. */
let drawnPlane: DrawnSectionPlane = PLANE;
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); drawnPlane = PLANE; });
const EMPTY: Record<string, string> = {};

/** A 4 m × 2 m wall footprint at the origin (entity 10). */
function drawing(): Drawing2D {
  return {
    config: { plane: { axis: 'z', position: 1, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 100 },
    lines: [],
    cutPolygons: [{ entityId: 10, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
      polygon: { outer: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], holes: [] } }],
    projectionPolygons: [], bounds: { min: { x: 0, y: 0 }, max: { x: 4, y: 2 } },
    stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 1, totalTriangles: 0, processingTimeMs: 0 },
  };
}

let tool: DimensionTool;
function Harness() {
  const ref = useRef<HTMLButtonElement>(null);
  const current = useViewerStore((s) => s.drawing2D);
  // 100 px per metre, origin at the top-left: screen = drawing × 100 on a plan.
  tool = useDimension2D({ drawing: current, viewTransform: { x: 0, y: 0, scale: 100 }, axis: 'down', containerRef: ref,
    drawnPlane, displayScale: 100, showHiddenLines: false, unitDisplayOverrides: EMPTY });
  return <button type="button" aria-label="Drawing canvas" ref={ref} onMouseDown={tool.handleMouseDown} onMouseMove={tool.handleMouseMove} onMouseLeave={tool.handleMouseLeave} />;
}

function mouseMove(el: Element, init: MouseEventInit) {
  act(() => { el.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, cancelable: true, ...init })); });
}

async function wallModel() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER; FILE_DESCRIPTION((''),'2;1'); FILE_NAME('','',(''),(''),'','',''); FILE_SCHEMA(('IFC4')); ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCWALL('0Wall000000000000000010',$,'Wall',$,$,$,$,$,$);
ENDSEC; END-ISO-10303-21;`).buffer, { disableWorkerScan: true });
  return fixtureModels({ ...fixtureModel('m'), ifcDataStore: store, maxExpressId: 10 });
}

it('places a snapped dimension in three clicks, with element references and the drawn plane', async () => {
  useViewerStore.setState({ ...(await wallModel()), drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;

  mouseMove(canvas, { clientX: 4, clientY: 3 });
  assert.equal(tool.snapMode, 'endpoint', 'the corner is offered as an endpoint');
  assert.ok(tool.scene?.markers?.length, 'key points near the cursor are marked');
  mouseDown(canvas, { clientX: 4, clientY: 3 });
  mouseMove(canvas, { clientX: 203, clientY: 4 });
  assert.equal(tool.snapMode, 'midpoint');
  mouseDown(canvas, { clientX: 397, clientY: 2 });
  assert.deepEqual(useViewerStore.getState().dimension2DPoints, [{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  assert.equal(tool.step, 2);

  mouseMove(canvas, { clientX: 200, clientY: -80 });
  assert.ok(tool.scene?.preview && Math.abs(tool.scene.preview.offset + 0.8) < 1e-9, `preview offset ${tool.scene?.preview?.offset}`);
  mouseDown(canvas, { clientX: 200, clientY: -80 });

  const [dim] = useViewerStore.getState().dimensions2D;
  assert.ok(dim, 'a dimension was placed');
  assert.deepEqual([dim.a, dim.b, dim.orientation], [{ x: 0, y: 0 }, { x: 4, y: 0 }, 'aligned']);
  assert.ok(Math.abs(dim.offset + 0.8) < 1e-9, `offset ${dim.offset}`);
  assert.deepEqual(dim.plane, PLANE);
  assert.deepEqual(dim.refs, { a: { globalId: '0Wall000000000000000010', ifcType: 'IfcWall' }, b: { globalId: '0Wall000000000000000010', ifcType: 'IfcWall' } });
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 0);
});

it('snaps the second point perpendicular from the first, and Shift locks the line to an axis', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 100, clientY: 600 }); // free point (1, 6), nothing in reach
  mouseMove(canvas, { clientX: 105, clientY: 204 });
  assert.equal(tool.snapMode, 'perpendicular');
  mouseDown(canvas, { clientX: 105, clientY: 204 });
  // The second click landed on the top edge at the foot (1, 2).
  const [a, b] = useViewerStore.getState().dimension2DPoints;
  assert.deepEqual(a, { x: 1, y: 6 });
  assert.ok(Math.abs(b.x - 1) < 1e-9 && Math.abs(b.y - 2) < 1e-9, `perpendicular foot ${JSON.stringify(b)}`);
  mouseDown(canvas, { clientX: 300, clientY: 400, shiftKey: true });
  const [dim] = useViewerStore.getState().dimensions2D;
  assert.equal(dim?.orientation, 'vertical', 'pulled beside a vertical pair: a vertical dimension');
});

it('leaving the tool drops the in-progress dimension and its preview', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 4, clientY: 3 });
  mouseMove(canvas, { clientX: 150, clientY: 150 });
  assert.ok(tool.scene?.preview, 'rubber band shown');
  act(() => useViewerStore.getState().setAnnotation2DActiveTool('none'));
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 0);
  assert.equal(tool.scene, null, 'nothing left to draw');
  assert.equal(useViewerStore.getState().dimensions2D.length, 0);
});

it('with Select, a dimension is selected, dragged and deleted like other markup', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none',
    dimensions2D: [{ id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: PLANE }] });
  const canvas = render(<Harness />).firstElementChild!;
  // The dimension line runs at y = -1 m, i.e. 100 px above the origin.
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  assert.deepEqual(useViewerStore.getState().selectedAnnotation2D, { type: 'dimension', id: 'd1' });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  const moved = useViewerStore.getState().dimensions2D[0];
  assert.deepEqual([moved.a, moved.b, moved.offset], [{ x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }, -1]);
  mouseMove(canvas, { clientX: 900, clientY: 900 });
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 0.5, y: 0.5 }, 'released: moving no longer drags');
  act(() => useViewerStore.getState().deleteSelectedAnnotation2D());
  assert.equal(useViewerStore.getState().dimensions2D.length, 0);
});

it('hovering a dimension from another cut reports it; one from this cut does not', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', dimensions2D: [
    { id: 'here', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: PLANE },
    { id: 'there', a: { x: 0, y: 5 }, b: { x: 4, y: 5 }, offset: 0, orientation: 'aligned', plane: { ...PLANE, position: 4 } },
  ] });
  const canvas = render(<Harness />).firstElementChild!;
  // Read through a call: the harness reassigns `tool` on render, which narrowing cannot see.
  const hovered = () => tool.hover?.id ?? null;
  mouseMove(canvas, { clientX: 200, clientY: -100 });
  assert.equal(hovered(), null);
  mouseMove(canvas, { clientX: 200, clientY: 500 });
  assert.equal(hovered(), 'there');
  mouseMove(canvas, { clientX: 900, clientY: 900 });
  assert.equal(hovered(), null);
});

it('leaving the canvas clears the hover note, snap glyph and preview but keeps the placed points', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', dimensions2D: [
    { id: 'there', a: { x: 0, y: 5 }, b: { x: 4, y: 5 }, offset: 0, orientation: 'aligned', plane: { ...PLANE, position: 4 } },
  ] });
  const canvas = render(<Harness />).firstElementChild!;
  const hovered = () => tool.hover?.id ?? null;
  mouseMove(canvas, { clientX: 200, clientY: 500 });
  assert.equal(hovered(), 'there');
  act(() => { canvas.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
  assert.equal(hovered(), null, 'the Other cut note does not linger outside the canvas');

  act(() => useViewerStore.getState().setAnnotation2DActiveTool('dimension'));
  mouseDown(canvas, { clientX: 4, clientY: 3 });
  mouseMove(canvas, { clientX: 397, clientY: 2 });
  assert.ok(tool.snapMode && tool.scene?.preview, 'snap and rubber band shown');
  act(() => { canvas.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
  assert.equal(tool.snapMode, null, 'no snap glyph left behind');
  assert.equal(tool.scene?.preview ?? null, null, 'no rubber band left behind');
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 1, 'the placed point stays');
});

it('pressing or releasing Shift without moving updates the preview to what the click commits (#10076 review)', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 100, clientY: 600 }); // (1, 6)
  mouseDown(canvas, { clientX: 500, clientY: 500 }); // (5, 5)
  mouseMove(canvas, { clientX: 300, clientY: 900 });
  assert.equal(tool.lockAxis, false);
  assert.equal(tool.scene?.preview?.orientation, 'aligned');
  act(() => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })); });
  assert.equal(tool.lockAxis, true, 'Shift down locks the preview without a pointer move');
  assert.notEqual(tool.scene?.preview?.orientation, 'aligned');
  act(() => { window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift' })); });
  assert.equal(tool.scene?.preview?.orientation, 'aligned', 'Shift up returns it to aligned');
});

it('a new drawing drops the old snap glyph and markers; a new cut drops the placed points (#10076 review)', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseMove(canvas, { clientX: 4, clientY: 3 });
  assert.equal(tool.snapMode, 'endpoint');
  assert.ok(tool.scene?.markers?.length);
  act(() => useViewerStore.setState({ drawing2D: drawing() }));
  assert.equal(tool.snapMode, null, 'no snap glyph from the previous drawing');
  assert.equal(tool.scene?.markers?.length ?? 0, 0, 'no key-point markers from the previous drawing');

  mouseDown(canvas, { clientX: 4, clientY: 3 });
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 1);
  act(() => useViewerStore.setState({ drawing2D: drawing() }));
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 1, 'regenerating the same cut keeps the placed point');
  drawnPlane = { ...PLANE, position: 2 };
  act(() => useViewerStore.setState({ drawing2D: drawing() }));
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 0, 'a point placed on the previous cut is dropped');
});
