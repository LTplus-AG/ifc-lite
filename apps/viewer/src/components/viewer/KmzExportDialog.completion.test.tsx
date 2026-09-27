/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { KmzExportDialog } from './KmzExportDialog';

afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); });

it('records one KMZ completion after each successful dialog download (#5844)', async () => {
  const ifcDataStore = await parseFixtureModel();
  const mesh: MeshData = {
    expressId: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as MeshData;
  const geometryResult = { meshes: [mesh] } as GeometryResult;
  const model = { ...fixtureModel('m'), name: 'model.ifc', ifcDataStore, geometryResult };
  useViewerStore.setState({
    ...fixtureModels(model), ifcDataStore,
    georefMutations: new Map([['m', {
      mapConversion: { eastings: 8, northings: 47, orthogonalHeight: 0 },
      projectedCRS: { name: 'EPSG:4326' },
    }]]),
  });
  mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  const exporter = mock.method(GeometryProcessor.prototype, 'exportKmzFromMeshes', () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  const completions: Record<string, unknown>[] = [];
  mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
    if (event === 'export_completed') completions.push(properties);
  });

  for (const surface of ['classic', 'ribbon', 'palette'] as const) {
    render(<KmzExportDialog surface={surface} />);
    const trigger = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export KMZ');
    assert.ok(trigger, `the ${surface} dialog trigger renders`);
    click(trigger);
    const before = downloadedNames().length;
    const exportButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export');
    assert.ok(exportButton, 'opening the dialog exposes its Export action');
    click(exportButton);
    await waitFor(() => downloadedNames().length === before + 1, `KMZ export from ${surface} did not download`);
    assert.equal(exporter.mock.callCount(), completions.length, 'each completion follows one real exporter call');
    assert.deepEqual(completions.at(-1), { format: 'kmz', surface, size_kb: 0 });
    assert.equal(completions.length, downloadedNames().length, 'one completion per browser download');
    cleanup();
  }
});
