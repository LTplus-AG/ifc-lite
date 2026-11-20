/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A merged STEP export skips a model whose store is tabular (a `.3dm`, an
 * IFCX) or missing, and used to report only the count it had included: a
 * partial federation downloaded as "the merged file" with nothing said about
 * the model left out. It now names them, before the export in the dialog and
 * after it in the result.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, type FederatedModel } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { tabularFixtureStore } from '@/test/tabular-store-fixture';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { chooseMerged, exportButton, openExportDialog, shellText } from './export-dialog-scope.test-support';
import { ExportDialog } from './ExportDialog';

/** A `.3dm`-shaped participant: a real `buildTabularDataStore` store, not a hand-set marker. */
function tabularModel(id: string): FederatedModel {
  return { ...fixtureModel(id), schemaVersion: 'IFC4' as const, ifcDataStore: tabularFixtureStore() };
}

afterEach(() => { cleanup(); clearDownloads(); useViewerStore.setState({ georefMutations: new Map() }); });

describe('merged STEP export reports the models it leaves out', () => {
  it('names a tabular model as skipped, before and after the export', async () => {
    const ifcDataStore = await parseFixtureModel();
    const step = { ...fixtureModel('house.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(step, tabularModel('terrain.3dm')), dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openExportDialog(ui, 'Export IFC');
    await chooseMerged();

    // Before the export: the dialog says which model the merge will drop.
    assert.match(shellText(), /Left out of the merged file, no IFC records to write from: terrain\.3dm\./);

    click(exportButton());
    await waitFor(() => downloadedNames().length === 1, 'merged IFC export did not download');
    assert.match(downloadedNames()[0], /^house.*_merged\.ifc$/, 'the STEP model is still exported');
    // After it: the result names the skipped model instead of only the included count.
    assert.match(shellText(), /Merged 1 models, [\d,]+ entities\. Left out of the merged file, no IFC records to write from: terrain\.3dm\./);
  });

  it('counts only the georeference edits of models the merge writes (#10669)', async () => {
    const ifcDataStore = await parseFixtureModel();
    const step = { ...fixtureModel('house.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
    const georef = { mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500 } };
    // Only the skipped tabular model carries an edit: the merged file holds none.
    useViewerStore.setState({ ...fixtureModels(step, tabularModel('terrain.3dm')), dirtyModels: new Set(),
      georefMutations: new Map([['terrain.3dm', georef]]) });
    const ui = render(<ExportDialog surface="ribbon" />);
    openExportDialog(ui, 'Export IFC');
    await chooseMerged();
    assert.doesNotMatch(shellText(), /ha(s|ve) been modified/, 'a skipped model\'s edit is not a pending change of this file');
    // The written model's edit is one.
    useViewerStore.setState({ georefMutations: new Map([['house.ifc', georef]]) });
    await waitFor(() => /1 entity has been modified/.test(shellText()), 'the written model\'s georeference edit is counted');
  });

  it('an all-STEP federation reports exactly what it did before', async () => {
    const ifcDataStore = await parseFixtureModel();
    const first = { ...fixtureModel('house.ifc'), ifcDataStore, schemaVersion: 'IFC4' as const };
    const second = { ...fixtureModel('annex.ifc', { idOffset: 1_000_000 }), ifcDataStore, schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(first, second), dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openExportDialog(ui, 'Export IFC');
    await chooseMerged();
    assert.doesNotMatch(shellText(), /Left out of the merged file/, 'nothing is skipped, so nothing is claimed');

    click(exportButton());
    await waitFor(() => downloadedNames().length === 1, 'merged IFC export did not download');
    assert.match(shellText(), /Merged 2 models, [\d,]+ entities/, 'the all-STEP message is what it always was');
    assert.doesNotMatch(shellText(), /Left out of the merged file/);
  });
});
