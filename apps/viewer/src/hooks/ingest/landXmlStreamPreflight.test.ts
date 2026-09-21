/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LandXmlStreamPreflightReducer } from './landXmlStreamPreflight.js';

function fragmentedRecord(record: string, value: unknown): Array<Record<string, unknown>> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const split = Math.max(1, Math.floor(encoded.byteLength / 2));
  return [
    { kind: 'metadata', metadata_kind: 'record_fragment', record, sequence: 0, continued: true, payload_utf8: [...encoded.slice(0, split)] },
    { kind: 'metadata', metadata_kind: 'record_fragment', record, sequence: 1, continued: false, payload_utf8: [...encoded.slice(split)] },
  ];
}

it('measures credited TIN surfaces without retaining the source document (#5050)', async () => {
  const reducer = new LandXmlStreamPreflightReducer();
  reducer.onHeader({ units: { linear_scale_to_meters: 1, elevation_scale_to_meters: 1 } });
  await reducer.onSurface({
    source_id: 'surface-1', ordinal: 1, source_path: 'LandXML/Surfaces/Surface[1]', properties: {}, definition_properties: {},
    name: 'survey', kind: 'tin', render_state: 'rendered', topology_origin: 'authored_faces', terrain_diagnostic: null,
    hidden_face_count: 0,
    points: [
      { source_id: 'surface-1:p1', id: '1', northing: 5_000_000, easting: 2_600_000, elevation: 100 },
      { source_id: 'surface-1:p2', id: '2', northing: 5_000_010, easting: 2_600_000, elevation: 100 },
      { source_id: 'surface-1:p3', id: '3', northing: 5_000_000, easting: 2_600_010, elevation: 102 },
    ],
    canonical_vertices: [], source_data_points: [], faces: [['1', '2', '3']], face_source_ids: ['surface-1:f1'],
    face_visibility: [true], boundaries: [], breaklines: [], contours: [],
  });
  await reducer.onEvent({
    kind: 'metadata', metadata_kind: 'header', terrain: { coordinate_system: { horizontal_datum: 'EPSG:2056', vertical_datum: 'EPSG:5728' } },
    pipe_networks: { schema: 'LandXML-1.2', version: '1.2', capability_diagnostics: [], root_units: null, collections: [], features: [], networks: [], refusals: [] },
  });
  await reducer.onEvent({
    kind: 'metadata', metadata_kind: 'record', record: 'plan_cogo_point',
    value: { point: { northing: 5_000_100, easting: 2_600_200, elevation: null } },
  });
  await reducer.onEvent({
    kind: 'metadata', metadata_kind: 'record', record: 'horizontal_alignment',
    value: { segments: [{ primitive: {
      kind: 'irregular_line',
      start: { kind: 'coordinates', point: { northing: 5_000_200, easting: 2_600_300, elevation: 101 } },
      end: { kind: 'point_reference', pnt_ref: 'missing' },
      points: [{ northing: 5_000_250, easting: 2_600_350, elevation: null }],
    } }] },
  });
  await reducer.onEvent({ kind: 'metadata', metadata_kind: 'end' });
  const reduced = reducer.finish();
  assert.equal(reduced.preflight.componentCount, 1);
  assert.equal(reduced.sourceCoordinateInfo.hasLargeCoordinates, true);
  assert.equal(reduced.sourceCoordinateInfo.originalBounds.max.x, 2_600_350);
  assert.equal(reduced.sourceCoordinateInfo.originalBounds.min.z, -5_000_250);
  assert.deepEqual(reduced.coordinateSystem, { horizontalDatum: 'EPSG:2056', verticalDatum: 'EPSG:5728' });
});

it('reassembles fragmented coordinate-bearing metadata before source-frame measurement (#5161)', async () => {
  const reducer = new LandXmlStreamPreflightReducer();
  reducer.onHeader({ units: { linear_scale_to_meters: 1, elevation_scale_to_meters: 1 } });
  await reducer.onEvent({
    kind: 'metadata', metadata_kind: 'header', terrain: { coordinate_system: null },
    pipe_networks: { schema: 'LandXML-1.2', version: '1.2', capability_diagnostics: [], root_units: null, collections: [], features: [], networks: [], refusals: [] },
  });
  for (const event of fragmentedRecord('plan_cogo_point', {
    point: { northing: 5_000_100, easting: 2_600_100, elevation: 10 },
  })) await reducer.onEvent(event);
  for (const event of fragmentedRecord('plan_resolved_monument', {
    point: { northing: 5_000_150, easting: 2_600_150, elevation: 15 },
  })) await reducer.onEvent(event);
  for (const event of fragmentedRecord('plan_resolved_geometry', {
    start: { northing: 5_000_200, easting: 2_600_200, elevation: 20 },
    end: { northing: 5_000_300, easting: 2_600_300, elevation: 30 },
  })) await reducer.onEvent(event);
  for (const event of fragmentedRecord('horizontal_alignment', {
    segments: [{ primitive: {
      start: { kind: 'coordinates', point: { northing: 5_000_400, easting: 2_600_400, elevation: 40 } },
      end: { kind: 'coordinates', point: { northing: 5_000_500, easting: 2_600_500, elevation: 50 } },
    } }],
  })) await reducer.onEvent(event);
  await reducer.onEvent({ kind: 'metadata', metadata_kind: 'end' });
  const reduced = reducer.finish();
  assert.equal(reduced.sourceCoordinateInfo.hasLargeCoordinates, true);
  assert.deepEqual(reduced.sourceCoordinateInfo.originalBounds, {
    min: { x: 2_600_100, y: 10, z: -5_000_500 },
    max: { x: 2_600_500, y: 50, z: -5_000_100 },
  });
});
