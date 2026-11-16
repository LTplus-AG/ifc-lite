/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { fitRadius } from '@/components/viewer/tools/measure-modes/radius';
import { threePointAngle } from '@/components/viewer/tools/measure-modes/three-point-angle';
import { viewerOperation, pointSchema } from './contract';
import { metadata, idSchema, checkpoint } from './analytics-common';
const point = ([x, y, z]: [number, number, number]) => ({ x, y, z, screenX: 0, screenY: 0 });
function idle() {
  if (!isToolAvailable('measure')) throw new Error('Measurement tools are disabled by the host.');
  const s = useViewerStore.getState();
  if (s.activeMeasurement || s.activePolyline || s.activeAngle || s.activeRadius) throw new Error('Finish or cancel the current interactive measurement first.');
}
const output = { type: 'object', properties: { id: { type: 'string' }, measurement: { type: 'object' }, outcome: { type: 'object' } }, required: ['id', 'measurement', 'outcome'], additionalProperties: false };
export const analyticsMeasurementOperations = [
  viewerOperation<{ points: [number, number, number][] }>(metadata('measurements.radius', 'measurements', 'Fit a circular edge from 3–1000 renderer Y-up metre picks using native radius fitting and completion. Report geometric refusal instead of a fabricated radius.', ['view'], output), {
    type: 'object', properties: { points: { type: 'array', items: pointSchema, minItems: 3, maxItems: 1000 } }, required: ['points'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number, number][] }>, (i, c) => {
    idle(); const picks = i.points.map(point); const outcome = fitRadius(picks); checkpoint(c);
    let id = '';
    c.commit(() => { const s = useViewerStore.getState(); s.startRadius(picks[0]); for (const p of picks.slice(1)) s.addRadiusPoint(p); if (!s.finishRadius()) { s.cancelRadius(); throw new Error('Native radius completion refused these picks.'); } id = useViewerStore.getState().radiusMeasurements.at(-1)?.id ?? ''; });
    return { id, measurement: useViewerStore.getState().radiusMeasurements.at(-1), outcome };
  }),
  viewerOperation<{ points: [number, number, number][] }>(metadata('measurements.angle', 'measurements', 'Create a three-point angle in renderer Y-up metres, with the apex as the FIRST point. Native calculation exposes degenerate and collinear outcomes explicitly.', ['view'], output), {
    type: 'object', properties: { points: { type: 'array', items: pointSchema, minItems: 3, maxItems: 3 } }, required: ['points'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number, number][] }>, (i, c) => {
    idle(); const picks = i.points.map(point); const outcome = threePointAngle(picks[0], picks[1], picks[2]); checkpoint(c);
    c.commit(() => { const s = useViewerStore.getState(); s.setAngleKind('points'); for (const p of picks) s.addAnglePick({ kind: 'points', point: p }); });
    const measurement = useViewerStore.getState().angleMeasurements.at(-1);
    if (!measurement) throw new Error('Native angle completion failed.'); return { id: measurement.id, measurement, outcome };
  }),
  viewerOperation<{ id: string; kind: 'polyline' | 'angle' | 'radius' }>(metadata('measurements.delete', 'measurements', 'Delete a completed polyline, angle or radius through its native action.', ['view'], { type: 'object', properties: { removed: { type: 'string' }, kind: { type: 'string' } }, required: ['removed', 'kind'], additionalProperties: false }), {
    type: 'object', properties: { id: idSchema.properties.id, kind: { type: 'string', enum: ['polyline', 'angle', 'radius'] } }, required: ['id', 'kind'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; kind: 'polyline' | 'angle' | 'radius' }>, (i, c) => {
    idle(); const s = useViewerStore.getState();
    const rows = i.kind === 'polyline' ? s.polylineMeasurements : i.kind === 'angle' ? s.angleMeasurements : s.radiusMeasurements;
    if (!rows.some(row => row.id === i.id)) throw new Error('Unknown completed measurement.');
    checkpoint(c); c.commit(() => { if (i.kind === 'polyline') s.deletePolylineMeasurement(i.id); else if (i.kind === 'angle') s.deleteAngleMeasurement(i.id); else s.deleteRadiusMeasurement(i.id); });
    return { removed: i.id, kind: i.kind };
  }),
];
