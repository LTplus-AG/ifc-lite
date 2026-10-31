/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { render, cleanup, click, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { KmzExportDialog } from './KmzExportDialog';
import '@/lib/retained/retainedLoad';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); useViewerStore.setState(initial); });
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
  assert.ok(found, label);
  return found;
}

// #8415: disabling a ribbon trigger cannot protect a dialog that is already open.
it('refuses KMZ submission after an open exact-model dialog becomes incomplete retained', async () => {
  const geometryResult: GeometryResult = {
    meshes: [{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3,
  };
  const model = { ...fixtureModel('m'), ifcDataStore: await parseFixtureModel(), geometryResult };
  useViewerStore.setState({ ...fixtureModels(model), georefMutations: new Map([['m', {
    mapConversion: { eastings: 8, northings: 47, orthogonalHeight: 0 },
    projectedCRS: { name: 'EPSG:4326' },
  }]]) });
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  const exporter = mock.method(GeometryProcessor.prototype, 'exportKmzFromMeshes',
    () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  render(<KmzExportDialog surface="ribbon" />);
  click(button('Export KMZ'));
  act(() => useViewerStore.setState({ models: new Map([['m', { ...model,
    retainedGeometry: { kernel: 'retained', candidates: 2, published: 1, cancelled: 0,
      completeness: 'incomplete', refused: [{ expressId: 2, ifcType: 'IfcWall', code: 'refused' }],
      obligationsUnmet: [] },
  }]]) }));
  click(button('Export'));
  await advance(100);
  assert.equal(exporter.mock.callCount(), 0, 'partial meshes must not reach the KMZ assembler');
  assert.deepEqual(downloadedNames(), [], 'no partial KMZ is downloaded');
  assert.match(document.body.textContent ?? '', /Unavailable while retained geometry or presentation is incomplete/);
});
