/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LandXmlStreamPreflightReducer } from './landXmlStreamPreflight.js';

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
