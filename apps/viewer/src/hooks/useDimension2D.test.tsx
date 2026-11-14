/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { render, cleanup, mouseDown } from '@/test/render.js';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';
import { resolveSheetTransform } from '@/lib/drawing/sheet-transform';
import { drawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping';
import { dimensionScreenLayout } from '@/components/viewer/drawing/drawDimensions2D';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { useDimension2D, type DimensionTool, type UseDimension2DParams } from './useDimension2D.js';

const initial = useViewerStore.getState();
const PLANE: DrawnSectionPlane = { axis: 'down', position: 1, flipped: false };
/** The plane the harness passes as drawn; a test changes it, then re-renders through the store. */
let drawnPlane: DrawnSectionPlane = PLANE;
/** Sheet mode for one test: the sheet and the view transform (pixels per paper mm). */
let sheetMode: { sheet: NonNullable<UseDimension2DParams['sheet']>; view: { x: number; y: number; scale: number } } | null = null;
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); drawnPlane = PLANE; sheetMode = null; });
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
  tool = useDimension2D({ drawing: current, viewTransform: sheetMode?.view ?? { x: 0, y: 0, scale: 100 }, axis: 'down', containerRef: ref,
    drawnPlane, displayScale: 100, showHiddenLines: false, unitDisplayOverrides: EMPTY, sheet: sheetMode?.sheet });
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
  assert.equal(tool.scene?.preview ?? null, null, 'no rubber band to the old snapped position until the pointer moves');
  drawnPlane = { ...PLANE, position: 2 };
  act(() => useViewerStore.setState({ drawing2D: drawing() }));
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 0, 'a point placed on the previous cut is dropped');
});

it('switching to the hovered dimension\'s cut without moving drops the stale Other cut note (#10076 review)', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', dimensions2D: [
    { id: 'there', a: { x: 0, y: 5 }, b: { x: 4, y: 5 }, offset: 0, orientation: 'aligned', plane: { ...PLANE, position: 4 } },
  ] });
  const canvas = render(<Harness />).firstElementChild!;
  const hovered = () => tool.hover?.id ?? null;
  mouseMove(canvas, { clientX: 200, clientY: 500 });
  assert.equal(hovered(), 'there');
  drawnPlane = { ...PLANE, position: 4 };
  act(() => useViewerStore.setState({ drawing2D: drawing() }));
  assert.equal(hovered(), null, 'the hover from the previous drawing is dropped');
});

it('deleting the hovered dimension from another cut drops its Other cut note without a pointer move (#10076 review)', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', dimensions2D: [
    { id: 'there', a: { x: 0, y: 5 }, b: { x: 4, y: 5 }, offset: 0, orientation: 'aligned', plane: { ...PLANE, position: 4 } },
  ] });
  const canvas = render(<Harness />).firstElementChild!;
  const hovered = () => tool.hover?.id ?? null;
  mouseMove(canvas, { clientX: 200, clientY: 500 });
  assert.equal(hovered(), 'there');
  act(() => {
    useViewerStore.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'there' });
    useViewerStore.getState().deleteSelectedAnnotation2D();
  });
  assert.equal(useViewerStore.getState().dimensions2D.length, 0);
  assert.equal(hovered(), null, 'no note for a dimension that no longer exists');
});

/** A 1:100 sheet whose viewport is 100 × 50 mm at (10, 10); the frame and title block lie outside it. */
function sheet(): DrawingSheet {
  return {
    id: 's', name: 's',
    paper: { id: 'p', name: 'p', widthMm: 200, heightMm: 120, orientation: 'landscape' } as unknown as DrawingSheet['paper'],
    frame: {} as unknown as DrawingSheet['frame'],
    titleBlock: { fields: [], position: 'bottom-right', heightMm: 30 } as unknown as DrawingSheet['titleBlock'],
    scaleBar: {} as unknown as DrawingSheet['scaleBar'],
    scale: { name: '1:100', factor: 100, useCase: '' },
    northArrow: {} as unknown as DrawingSheet['northArrow'],
    viewportBounds: { x: 10, y: 10, width: 100, height: 50 },
    revisions: [],
  };
}

