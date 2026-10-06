/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore, type FederatedModel } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { computePolygonArea, computePolygonPerimeter } from '@/components/viewer/tools/computePolygonArea';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

interface Row { kind: string; unit: string; value: number; perimeter?: number; perimeterUnit?: string; vertexCount?: number;
  start?: { x: number; y: number } }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

const drawing = { config: { plane: { axis: 'down', position: 3.2, flipped: false }, projectionDepth: 10, includeHiddenLines: true,
  creaseAngle: 30, scale: 100 }, lines: [], cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
} as unknown as Drawing2D;

/** Measure through the slice's real actions, as the canvas does: a 3-4-5 distance and a 4 x 2.5 m room. */
function measureOnDrawing(): void {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('A')), drawing2D: drawing, drawing2DStatus: 'ready' });
  const s = useViewerStore.getState();
  s.setMeasure2DStart({ x: 1, y: 1 });
  s.setMeasure2DCurrent({ x: 4, y: 5 });
  useViewerStore.getState().completeMeasure2D();
  const room = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2.5 }, { x: 0, y: 2.5 }];
  for (const point of room) useViewerStore.getState().addPolygonArea2DPoint(point);
  useViewerStore.getState().completePolygonArea2D(computePolygonArea(room), computePolygonPerimeter(room));
}

test('#6833 drawingMeasurements: no drawing markup is unavailable', () => {
  useViewerStore.setState({ drawing2D: drawing });
  const snapshot = captureEvidence('drawingMeasurements');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 drawingMeasurements: distances in m and areas in m2 stay separate, with the current drawing named', () => {
  measureOnDrawing();
  const snapshot = captureEvidence('drawingMeasurements');
  const [distance, area] = rowsOf(snapshot.payload);
  const summary = summaryOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 2);
  assert.equal(distance.kind, 'distance');
  assert.equal(distance.unit, 'm');
  assert.equal(distance.value, 5);
  assert.deepEqual(distance.start, { x: 1, y: 1 });
  assert.equal(area.kind, 'area');
  assert.equal(area.unit, 'm2');
  assert.equal(area.value, 10);
  assert.equal(area.perimeter, 13);
  assert.equal(area.perimeterUnit, 'm');
  assert.equal(area.vertexCount, 4);
  assert.deepEqual(summary.byKind, { distance: { count: 1, unit: 'm' }, area: { count: 1, unit: 'm2', perimeterUnit: 'm' } });
  assert.equal(summary.markupModelId, 'A');
  assert.deepEqual(summary.currentDrawing.plane, { axis: 'down', position: 3.2, flipped: false, customPlane: false });
  assert.match(summary.limitations, /not tagged with the section/);
});

test('#6833 drawingMeasurements: native totals stay exact when rows are sampled', () => {
  const results = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, start: { x: 0, y: 0 }, end: { x: i + 1, y: 0 }, distance: i + 1 }));
  useViewerStore.setState({ measure2DResults: results });
  const snapshot = captureEvidence('drawingMeasurements');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 120);
  assert.equal(payload.evidence.summary.byKind.distance.count, 120);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
});

test('#6833 drawingMeasurements: new markup, a regenerated drawing or a model edit makes the evidence stale', () => {
  measureOnDrawing();
  let snapshot = captureEvidence('drawingMeasurements');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.getState().removeMeasure2DResult(useViewerStore.getState().measure2DResults[0].id);
  assert.equal(evidenceIsCurrent(snapshot), false, 'the distance list was replaced');

  snapshot = captureEvidence('drawingMeasurements');
  useViewerStore.getState().setDrawing2D({ ...drawing });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a regenerated drawing');

  snapshot = captureEvidence('drawingMeasurements');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a model edit');
});

test('#6833 drawingMeasurements: the Drawing panel header attaches this source', async () => {
  measureOnDrawing();
  // The panel's own shell-test seed: no parsed store (symbolic parsing needs real source bytes) and no
  // drawing yet, so the panel mounts without the runtime host; the markup is what is discussed.
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('A'), ifcDataStore: null } as unknown as FederatedModel),
    modelPlacement: emptyPlacementState(), ifcDataStore: null, drawing2D: null, drawing2DStatus: 'idle',
    drawing2DPanelVisible: true, activeTool: 'select', annotation2DActiveTool: 'none' });
  const ui = render(renderPanelBody('drawing', () => undefined));
  // The Drawing panel is lazy; its header mounts once the chunk resolves.
  await waitFor(() => ui.querySelector('button[aria-label="Discuss with AI"]') !== null, 'Discuss with AI in the Drawing header');
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'drawingMeasurements');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 2);
});
