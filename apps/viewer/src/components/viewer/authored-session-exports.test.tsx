/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GLB's neighbours in File > Export on the same authored session (#9026 item 18).
 * Each of these reads the session rather than the file as loaded (KMZ and the PDF
 * from the held meshes, Cesium ion through the mutation view), so they never had
 * GLB's defect. These pin that against the real engine: the blank model, the
 * authoring actions and the exporters are all real; only the upload is stubbed.
 */
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { IfcParser } from '@ifc-lite/parser';
import { skip, blankFile, load } from '@/test/blank-ifc-loader-harness.js';
import '@/test/download-capture';
import { render, cleanup, click, waitFor, advance, type as typeInto } from '@/test/render';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { addCurtainWallIn } from '@/store/slices/mutation-curtain-grid.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { readViewPdfSource } from '@/lib/export/view-pdf/view-pdf-export-source';
import { collectViewMeshes } from '@/lib/export/view-pdf/collect-view-meshes';
import type { IonUploadInput } from '@/lib/geo/cesium-ion-upload';
import { KmzExportDialog } from './KmzExportDialog';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';

afterEach(cleanup);

const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  assert.ok(found, `button "${label}"`);
  return found;
};

/** A wall, a column and a curtain wall, meshed by the real engine. */
async function authoredSession() {
  const model = await load(blankFile('METRE'));
  const state = useViewerStore.getState();
  const storey = model.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
  assert.ok(storey, 'the blank file has a storey');
  assert.ok(modelEditTarget(state, model.id), 'the canonical modelling command opens its mutation view');
  const wall = state.addWall(model.id, storey, { Start: [2, 3, 0], End: [6, 3, 0], Thickness: 0.2, Height: 3 });
  const column = state.addColumn(model.id, storey, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 });
  const curtain = addCurtainWallIn(useViewerStore, model.id, storey, { Start: [0, 0, 0], End: [6, 0, 0], Height: 3 });
  assert.ok('expressId' in wall && 'expressId' in column && 'expressId' in curtain, 'elements must be created');
  const ids = [wall.expressId, column.expressId, ...curtain.partIds];
  assert.equal((await requestRemesh(useViewerStore.getState, model.id, ids, 'created')).status, 'applied');
  return { model, ids, panels: curtain.build.panelIds.length, members: curtain.partIds.length - curtain.build.panelIds.length };
}

/** Click the KMZ dialog at its defaults. */
async function exportKmz(): Promise<{ bytes: Uint8Array | null; text: string }> {
  let saved: Blob | null = null;
  mock.method(URL, 'createObjectURL', (blob: Blob) => { saved = blob; return 'blob:ifc-lite-test-kmz'; });
  render(<KmzExportDialog surface="ribbon" />);
  click(button('Export KMZ'));
  await advance(1);
  click(button('Export'));
  // The dialog's web notice is itself an alert, so a refusal is read by its title.
  await waitFor(() => saved !== null || /has no georeferencing/.test(document.body.textContent ?? ''), 'the KMZ export finished neither way');
  const text = document.body.textContent ?? '';
  const blob = saved as Blob | null;
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  cleanup();
  return { bytes, text };
}

describe('other File > Export geometry exports on an authored session (#9026 item 18)', () => {
  it('KMZ: a georeferenced session writes a COLLADA model of everything authored', { skip }, async () => {
    const { model, ids } = await authoredSession();
    const authored = new Set(ids.map((id) => toGlobalIdFromModels(useViewerStore.getState().models, model.id, id)));
    const meshes = useViewerStore.getState().models.get(model.id)?.geometryResult?.meshes.filter((mesh) => authored.has(mesh.expressId)) ?? [];
    assert.equal(new Set(meshes.map((mesh) => mesh.expressId)).size, ids.length, 'every authored element is meshed');
    useViewerStore.setState({
      georefMutations: new Map([[model.id, {
        mapConversion: { eastings: 8, northings: 47, orthogonalHeight: 0 },
        projectedCRS: { name: 'EPSG:4326' },
      }]]),
    });
    const { bytes, text } = await exportKmz();
    assert.ok(bytes, `no file was written: ${text}`);
    const dae = new TextDecoder().decode(unzipSync(bytes)['model.dae']);
    // COLLADA merges meshes into chunks, so the triangles are what can be counted.
    const triangles = [...dae.matchAll(/<triangles[^>]*count="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    assert.equal(triangles, meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), 'the model holds every authored triangle');
  });

  it('KMZ: without a georeference it says that, not that there is no geometry', { skip }, async () => {
    await authoredSession();
    const { bytes, text } = await exportKmz();
    assert.equal(bytes, null);
    assert.match(text, /has no georeferencing/);
  });

  it('Cesium ion: the uploaded IFC carries every authored element', { skip }, async () => {
    const { panels, members } = await authoredSession();
    let sent: IonUploadInput | undefined;
    render(<CesiumIonExportDialog surface="ribbon" upload={async (input) => { sent = input; return { assetId: 1 }; }} />);
    click(button('Upload to Cesium ion'));
    const token = document.querySelector<HTMLInputElement>('#ion-token');
    assert.ok(token);
    typeInto(token, 'private-test-token');
    click(button('Upload'));
    await waitFor(() => !!sent, 'nothing was uploaded');
    assert.ok(sent);
    const uploaded = await new IfcParser().parseColumnar(sent.bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const count = (type: string) => uploaded.entityIndex.byType.get(type)?.length ?? 0;
    assert.equal(count('IFCWALL'), 1);
    assert.equal(count('IFCCOLUMN'), 1);
    assert.equal(count('IFCCURTAINWALL'), 1);
    assert.equal(count('IFCPLATE'), panels);
    assert.equal(count('IFCMEMBER'), members);
  });

  it('PDF: the drawn mesh set is the authored elements', { skip }, async () => {
    const { model, ids } = await authoredSession();
    const state = useViewerStore.getState();
    const drawn = new Set(collectViewMeshes(readViewPdfSource(state).view).map((mesh) => mesh.expressId));
    const expected = ids.map((id) => toGlobalIdFromModels(state.models, model.id, id));
    assert.deepEqual([...drawn].sort((a, b) => a - b), expected.sort((a, b) => a - b));
  });
});