it('in sheet mode a dimension clipped out of the viewport cannot be selected, dragged or hovered (#10076 review)', () => {
  const s = sheet();
  const view = { x: 0, y: 0, scale: 2 };
  sheetMode = { sheet: { sheet: s, isPinned: false, cached: null }, view };
  const d = drawing();
  const placement = resolveSheetTransform({ sheet: s, axis: 'down', isPinned: false, cached: null,
    drawingBounds: { minX: 0, minY: 0, maxX: 4, maxY: 2 } }).transform;
  const layout = { mapping: drawingViewMapping(view, 'down', placement), paperScale: 100, format: (m: number) => m.toFixed(2) };
  // The midpoint of a dimension's line, on screen, as the canvas lays it out.
  const lineMid = (dim: Dimension2D) => { const [p, q] = dimensionScreenLayout(dim, layout).lines[0]; return { clientX: (p.x + q.x) / 2, clientY: (p.y + q.y) / 2 }; };
  // Viewport on screen: x 20..220, y 20..120 px. 5 m off the wall is 50 mm on paper: outside it.
  const out: Dimension2D = { id: 'out', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -5, orientation: 'aligned', plane: { ...PLANE, position: 4 } };
  const inside: Dimension2D = { ...out, id: 'in', offset: -1 };
  const outAt = lineMid(out);
  const inAt = lineMid(inside);
  assert.ok(outAt.clientY < 20 || outAt.clientY > 120, `the 'out' line is outside the viewport (y ${outAt.clientY})`);
  assert.ok(inAt.clientY > 20 && inAt.clientY < 120, `the 'in' line is inside the viewport (y ${inAt.clientY})`);

  useViewerStore.setState({ drawing2D: d, annotation2DActiveTool: 'none', dimensions2D: [out] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseMove(canvas, outAt);
  assert.equal(tool.hover, null, 'no Other cut note over the blank title block');
  mouseDown(canvas, outAt);
  assert.equal(useViewerStore.getState().selectedAnnotation2D, null, 'a clipped dimension is not selected');
  mouseMove(canvas, { clientX: outAt.clientX + 30, clientY: outAt.clientY + 30 });
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 0, y: 0 }, 'nor dragged');

  // The same dimension inside the viewport still selects and hovers.
  act(() => useViewerStore.setState({ dimensions2D: [inside] }));
  mouseMove(canvas, inAt);
  assert.equal((tool as DimensionTool).hover?.id, 'in'); // re-read: the null assert above narrowed tool.hover
  mouseDown(canvas, inAt);
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.deepEqual(useViewerStore.getState().selectedAnnotation2D, { type: 'dimension', id: 'in' });
});

it('in sheet mode the dimension tool places no point outside the viewport (#10076 review)', () => {
  sheetMode = { sheet: { sheet: sheet(), isPinned: false, cached: null }, view: { x: 0, y: 0, scale: 2 } };
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  // (300, 200) px is paper (150, 100) mm: on the sheet, past the viewport.
  mouseMove(canvas, { clientX: 300, clientY: 200 });
  assert.equal(tool.scene?.preview ?? null, null, 'no preview off the drawing');
  assert.equal(tool.snapMode, null);
  mouseDown(canvas, { clientX: 300, clientY: 200 });
  assert.deepEqual(useViewerStore.getState().dimension2DPoints, [], 'the click outside placed nothing');
  mouseDown(canvas, { clientX: 100, clientY: 70 });
  assert.equal(useViewerStore.getState().dimension2DPoints.length, 1, 'a click inside the viewport places a point');
});

