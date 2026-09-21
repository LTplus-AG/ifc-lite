/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LandXmlStreamDocumentAssembler, LandXmlSurfaceFragmentAssembler,
  type LandXmlSurfaceStreamFragment,
} from './landXmlStreamAssembler.js';

const encode = (value: unknown): number[] => Array.from(new TextEncoder().encode(JSON.stringify(value)));
const fragment = (
  component: LandXmlSurfaceStreamFragment['component'], value: unknown, sequence = 0, continued = false,
): LandXmlSurfaceStreamFragment => ({ source_id: 'surface-1', component, sequence, continued, payload_utf8: component === 'end' ? [] : encode(value) });

describe('LandXML streamed surface assembly (#5050)', () => {
  it('reassembles direct-equivalent source-ordered fragments without retaining completed payloads', () => {
    const assembler = new LandXmlSurfaceFragmentAssembler();
    assert.equal(assembler.push(fragment('start', {
      ordinal: 1, source_path: 'LandXML/Surfaces/Surface[1]', properties: {}, definition_properties: {},
      name: 'grade', kind: 'tin', render_state: 'rendered', topology_origin: 'authored_faces',
      terrain_diagnostic: null, hidden_face_count: 0,
    })), null);
    const point = { source_id: 'surface-1:point:1', id: '1', northing: 0, easting: 0, elevation: 0 };
    assert.equal(assembler.push(fragment('points', point)), null);
    assert.equal(assembler.push(fragment('faces', { ids: ['1', '2', '3'], source_id: 'surface-1:face:1', visible: true })), null);
    const complete = assembler.push(fragment('end', null));
    assert.deepEqual(complete, {
      source_id: 'surface-1', ordinal: 1, source_path: 'LandXML/Surfaces/Surface[1]', properties: {}, definition_properties: {},
      name: 'grade', kind: 'tin', render_state: 'rendered', topology_origin: 'authored_faces', terrain_diagnostic: null,
      hidden_face_count: 0, points: [point], canonical_vertices: [], source_data_points: [],
      faces: [['1', '2', '3']], face_source_ids: ['surface-1:face:1'], face_visibility: [true], boundaries: [], breaklines: [], contours: [],
    });
    assert.equal(assembler.hasPendingSurface, false);
    assert.equal(assembler.pendingBytes, 0);
  });

  it('rejects malformed continuation tails and releases them on abort', () => {
    const assembler = new LandXmlSurfaceFragmentAssembler();
    assembler.push(fragment('start', {
      ordinal: 1, source_path: 'p', properties: {}, definition_properties: {}, name: 'grade', kind: 'tin',
      render_state: 'rendered', topology_origin: 'authored_faces', terrain_diagnostic: null, hidden_face_count: 0,
    }));
    const partial = fragment('points', { id: '1' }, 0, true);
    assembler.push(partial);
    assert.throws(() => assembler.push(fragment('points', { id: '2' }, 2)), /continuation sequence/);
    assembler.abort();
    assert.equal(assembler.hasPendingSurface, false);
    assert.equal(assembler.pendingBytes, 0);
  });

  it('moves streamed records into credited metadata and keeps End payload-free', () => {
    const assembler = new LandXmlStreamDocumentAssembler();
    const start = {
      kind: 'surface', source_id: 'surface-1', component: 'start', sequence: 0, continued: false,
      payload_utf8: encode({ ordinal: 1, source_path: 'p', properties: {}, definition_properties: {}, name: 'grade', kind: 'tin', render_state: 'rendered', topology_origin: 'authored_faces', terrain_diagnostic: null, hidden_face_count: 0 }),
    };
    assembler.push(start);
    const surface = assembler.push({ kind: 'surface', source_id: 'surface-1', component: 'end', sequence: 0, continued: false, payload_utf8: [] }).surface;
    assert.equal(surface?.source_id, 'surface-1');
    const terrain = {
      format: 'landxml', schema: 'LandXML-1.2', capabilities: {}, version: '1.2', units: null, surfaces: [],
      extensions: [], warnings: [], alignments: [], profiles: [], cross_sections: [], cross_section_surfaces: [], roadways: [], capability_diagnostics: [], preserved_only_extensions: [], pipe_networks: null,
    };
    const header = assembler.push({
      kind: 'metadata', metadata_kind: 'header', stream: {}, terrain,
      plan: { cogo_points: [], monuments: [], plan_features: [], parcels: [], warnings: [], source_batches: [], parcel_probes: [], resolved_monuments: [], resolved_geometry: [] },
      alignments: { alignments: [], warnings: [] }, pipe_networks: { collections: [], features: [], networks: [], refusals: [] },
    });
    assert.equal(header.document, null);
    assembler.push({ kind: 'metadata', metadata_kind: 'record', record: 'terrain_warning', value: 'kept' });
    assembler.push({ kind: 'metadata', metadata_kind: 'record', record: 'plan_source_batch', value: { source_ids: ['p-1'] } });
    assembler.push({ kind: 'metadata', metadata_kind: 'record', record: 'alignment_render_truncated', value: true });
    const complete = assembler.push({
      kind: 'metadata', metadata_kind: 'end',
    }).document;
    assert.equal((complete?.tin.surfaces as unknown[]).length, 1);
    assert.deepEqual(complete?.tin.warnings, ['kept']);
    assert.deepEqual((complete?.tin.plan as { source_batches: unknown[] }).source_batches, [{ source_ids: ['p-1'] }]);
    assert.equal(complete?.alignment_render_truncated, true);
  });
});
