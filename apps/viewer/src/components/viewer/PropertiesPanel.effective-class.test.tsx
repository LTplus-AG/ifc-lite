/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'effective-class';
const OFFSET = 1_000_000;
const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('materials.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#20=IFCMATERIAL('Concrete',$,$);
ENDSEC;
END-ISO-10303-21;
`;

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('PropertiesPanel effective selected class (#5249)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => { cleanup(); useViewerStore.setState(initialState, true); });

  it('routes an overlay-created material to the material panel', async () => {
    const bytes = new TextEncoder().encode(SOURCE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(null, MODEL_ID);
    const editor = new StoreEditor(store, view);
    const created = editor.addEntity('IfcMaterial', ['New Material', null, null]);
    useViewerStore.setState({
      models: new Map([[MODEL_ID, { ...fixtureModel(MODEL_ID, { idOffset: OFFSET }), ifcDataStore: store }]]),
      activeModelId: MODEL_ID,
      mutationViews: new Map([[MODEL_ID, view]]),
      mutationVersion: 1,
      selectedEntity: { modelId: MODEL_ID, expressId: created.expressId },
      selectedEntityId: OFFSET + created.expressId,
      selectedModelId: null,
      selectedEntities: [],
      selectedEntityIds: new Set([OFFSET + created.expressId]),
    });

    const container = render(<PropertiesPanel />);
    assert.ok(container.textContent?.includes(`Material #${created.expressId}`),
      'an authored IfcMaterial should take the material totals route');

    editor.setEntityType(created.expressId, 'IfcWallType');
    cleanup();
    useViewerStore.setState({ mutationVersion: 2 });
    const retyped = render(<PropertiesPanel />);
    assert.ok(!retyped.textContent?.includes(`Material #${created.expressId}`),
      'a created material retyped to IfcWallType should leave the material totals route');
  });
});
