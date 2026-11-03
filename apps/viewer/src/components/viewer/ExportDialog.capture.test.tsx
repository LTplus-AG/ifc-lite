/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8568: exports with a Gaussian capture loaded are explicit. A capture's model
 * has an empty synthetic data store and no meshes, so walking it would write an
 * empty IFC or silently drop it. Export dialogs never offer it as a source,
 * leave it out of merged exports, and say that captures are not included.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type FederatedModel } from '@/store';
import { render, cleanup, click, waitFor, press, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { ExportDialog } from './ExportDialog';
import { MergedExporter } from '@ifc-lite/export';
import { UsdExportDialog } from './UsdExportDialog';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { GLBExportDialog } from './GLBExportDialog';
import { listExportModels } from './export-model-selection';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function captureModel(id: string): FederatedModel {
  return {
    ...fixtureModel(id, { entities: [] }),
    gaussianSplat: {
      handle: Object.freeze({ id: 1, modelIndex: 1 }), format: 'splat', count: 3, shDegree: 0,
      sourceCenterBounds: { min: [0, 0, 0], max: [1, 1, 1] }, placement: IDENTITY,
      placementOrigin: 'source', calibration: 'uncalibrated',
    },
  } as FederatedModel;
}

const NOTICE = '1 Gaussian capture is loaded. Capture data is not included in exports. BCF snapshots can show visible captures.';
const notice = () => document.querySelector('[data-testid="capture-export-notice"]')?.textContent ?? null;
const choices = () => [...document.querySelectorAll('[role="combobox"]')].map(node => node.textContent ?? '');
const openDialog = (ui: HTMLElement, label: string) =>
  click([...ui.querySelectorAll('button')].find(button => button.textContent?.includes(label))!);

afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); });

describe('exports with a Gaussian capture loaded (#8568)', () => {
  it('the export model list never offers a capture', () => {
    const models = fixtureModels(fixtureModel('house.ifc'), captureModel('plant.splat')).models;
    assert.deepEqual(listExportModels(models, new Set(), null).map(model => model.id), ['house.ifc']);
    assert.deepEqual(listExportModels(fixtureModels(captureModel('plant.splat')).models, new Set(), null), []);
  });

  it('Export IFC exports the IFC model, not the active capture, and says the capture is left out', async () => {
    const ifcDataStore = await parseFixtureModel();
    const ifc = { ...fixtureModel('house.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(ifc, captureModel('plant.splat')), activeModelId: 'plant.splat', dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openDialog(ui, 'Export IFC');
    assert.equal(notice(), NOTICE);
    assert.ok(choices().some(text => text.includes('house.ifc')), `the IFC model is the source: ${JSON.stringify(choices())}`);
    assert.ok(!choices().some(text => text.includes('plant.splat')), 'the capture is never the export source');
    const action = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export');
    assert.ok(action && !action.disabled);
    click(action);
    await waitFor(() => downloadedNames().length === 1, 'the IFC export did not download');
    assert.match(downloadedNames()[0], /^house.*\.ifc$/);
  });

  it('merged STEP only consults IFC participants for portability and visibility (#8745)', async () => {
    const ifcDataStore = await parseFixtureModel();
    const first = { ...fixtureModel('house.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
    const second = { ...fixtureModel('annex.ifc', { idOffset: 1_000_000 }), ifcDataStore, schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(first, second, captureModel('plant.splat')), dirtyModels: new Set() });
    const resources = mock.method(modelAppearanceAssets, 'exportResources');
    const merge = mock.method(MergedExporter.prototype, 'exportBlobAsync');
    const ui = render(<ExportDialog surface="ribbon" />);
    openDialog(ui, 'Export IFC');
    const scope = [...document.querySelectorAll('[role="combobox"]')].find(node => node.textContent?.includes('Single Model'));
    assert.ok(scope);
    press(scope, 'ArrowDown'); await advance(10);
    const merged = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('Merged (All Models)'));
    assert.ok(merged);
    click(merged); await advance(10);
    const visibleOnly = document.querySelector('[role="switch"]');
    assert.ok(visibleOnly);
    click(visibleOnly);
    click([...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export')!);
    await waitFor(() => downloadedNames().length === 1, 'merged IFC export did not download');
    assert.match(downloadedNames()[0], /_merged\.ifc$/);
    for (const spy of [resources]) {
      const ids = spy.mock.calls.map(call => call.arguments[0]);
      assert.ok(ids.includes(first.id) && ids.includes(second.id), 'both IFC models participate');
      assert.ok(!ids.includes('plant.splat'), 'capture is never consulted by export guards');
    }
    const options = merge.mock.calls[0].arguments[0];
    assert.deepEqual([...options.hiddenEntityIdsByModel!.keys()], [first.id, second.id]);
    assert.deepEqual([...options.isolatedEntityIdsByModel!.keys()], [first.id, second.id]);
  });

  it('USD offers the STEP source and excludes Gaussian PLY and splat sources (#8745)', () => {
    const ifc = { ...fixtureModel('house.ifc'), sourceFile: new File(['IFC'], 'house.ifc') };
    const captures = ['plant.splat', 'plant.ply'].map(id => ({ ...captureModel(id), sourceFile: new File(['capture'], id) }));
    useViewerStore.setState({ ...fixtureModels(ifc, ...captures), dirtyModels: new Set() });
    const ui = render(<UsdExportDialog surface="ribbon" />);
    openDialog(ui, 'Export USD');
    const text = document.querySelector('[data-export-dialog-shell]')?.textContent ?? '';
    assert.match(text, /house/);
    assert.doesNotMatch(text, /plant/);
    assert.match(notice() ?? '', /BCF snapshots can show visible captures/);
    const action = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export');
    assert.ok(action && !action.disabled);
  });

  it('with only a capture loaded, Export IFC offers nothing to export and says why', () => {
    useViewerStore.setState({ ...fixtureModels(captureModel('plant.splat')), activeModelId: 'plant.splat', dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openDialog(ui, 'Export IFC');
    assert.equal(notice(), NOTICE);
    assert.ok(!choices().some(text => text.includes('plant.splat')));
    const action = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export');
    assert.ok(!action || action.disabled, 'no capture is exported as an empty IFC');
  });

  it('the glTF export dialog leaves the capture out and says so; without one it says nothing', () => {
    useViewerStore.setState({ ...fixtureModels(captureModel('plant.splat'), fixtureModel('house.ifc')), dirtyModels: new Set() });
    let ui = render(<GLBExportDialog surface="ribbon" trigger={<button type="button">Open glTF export</button>} />);
    openDialog(ui, 'Open glTF export');
    assert.equal(notice(), NOTICE);
    // One exportable model: no picker, and the pending download is named for the IFC model.
    const preview = [...document.querySelectorAll('[data-export-dialog-shell] .font-mono')].map(node => node.textContent ?? '');
    assert.ok(preview.some(text => text.startsWith('house')), `the IFC model is the source: ${JSON.stringify(preview)}`);
    assert.ok(![...choices(), ...preview].some(text => text.includes('plant')), 'the capture is never the source');
    cleanup();
    useViewerStore.setState({ ...fixtureModels(fixtureModel('house.ifc')) });
    ui = render(<GLBExportDialog surface="ribbon" trigger={<button type="button">Open glTF export</button>} />);
    openDialog(ui, 'Open glTF export');
    assert.equal(notice(), null);
  });
});
