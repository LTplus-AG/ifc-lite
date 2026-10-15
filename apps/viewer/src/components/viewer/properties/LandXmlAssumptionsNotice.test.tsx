/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A LandXML placed under a georeferencing assumption the user chose
 * (`FederatedModel.landXmlAssumptionsApplied`) says so, in words, where a
 * user looks at the model: its metadata panel. A model placed on declared
 * CRSs alone shows no such notice.
 *
 * Rendered through the existing `ModelMetadataPanel`, so the file loads and
 * these assertions fail on their own merits with the production change
 * reverted.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, render, waitFor, advance } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { ModelMetadataPanel } from './ModelMetadataPanel';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

function landXmlModel(applied?: string[], crs?: string): FederatedModel {
  return {
    ...fixtureModel('terrain'),
    name: 'terrain.xml',
    ifcDataStore: null,
    geometryResult: null,
    sourceSchema: 'LandXML-1.2',
    fileSize: 1,
    loadedAt: 0,
    ...(crs ? { spatialReference: { source: { horizontalUnitToMetres: 1, verticalUnitToMetres: 1 }, horizontal: { id: crs }, confidence: 'declared' } } : {}),
    ...(applied ? { landXmlAssumptionsApplied: applied } : {}),
  } as unknown as FederatedModel;
}

async function assumedNotice(root: HTMLElement): Promise<string> {
  await waitFor(() => /Assumed/.test(root.textContent ?? ''), 'the "Assumed" notice', 3000);
  return root.textContent ?? '';
}

describe('LandXML "Assumed" placement notice', () => {
  it('the model metadata panel lists each assumption the model was placed under', async () => {
    const model = landXmlModel(['sharedVerticalDatum', 'epsgFromName'], 'EPSG:31467');
    useViewerStore.setState({ ...fixtureModels(model) });
    const panel = render(<ModelMetadataPanel model={model} />);
    const text = await assumedNotice(panel);
    assert.match(text, /Heights assumed to share the anchor model's height system: no vertical datum is declared/);
    assert.match(text, /EPSG:31467 read from the CoordinateSystem name/);
  });

  it('names only the assumptions actually applied', async () => {
    const model = landXmlModel(['epsgFromName'], 'EPSG:25832');
    useViewerStore.setState({ ...fixtureModels(model) });
    const panel = render(<ModelMetadataPanel model={model} />);
    const text = await assumedNotice(panel);
    assert.match(text, /EPSG:25832 read from the CoordinateSystem name/);
    assert.doesNotMatch(text, /height system/);
  });

  it('a model placed on declared CRSs alone shows no notice', async () => {
    for (const applied of [undefined, []]) {
      const model = landXmlModel(applied, 'EPSG:2056');
      useViewerStore.setState({ ...fixtureModels(model) });
      const panel = render(<ModelMetadataPanel model={model} />);
      await advance(50);
      assert.doesNotMatch(panel.textContent ?? '', /Assumed|read from the CoordinateSystem name/);
      cleanup();
    }
  });
});
