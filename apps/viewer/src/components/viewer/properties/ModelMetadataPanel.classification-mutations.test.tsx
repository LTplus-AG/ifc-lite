/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { ModelMetadataPanel } from './ModelMetadataPanel';

afterEach(cleanup);

it('#5249 refreshes the displayed classification systems after an overlay edit', async () => {
  const step = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#10=IFCCLASSIFICATION('CSI','2015',$,'Uniclass',$,$,$);
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(step);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const model = {
    id: 'classification-model', name: 'Classification model', ifcDataStore: dataStore,
    fileSize: bytes.byteLength, loadedAt: Date.now(),
  } as FederatedModel;
  const view = new MutablePropertyView(dataStore.properties ?? null, model.id);
  useViewerStore.setState({ mutationViews: new Map([[model.id, view]]), mutationVersion: 0 });

  const panel = render(<ModelMetadataPanel model={model} />);
  assert.match(panel.textContent ?? '', /Uniclass/);

  act(() => {
    view.deleteEntity(10);
    view.setExpressIdWatermark(10);
    view.createEntity('IfcClassification', [null, null, null, 'DIN 276']);
    useViewerStore.setState((state) => ({ mutationVersion: state.mutationVersion + 1 }));
  });
  assert.doesNotMatch(panel.textContent ?? '', /Uniclass/);
  assert.match(panel.textContent ?? '', /DIN 276/);
});
