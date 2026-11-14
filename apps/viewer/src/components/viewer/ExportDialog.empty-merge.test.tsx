/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A merged STEP export of a federation with nothing writable in it is refused
 * with a reason, up front.
 *
 * The gate counted a model with no store as writable, on the stated grounds
 * that `ensureModelExportReady` would hydrate one at export time. It does not:
 * it returns `model.ifcDataStore` as it is. So a `.3dm` (tabular, no records)
 * beside a model still loading (no store yet) offered the export, both were
 * skipped by `buildMergeInputs`, and the merge was run over zero inputs.
 * Found on #9977's E2E sibling (#10044).
 *
 * No empty file was written: `MergedExporter`'s constructor refuses an empty
 * model list, so what the owner actually got was the export failing with
 * `MergedExporter requires at least one model` — an internal invariant, named
 * at them, in place of the dialog's own "no IFC records to write from".
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore, type FederatedModel } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { settle } from '@/test/settle';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { tabularFixtureStore } from '@/test/tabular-store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { chooseMerged, exportButton, openExportDialog, shellText } from './export-dialog-scope.test-support';
import { ExportDialog } from './ExportDialog';

/** A `.3dm`-shaped participant: a real `buildTabularDataStore` store. */
const tabularModel = (id: string, idOffset = 0): FederatedModel =>
  ({ ...fixtureModel(id, { idOffset }), schemaVersion: 'IFC4' as const, ifcDataStore: tabularFixtureStore() });

/** A model mid-load: in the federation and in the tree, with no store yet. */
const loadingModel = (id: string, idOffset: number): FederatedModel =>
  ({ ...fixtureModel(id, { idOffset }), schemaVersion: 'IFC4' as const, ifcDataStore: null });

async function openMerged(...models: FederatedModel[]): Promise<void> {
  useViewerStore.setState({ ...fixtureModels(...models), dirtyModels: new Set() });
  const ui = render(<ExportDialog surface="ribbon" />);
  openExportDialog(ui, 'Export IFC');
  await chooseMerged();
}

afterEach(() => { cleanup(); clearDownloads(); });

describe('a merged STEP export with nothing writable is refused', () => {
  it('refuses a .3dm beside a still-loading model instead of writing "Merged 0 models"', async () => {
    await openMerged(tabularModel('terrain.3dm'), loadingModel('tower.ifc', 1_000_000));

    assert.equal(exportButton().disabled, true, 'there is no store to write STEP from, so the export is not offered');
    assert.match(shellText(), /no IFC records to write from/, 'the dialog says why it cannot export');

    click(exportButton());
    // Negative assertion, so it settles on event-loop turns rather than a
    // wall-clock budget that would pass vacuously under load (`@/test/settle`).
    await act(() => settle('the export dialog did not settle after the click'));
    assert.deepEqual(downloadedNames(), [], 'a merged export with no writable model wrote a file');
  });

  it('still merges the models it can when one of them is still loading', async () => {
    const house = { ...fixtureModel('house.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
    await openMerged(house, tabularModel('terrain.3dm', 1_000_000), loadingModel('tower.ifc', 2_000_000));

    assert.equal(exportButton().disabled, false, 'one writable store is enough to merge, as it always was');
    click(exportButton());
    await waitFor(() => downloadedNames().length === 1, 'merged IFC export did not download');
    assert.match(shellText(), /Merged 1 models/);
    assert.match(shellText(), /no IFC records to write from: terrain\.3dm\./);
    assert.match(shellText(), /no data available for export: tower\.ifc\./);
  });
});

describe('a single STEP export of a model with no records', () => {
  it('stays offered, as #10099 refuses it by name, and says so before the click', () => {
    useViewerStore.setState({ ...fixtureModels(tabularModel('terrain.3dm')), activeModelId: 'terrain.3dm', dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openExportDialog(ui, 'Export IFC');

    assert.equal(exportButton().disabled, false, 'the export itself refuses, naming the model');
    assert.match(shellText(), /"terrain\.3dm" has no IFC STEP records to export from/);
  });
});
