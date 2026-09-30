/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

// #6575: renderer occurrences are not bounded by JavaScript's argument limit.
it('runs clash detection on 250,000 occurrences without dropping any', async () => {
  const bytes = new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;',
    "#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall',$,$,$,$,$,.STANDARD.);",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n'));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const count = 250_000;
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array([0, 1, 2]);
  const meshes: MeshData[] = Array.from({ length: count }, (_, index) => ({
    expressId: 1, occurrenceKey: `occurrence-${index}`, ifcType: 'IfcWall',
    positions, normals, indices, color: [0.5, 0.5, 0.5, 1],
  }));
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  const geometry: GeometryResult = {
    meshes, totalTriangles: count, totalVertices: count * 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false },
  };
  const model: FederatedModel = {
    id: 'large', name: 'large.ifc', ifcDataStore: store, geometryResult: geometry,
    visible: true, collapsed: false, schemaVersion: 'IFC4', loadedAt: 0,
    fileSize: bytes.length, idOffset: 0, maxExpressId: 1,
  };
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id });
  useViewerStore.getState().registerModelOffset(model.id, 1);
  let api: ReturnType<typeof useClash> | undefined;
  function Probe(): null { api = useClash(); return null; }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    assert.ok(api);
    await act(async () => {
      // Empty B makes this a linear coverage check instead of quadratic overlap work.
      await api!.run([{ id: 'coverage', name: 'Coverage', a: '*', b: 'IfcDuct', mode: 'hard' }]);
    });
    const state = useViewerStore.getState();
    assert.equal(state.clashError, null);
    assert.equal(state.clashRunning, false);
    assert.equal(state.clashResult?.ruleCoverage?.[0].matchedA, count);
    assert.equal(state.clashResult?.ruleCoverage?.[0].matchedB, 0);
    const keys = state.clashResult?.ruleCoverage?.[0].matchedKeysA;
    assert.equal(keys?.length, count);
    assert.ok(keys?.some(key => key.endsWith('occurrence-0')));
    assert.ok(keys?.some(key => key.endsWith(`occurrence-${count - 1}`)));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useViewerStore.getState().clearAllModels();
  }
});
