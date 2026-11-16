/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { viewerOperation as operation, emptySchema, pointSchema } from './contract';

const metadata = (id: string, description: string) => ({
  id, owner: 'measurements', description, effects: ['view'] as const,
  capability: 'commands-and-edits' as const, synchronous: true, implementation: 'native-store' as const,
});
function available() { if (!isToolAvailable('measure')) throw new Error('Measurement tools are disabled by the host.'); }
function idle() {
  available();
  const s = useViewerStore.getState();
  if (s.activeMeasurement || s.activePolyline || s.activeAngle || s.activeRadius) throw new Error('Finish or cancel the current interactive measurement first.');
}
const point = ([x, y, z]: [number, number, number]) => ({ x, y, z, screenX: 0, screenY: 0 });
function inspect() {
  const s = useViewerStore.getState();
  return { distances: s.measurements, polylines: s.polylineMeasurements, angles: s.angleMeasurements, radii: s.radiusMeasurements,
    referencePoint: s.measureReferencePoint, mode: s.measureMode, snapEnabled: s.snapEnabled, geoReadoutEnabled: s.geoReadoutEnabled };
}
export const measurementOperations = [
  operation({ ...metadata('measurements.read', 'Read numerical measurements and measurement settings.'), effects: ['read'], capability: 'read' }, emptySchema, inspect),
  operation<{ start: [number, number, number]; end: [number, number, number] }>(metadata('measurements.distance', 'Create a distance using two renderer Y-up metre points. Uses native measurement calculation and completion.'), {
    type: 'object', properties: { start: pointSchema, end: pointSchema }, required: ['start', 'end'], additionalProperties: false,
  } satisfies JSONSchemaType<{ start: [number, number, number]; end: [number, number, number] }>, i => {
    idle();
    const s = useViewerStore.getState();
    s.startMeasurement(point(i.start)); s.updateMeasurement(point(i.end)); s.finalizeMeasurement();
    return useViewerStore.getState().measurements.at(-1);
  }),
  operation<{ points: [number, number, number][]; closed: boolean }>(metadata('measurements.polyline', 'Create an open polyline or closed perimeter from renderer Y-up metre points. Uses native completion and length calculation.'), {
    type: 'object', properties: { points: { type: 'array', items: pointSchema, minItems: 2, maxItems: 1000 }, closed: { type: 'boolean' } },
    required: ['points', 'closed'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number, number][]; closed: boolean }>, i => {
    idle();
    if (i.closed && i.points.length < 3) throw new Error('A closed perimeter needs at least three points.');
    const s = useViewerStore.getState();
    const count = s.polylineMeasurements.length;
    s.startPolyline(point(i.points[0]));
    for (const p of i.points.slice(1)) s.addPolylinePoint(point(p));
    s.finishPolyline(i.closed);
    if (useViewerStore.getState().polylineMeasurements.length !== count + 1) {
      s.cancelPolyline();
      throw new Error('The native measurement service could not complete a polyline from these points.');
    }
    return useViewerStore.getState().polylineMeasurements.at(-1);
  }),
  operation<{ id: string }>(metadata('measurements.deleteDistance', 'Delete one existing native distance measurement.'), {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string }>, i => {
    available(); const s = useViewerStore.getState();
    if (!s.measurements.some(m => m.id === i.id)) throw new Error('Unknown distance measurement.');
    s.deleteMeasurement(i.id); return { removed: i.id };
  }),
  operation(metadata('measurements.clear', 'Clear completed measurements using native clear behavior; preserves reference point and mode.'), emptySchema,
    () => { available(); useViewerStore.getState().clearMeasurements(); return inspect(); }),
  operation<{ point: [number, number, number] }>(metadata('measurements.reference', 'Set the setting-out reference in renderer Y-up metres.'), {
    type: 'object', properties: { point: pointSchema }, required: ['point'], additionalProperties: false,
  } satisfies JSONSchemaType<{ point: [number, number, number] }>, i => {
    available(); const [x, y, z] = i.point; useViewerStore.getState().setMeasureReferencePoint({ x, y, z }); return inspect();
  }),
  operation(metadata('measurements.clearReference', 'Clear the setting-out reference.'), emptySchema,
    () => { available(); useViewerStore.getState().setMeasureReferencePoint(null); return inspect(); }),
];