it('in sheet mode a snap target clipped out of the viewport is not taken (#10076 review)', () => {
  const s = sheet();
  const view = { x: 0, y: 0, scale: 2 };
  sheetMode = { sheet: { sheet: s, isPinned: false, cached: null }, view };
  // A second footprint whose far corner lies just past the viewport's right edge.
  const d = drawing();
  d.cutPolygons.push({ entityId: 11, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
    polygon: { outer: [{ x: 4, y: 0.5 }, { x: 7.05, y: 0.5 }, { x: 7.05, y: 1.5 }, { x: 4, y: 1.5 }], holes: [] } });
  const placement = resolveSheetTransform({ sheet: s, axis: 'down', isPinned: false, cached: null,
    drawingBounds: { minX: 0, minY: 0, maxX: 4, maxY: 2 } }).transform;
  const mapping = drawingViewMapping(view, 'down', placement);
  const corner = mapping.toScreen({ x: 7.05, y: 1.5 });
  const right = (s.viewportBounds.x + s.viewportBounds.width) * view.scale;
  assert.ok(corner.x > right && corner.x - right < 3, `the corner is just outside the viewport (${corner.x} vs ${right})`);

  useViewerStore.setState({ drawing2D: d, annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  const at = { clientX: right - 1, clientY: corner.y };
  mouseMove(canvas, at);
  assert.notEqual(tool.snapMode, 'endpoint', 'the clipped corner is not offered');
  // The visible edge under the cursor is still snapped to (#10076 review): losing the
  // corner must not drop the snap and its element reference.
  assert.equal(tool.snapMode, 'nearest', 'the visible edge is offered instead');
  assert.ok((tool.scene?.markers ?? []).every((m) => mapping.toScreen(m).x <= right), 'no marker outside the viewport');
  mouseDown(canvas, at);
  const [placed] = useViewerStore.getState().dimension2DPoints;
  assert.ok(placed && mapping.toScreen(placed).x <= right, `the placed point is on the visible drawing (${placed && mapping.toScreen(placed).x})`);
  assert.ok(Math.abs(placed.y - 1.5) < 1e-9, `the placed point lies on the visible edge (y ${placed.y})`);
});

it('in sheet mode a visible endpoint wins over a closer one clipped out of the viewport (#10076 review)', () => {
  const s = sheet();
  const view = { x: 0, y: 0, scale: 2 };
  sheetMode = { sheet: { sheet: s, isPinned: false, cached: null }, view };
  const d = drawing();
  // Corner (7.05, 1.5) lies just past the viewport's right edge; corner (6.8, 1.6) of a
  // second footprint is visible and also inside the snap radius, a little further away.
  d.cutPolygons.push(
    { entityId: 11, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
      polygon: { outer: [{ x: 4, y: 0.5 }, { x: 7.05, y: 0.5 }, { x: 7.05, y: 1.5 }, { x: 4, y: 1.5 }], holes: [] } },
    { entityId: 12, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
      polygon: { outer: [{ x: 6.5, y: 1.6 }, { x: 6.8, y: 1.6 }, { x: 6.8, y: 1.9 }, { x: 6.5, y: 1.9 }], holes: [] } },
  );
  const placement = resolveSheetTransform({ sheet: s, axis: 'down', isPinned: false, cached: null,
    drawingBounds: { minX: 0, minY: 0, maxX: 4, maxY: 2 } }).transform;
  const mapping = drawingViewMapping(view, 'down', placement);
  const right = (s.viewportBounds.x + s.viewportBounds.width) * view.scale;
  const clipped = mapping.toScreen({ x: 7.05, y: 1.5 });
  const visible = mapping.toScreen({ x: 6.8, y: 1.6 });
  const at = { clientX: right - 1, clientY: clipped.y };
  const dist = (q: { x: number; y: number }) => Math.hypot(q.x - at.clientX, q.y - at.clientY);
  assert.ok(clipped.x > right && visible.x < right && dist(clipped) < dist(visible) && dist(visible) < 10,
    `setup: clipped ${JSON.stringify(clipped)}, visible ${JSON.stringify(visible)}, edge ${right}`);

  useViewerStore.setState({ drawing2D: d, annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseMove(canvas, at);
  assert.equal(tool.snapMode, 'endpoint', 'the visible endpoint is offered');
  mouseDown(canvas, at);
  const [placed] = useViewerStore.getState().dimension2DPoints;
  assert.ok(placed && Math.abs(placed.x - 6.8) < 1e-9 && Math.abs(placed.y - 1.6) < 1e-9, `placed on the visible corner: ${JSON.stringify(placed)}`);
});

// ── Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo ─────────────────────────────

const D = (id: string): Dimension2D => ({ id, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned' });

/** Dispatches a keydown on `target` and reports whether it was cancelled and whether it reached a window bubble listener. */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  let reachedBubble = false;
  const onBubble = () => { reachedBubble = true; };
  window.addEventListener('keydown', onBubble);
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: true, ...init });
  act(() => { target.dispatchEvent(event); });
  window.removeEventListener('keydown', onBubble);
  return { prevented: event.defaultPrevented, reachedBubble };
}

function seedHistory() {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const s = useViewerStore.getState();
  s.addDimension2D(D('a')); s.addDimension2D(D('b'));
}
const liveIds = () => useViewerStore.getState().dimensions2D.map((d) => d.id);

it('Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redo while the tool is active, swallowing the key', () => {
  seedHistory();
  const canvas = render(<Harness />).firstElementChild!;
  let r = press(canvas, 'z');
  assert.deepEqual([r.prevented, r.reachedBubble], [true, false], 'preventDefault and stopPropagation');
  assert.deepEqual(liveIds(), ['a']);
  r = press(canvas, 'z', { shiftKey: true });
  assert.equal(r.prevented, true);
  assert.deepEqual(liveIds(), ['a', 'b']);
  press(canvas, 'z');
  press(canvas, 'y');
  assert.deepEqual(liveIds(), ['a', 'b'], 'Ctrl+Y redoes');
  press(canvas, 'Z');
  assert.deepEqual(liveIds(), ['a'], 'caps lock / shift variants of the key still undo');
});

it('Cmd+Z and Cmd+Shift+Z work like Ctrl; Cmd+Y and Alt chords are left alone', () => {
  seedHistory();
  const canvas = render(<Harness />).firstElementChild!;
  press(canvas, 'z', { ctrlKey: false, metaKey: true });
  assert.deepEqual(liveIds(), ['a']);
  press(canvas, 'z', { ctrlKey: false, metaKey: true, shiftKey: true });
  assert.deepEqual(liveIds(), ['a', 'b']);
  assert.equal(press(canvas, 'z', { altKey: true }).prevented, false);
  assert.equal(press(canvas, 'y', { ctrlKey: false, metaKey: true }).prevented, false);
  assert.equal(press(canvas, 'z', { ctrlKey: false }).prevented, false, 'a bare Z is not a shortcut');
  assert.deepEqual(liveIds(), ['a', 'b']);
});

it('leaves Ctrl+Z and redo to the workspace history when the dimension stack is empty', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension', dimension2DUndo: [], dimension2DRedo: [] });
  const canvas = render(<Harness />).firstElementChild!;
  for (const [key, opts] of [['z', {}], ['z', { shiftKey: true }], ['y', {}]] as const) {
    const r = press(canvas, key, opts);
    assert.deepEqual([r.prevented, r.reachedBubble], [false, true], `${key} ${JSON.stringify(opts)} passes through`);
  }
});

it('does nothing, and does not cancel the key, while the dimension tool is not active', () => {
  seedHistory();
  useViewerStore.setState({ annotation2DActiveTool: 'none' });
  const canvas = render(<Harness />).firstElementChild!;
  const r = press(canvas, 'z');
  assert.deepEqual([r.prevented, r.reachedBubble], [false, true], 'left for the global handlers');
  assert.deepEqual(liveIds(), ['a', 'b']);
  act(() => useViewerStore.getState().setAnnotation2DActiveTool('dimension'));
  press(canvas, 'z');
  assert.deepEqual(liveIds(), ['a'], 'active again');
  act(() => useViewerStore.getState().setAnnotation2DActiveTool('measure'));
  assert.equal(press(canvas, 'z').prevented, false, 'another tool: the listener is gone');
  assert.deepEqual(liveIds(), ['a']);
});

it('leaves Ctrl+Z to inputs, textareas, contenteditable hosts and panels with their own history', () => {
  seedHistory();
  render(<Harness />);
  const field = (tag: string) => { const el = document.createElement(tag); document.body.appendChild(el); return el; };
  const editable = field('div');
  Object.defineProperty(editable, 'isContentEditable', { value: true });
  const panel = field('div'); panel.setAttribute('data-own-history', '');
  const inside = document.createElement('button'); panel.appendChild(inside);
  for (const target of [field('input'), field('textarea'), field('select'), editable, inside]) {
    const r = press(target, 'z');
    assert.deepEqual([r.prevented, r.reachedBubble], [false, true], `${(target as HTMLElement).tagName} keeps its own undo`);
    assert.equal(press(target, 'y').prevented, false);
    assert.equal(press(target, 'z', { shiftKey: true }).prevented, false);
  }
  assert.deepEqual(liveIds(), ['a', 'b'], 'the dimension history was never touched');
  // Focus elsewhere in the document (not an input) still undoes.
  press(field('div'), 'z');
  assert.deepEqual(liveIds(), ['a']);
});

it('a dimension drag is one undo step', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none',
    dimensions2D: [{ id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: PLANE }] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 1, y: 1 });
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 1, 'many mouse moves, one command');
  act(() => useViewerStore.getState().undoDimension2D());
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 0, y: 0 });
});

