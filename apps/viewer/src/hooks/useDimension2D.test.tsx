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
