/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { pointCoordinates, relativeOffset } from '@/components/viewer/tools/measure-modes/coordinates';
import { distanceComponents } from '@/components/viewer/tools/measure-modes/components';
import { inclination, formatInclination } from '@/components/viewer/tools/measure-modes/inclination';
import { angleMeasurementOutcome } from '@/components/viewer/tools/measure-modes/readouts';
import { fitRadius } from '@/components/viewer/tools/measure-modes/radius';
import { selectAnchorGeoref } from '@/lib/geo/select-anchor-georef';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { viewerPointToProjected } from '@/lib/geo/pick-to-geo';
import { viewerOperation, emptySchema, pointSchema } from './contract';
import { metadata, checkpoint } from './analytics-common';
const point = ([x, y, z]: [number, number, number]) => ({ x, y, z, screenX: 0, screenY: 0 });
function gate() { if (!isToolAvailable('measure')) throw new Error('Measurement tools are disabled by the host.'); }
function idle() { gate(); const s = useViewerStore.getState(); if (s.activeMeasurement || s.activePolyline || s.activeAngle || s.activeRadius) throw new Error('Finish or cancel the interactive measurement first.'); return s; }
const settings = () => { const s = useViewerStore.getState(); return { mode: s.measureMode, angle_kind: s.angleKind, snap: s.snapEnabled, geo_readout: s.geoReadoutEnabled, visible: s.sceneState.measurements.visible, placed_point: s.measurePointLast }; };
const settingsOutput = { type: 'object', properties: { mode: { type: 'string' }, angle_kind: { type: 'string' }, snap: { type: 'boolean' }, geo_readout: { type: 'boolean' }, visible: { type: 'boolean' }, placed_point: { type: ['object', 'null'] } }, required: ['mode', 'angle_kind', 'snap', 'geo_readout', 'visible', 'placed_point'], additionalProperties: false };
const measurementOutput = { type: 'object', properties: { measurement: { type: 'object' }, outcome: { type: 'object' } }, required: ['measurement', 'outcome'], additionalProperties: false };
export const analyticsMeasurementSettingOperations = [
  viewerOperation(metadata('measurements.settings', 'measurements', 'Read native gesture/angle/snap/geo/visibility settings and the last numerical point placement.', ['read'], settingsOutput), emptySchema, settings),
  viewerOperation<{ mode: 'drag' | 'polyline' | 'angle' | 'radius' | 'point'; angle_kind: 'points' | 'edges' | 'faces'; snap: boolean; geo_readout: boolean; visible: boolean }>(metadata('measurements.configure', 'measurements', 'Apply actual native measurement mode/angle-family/snap/geo-readout/visibility controls. Mode changes use native gesture reset; geo readout requires a native anchor map conversion.', ['view', 'configuration'], settingsOutput), {
    type: 'object', properties: { mode: { type: 'string', enum: ['drag', 'polyline', 'angle', 'radius', 'point'] }, angle_kind: { type: 'string', enum: ['points', 'edges', 'faces'] }, snap: { type: 'boolean' }, geo_readout: { type: 'boolean' }, visible: { type: 'boolean' } }, required: ['mode', 'angle_kind', 'snap', 'geo_readout', 'visible'], additionalProperties: false,
  } satisfies JSONSchemaType<{ mode: 'drag' | 'polyline' | 'angle' | 'radius' | 'point'; angle_kind: 'points' | 'edges' | 'faces'; snap: boolean; geo_readout: boolean; visible: boolean }>, (i, c) => {
    gate(); const s = useViewerStore.getState();
    if (i.geo_readout && !selectAnchorGeoref({ models: s.models, legacyDataStore: s.ifcDataStore, legacyCoordinateInfo: s.geometryResult?.coordinateInfo, anchorModelIdOverride: s.anchorModelIdOverride, georefMutations: s.georefMutations })) throw new Error('No native anchor map conversion is available.');
    checkpoint(c); c.commit(() => { s.setMeasureMode(i.mode); s.setAngleKind(i.angle_kind); if (s.snapEnabled !== i.snap) s.toggleSnap(); if (s.geoReadoutEnabled !== i.geo_readout) s.toggleGeoReadout(); s.setMeasurementsVisible(i.visible); }); return settings();
  }),
  viewerOperation<{ point: [number, number, number] }>(metadata('measurements.placePoint', 'measurements', 'Place the native Point-mode readout at an explicit renderer Y-up metre coordinate, with native placement identity and reference offsets.', ['view'], settingsOutput), {
    type: 'object', properties: { point: pointSchema }, required: ['point'], additionalProperties: false,
  } satisfies JSONSchemaType<{ point: [number, number, number] }>, (i, c) => { const s = idle(); checkpoint(c); c.commit(() => { s.setMeasureMode('point'); s.placeMeasurePoint(point(i.point)); }); return settings(); }),
  viewerOperation<{ points: [number, number, number][] }>(metadata('measurements.angleEdges', 'measurements', 'Complete a native edge-pair angle from four explicit renderer Y-up metre picks (two endpoints per edge).', ['view'], measurementOutput), {
    type: 'object', properties: { points: { type: 'array', items: pointSchema, minItems: 4, maxItems: 4 } }, required: ['points'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number, number][] }>, (i, c) => { const s = idle(); checkpoint(c); c.commit(() => { s.setAngleKind('edges'); for (const p of i.points) s.addAnglePick({ kind: 'edges', point: point(p) }); }); const measurement = useViewerStore.getState().angleMeasurements.at(-1); if (!measurement) throw new Error('Native edge-angle completion failed.'); return { measurement, outcome: angleMeasurementOutcome(measurement) }; }),
  viewerOperation<{ points: [number, number, number][]; normals: [number, number, number][] }>(metadata('measurements.angleFaces', 'measurements', 'Complete a native face-normal angle from two explicit picks and two renderer-frame normals. Native degenerate/parallel outcomes remain explicit.', ['view'], measurementOutput), {
    type: 'object', properties: { points: { type: 'array', items: pointSchema, minItems: 2, maxItems: 2 }, normals: { type: 'array', items: pointSchema, minItems: 2, maxItems: 2 } }, required: ['points', 'normals'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number, number][]; normals: [number, number, number][] }>, (i, c) => { const s = idle(); checkpoint(c); c.commit(() => { s.setAngleKind('faces'); i.points.forEach((p, index) => { const [x, y, z] = i.normals[index]; s.addAnglePick({ kind: 'faces', point: point(p), normal: { x, y, z } }); }); }); const measurement = useViewerStore.getState().angleMeasurements.at(-1); if (!measurement) throw new Error('Native face-angle completion failed.'); return { measurement, outcome: angleMeasurementOutcome(measurement) }; }),
  viewerOperation(metadata('measurements.readouts', 'measurements', 'Derive the exact native distance components/inclination, angle/radius outcomes and local/world IFC or authored map coordinates for placed points. Infinite vertical slope is represented explicitly by percent_unbounded and a null numeric percent.', ['read'], { type: 'object', properties: { distances: { type: 'array' }, angles: { type: 'array' }, radii: { type: 'array' }, point: { type: ['object', 'null'] } }, required: ['distances', 'angles', 'radii', 'point'], additionalProperties: false }), emptySchema, () => {
    const s = useViewerStore.getState(); const frame = resolveRenderFrame(s.models, s.geometryResult); const placed = s.measurePointLast;
    const anchor = s.geoReadoutEnabled ? selectAnchorGeoref({ models: s.models, legacyDataStore: s.ifcDataStore, legacyCoordinateInfo: s.geometryResult?.coordinateInfo, anchorModelIdOverride: s.anchorModelIdOverride, georefMutations: s.georefMutations }) : null;
    const offset = anchor ? totalYupOffset(anchor.coordinateInfo) : null;
    return { distances: s.measurements.map(row => { const components = distanceComponents(row.start, row.end); const slope = inclination(components); return { id: row.id, distance: row.distance, components, inclination: { ...slope, percent: Number.isFinite(slope.percent) ? slope.percent : null, percent_unbounded: !Number.isFinite(slope.percent) }, formatted: formatInclination(slope) }; }),
      angles: s.angleMeasurements.map(row => ({ id: row.id, ...angleMeasurementOutcome(row) })), radii: s.radiusMeasurements.map(row => ({ id: row.id, outcome: fitRadius(row.points) })),
      point: placed ? { id: placed.id, coordinates: pointCoordinates(placed, frame), relative: s.measureReferencePoint ? relativeOffset(placed, s.measureReferencePoint) : null,
        projected: anchor && offset ? viewerPointToProjected(placed, anchor.eff, { x: -offset.x, y: -offset.y, z: -offset.z }) : null } : null };
  }),
];