it('a drag whose markup is replaced mid-drag records nothing on release', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none',
    dimensions2D: [{ id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: PLANE }] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  // A restore replaces the markup (and resets its history) while the button is held.
  const restored = [{ id: 'r1', a: { x: 9, y: 9 }, b: { x: 12, y: 9 }, offset: 1, orientation: 'aligned' as const, plane: PLANE }];
  act(() => useViewerStore.setState({ dimensions2D: restored, dimension2DUndo: [], dimension2DRedo: [] }));
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 0, 'no stale pre-drag snapshot to undo into');
  assert.deepEqual(liveIds(), ['r1']);
});

it('a drag across a reconcile that keeps the dragged dimension is still one undo step', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none',
    dimensions2D: [{ id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', plane: PLANE }] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  // A restore unites a stored dimension with the live list and rebases (here: replaces) the stacks.
  const saved = { id: 's1', a: { x: 9, y: 9 }, b: { x: 12, y: 9 }, offset: 1, orientation: 'aligned' as const, plane: PLANE };
  act(() => useViewerStore.setState((st) => ({ dimensions2D: [saved, ...st.dimensions2D], dimension2DUndo: [], dimension2DRedo: [] })));
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 1, 'the drag is recorded');
  act(() => useViewerStore.getState().undoDimension2D());
  const live = useViewerStore.getState().dimensions2D;
  assert.deepEqual(live.map((d) => d.id), ['s1', 'd1'], 'undo keeps the reconciled dimension');
  assert.deepEqual(live[1].a, { x: 0, y: 0 }, 'and puts the dragged one back where it started');
});

