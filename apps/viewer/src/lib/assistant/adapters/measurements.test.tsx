/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import type { MeasurePoint } from '@/store/types';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const mp = (x: number, y: number, z: number): MeasurePoint => ({ x, y, z, screenX: 0, screenY: 0 });
interface Row { kind: string; id: string; value: number | null; unit: string; status: string; stale: boolean;
  closed?: boolean; outcome?: string; angleKind?: string; diameter?: number | null; vertical?: number; reason?: string }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

/** A 2 m radius arc sampled at four points in the ground plane (renderer Y-up). */
const ARC = [0, 0.5, 1, 1.5].map((a) => mp(2 * Math.cos(a), 0, 2 * Math.sin(a)));

function seedAllKinds(): void {
  // Real store actions: a drag distance, a finished polyline, a self-finishing angle and a radius fit.
  const s = useViewerStore.getState();
  s.startMeasurement(mp(0, 0, 0));
  s.updateMeasurement(mp(3, 4, 0));
  s.finalizeMeasurement();
  s.setMeasureMode('polyline');
  s.startPolyline(mp(0, 0, 0));
  s.addPolylinePoint(mp(3, 0, 0));
  s.addPolylinePoint(mp(3, 0, 4));
  assert.ok(useViewerStore.getState().finishPolyline(true));
  s.setMeasureMode('angle');
  s.setAngleKind('points');
  s.addAnglePick({ kind: 'points', point: mp(0, 0, 0) });
  s.addAnglePick({ kind: 'points', point: mp(1, 0, 0) });
  s.addAnglePick({ kind: 'points', point: mp(0, 0, 1) });
  s.setMeasureMode('radius');
  s.startRadius(ARC[0]);
  for (const point of ARC.slice(1)) useViewerStore.getState().addRadiusPoint(point);
  assert.ok(useViewerStore.getState().finishRadius());
}

test('#6833 measurements: no finished measurement is unavailable, never an empty clean result', () => {
  const snapshot = captureEvidence('measurements');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 measurements: each kind keeps its own value and unit, derived by the panel maths', () => {
  seedAllKinds();
  const snapshot = captureEvidence('measurements');
  const rows = rowsOf(snapshot.payload);
  const summary = summaryOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 4);
  assert.deepEqual(rows.map((row) => [row.kind, row.unit]), [['distance', 'm'], ['polyline', 'm'], ['angle', 'deg'], ['radius', 'm']]);
  const [distance, polyline, angle, radius] = rows;
  assert.ok(Math.abs((distance.value ?? 0) - 5) < 1e-9);
  assert.ok(Math.abs((distance.vertical ?? 0) - 4) < 1e-9, 'renderer Y is up: the 4 m rise is vertical');
  assert.equal(polyline.closed, true);
  assert.ok(Math.abs((polyline.value ?? 0) - 12) < 1e-9, 'closed 3-4-5 perimeter');
  assert.equal(angle.angleKind, 'points');
  assert.equal(angle.outcome, 'angled');
  assert.ok(Math.abs((angle.value ?? 0) - 90) < 1e-6);
  assert.equal(radius.outcome, 'fitted');
  assert.ok(Math.abs((radius.value ?? 0) - 2) < 1e-6);
  assert.ok(Math.abs((radius.diameter ?? 0) - 4) < 1e-6);
  // Per-kind counts and units; no cross-kind total exists anywhere in the summary.
  assert.deepEqual(Object.keys(summary.byKind), ['distance', 'polyline', 'angle', 'radius']);
  assert.equal(summary.byKind.angle.unit, 'deg');
  assert.ok(Math.abs(summary.byKind.distance.currentTotal - 5) < 1e-9);
  assert.equal('total' in summary, false);
  assert.match(summary.limitations, /never summed/);
});

test('#6833 measurements: placement-stale rows are flagged and leave the current distance total', () => {
  seedAllKinds();
  const { measurements, polylineMeasurements } = useViewerStore.getState();
  useViewerStore.setState({ placementStaleMeasurements: new Set([measurements[0].id, polylineMeasurements[0].id]) });
  const snapshot = captureEvidence('measurements');
  const [distance, polyline, angle] = rowsOf(snapshot.payload);
  assert.equal(distance.stale, true);
  assert.equal(distance.status, 'stale');
  assert.equal(polyline.stale, true);
  assert.equal(angle.stale, false);
  const summary = summaryOf(snapshot.payload);
  assert.equal(summary.byKind.distance.stale, 1);
  assert.equal(summary.byKind.distance.currentTotal, 0);
});

test('#6833 measurements: native totals stay exact when rows are sampled', () => {
  const measurements = Array.from({ length: 130 }, (_, i) => ({ id: `d${i}`, start: mp(0, 0, 0), end: mp(i + 1, 0, 0), distance: i + 1 }));
  useViewerStore.setState({ measurements });
  const snapshot = captureEvidence('measurements');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 130);
  assert.equal(payload.evidence.summary.measurementCount, 130);
  assert.equal(payload.evidence.summary.byKind.distance.count, 130);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
});

test('#6833 measurements: a new or deleted measurement, a placement move or an edit makes the evidence stale', () => {
  seedAllKinds();
  let snapshot = captureEvidence('measurements');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.getState().deleteAngleMeasurement(useViewerStore.getState().angleMeasurements[0].id);
  assert.equal(evidenceIsCurrent(snapshot), false, 'the angle list was replaced');

  snapshot = captureEvidence('measurements');
  useViewerStore.setState({ placementStaleMeasurements: new Set(['any']) });
  assert.equal(evidenceIsCurrent(snapshot), false, 'stale flags changed');

  snapshot = captureEvidence('measurements');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a model edit');
});

test('#6833 measurements: the Measurements panel header attaches this source', () => {
  seedAllKinds();
  const ui = render(renderPanelBody('measurements', () => undefined));
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button, 'Discuss with AI in the Measurements header');
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'measurements');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 4);
});