it('a drag that crosses a model switch records nothing, even onto a same-id dimension', () => {
  const d1 = { id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned' as const, plane: PLANE };
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', activeModelId: 'A', dimensions2D: [d1] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  // Model B carries a dimension with the same id but other geometry.
  act(() => useViewerStore.setState({ activeModelId: 'B', dimensions2D: [{ ...d1, a: { x: 7, y: 7 }, b: { x: 9, y: 7 } }], dimension2DUndo: [], dimension2DRedo: [] }));
  // Moving after the switch must not drag model B's same-id dimension.
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 7, y: 7 }, 'model B markup is untouched');
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 0);
});

it('a drag interrupted by a switch away and back (A→B→A) records nothing', () => {
  const d1 = { id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned' as const, plane: PLANE };
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', activeModelId: 'A', dimensions2D: [d1] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  // Back on A with the very objects the drag last wrote, so only the switch itself can end it.
  const moved = useViewerStore.getState().dimensions2D;
  act(() => useViewerStore.setState({ activeModelId: 'B', dimensions2D: [], dimension2DUndo: [], dimension2DRedo: [] }));
  act(() => useViewerStore.setState({ activeModelId: 'A', dimensions2D: moved, dimension2DUndo: [], dimension2DRedo: [] }));
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.deepEqual(useViewerStore.getState().dimensions2D, moved, 'not moved after the round trip');
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 0, 'and nothing recorded');
});

it('a drag whose dimension is replaced by a same-id one mid-drag stops and records nothing', () => {
  const d1 = { id: 'd1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned' as const, plane: PLANE };
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', activeModelId: 'A', dimensions2D: [d1] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 250, clientY: -50 });
  const replaced = { ...d1, a: { x: 5, y: 5 }, b: { x: 8, y: 5 } };
  act(() => useViewerStore.setState({ dimensions2D: [replaced], dimension2DUndo: [], dimension2DRedo: [] }));
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 5, y: 5 }, 'the replacement is not dragged');
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 0, 'and no stale before-state is recorded');
});

it('undoing a drag puts every same-id dimension back at its own start', () => {
  const first = { id: 'dup', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned' as const, plane: PLANE };
  const second = { ...first, a: { x: 0, y: -6 }, b: { x: 3, y: -6 } };
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'none', dimensions2D: [first, second] });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 200, clientY: -100 });
  mouseMove(canvas, { clientX: 300, clientY: 0 });
  act(() => { window.dispatchEvent(new window.MouseEvent('mouseup')); });
  assert.equal(useViewerStore.getState().dimension2DUndo.length, 1);
  act(() => useViewerStore.getState().undoDimension2D());
  const [a, b] = useViewerStore.getState().dimensions2D;
  assert.deepEqual([a.a, a.b], [first.a, first.b]);
  assert.deepEqual([b.a, b.b], [second.a, second.b], 'the second is restored to its own geometry');
});

it('placing a dimension with the tool is undoable from the keyboard', () => {
  useViewerStore.setState({ drawing2D: drawing(), annotation2DActiveTool: 'dimension' });
  const canvas = render(<Harness />).firstElementChild!;
  mouseDown(canvas, { clientX: 100, clientY: 600 });
  mouseDown(canvas, { clientX: 300, clientY: 600 });
  mouseDown(canvas, { clientX: 200, clientY: 500 });
  assert.equal(useViewerStore.getState().dimensions2D.length, 1);
  press(canvas, 'z');
  assert.equal(useViewerStore.getState().dimensions2D.length, 0);
  press(canvas, 'z', { shiftKey: true });
  assert.equal(useViewerStore.getState().dimensions2D.length, 1);
});
