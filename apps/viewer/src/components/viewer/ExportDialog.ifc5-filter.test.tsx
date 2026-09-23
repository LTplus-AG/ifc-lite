/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ExportDialog } from './ExportDialog.js';

// A reverted production branch predates this helper. Keep the mounted dialog
// assertion runnable there, so the test-revert oracle sees behavior turn red.
const helper: Partial<typeof import('@/lib/export/ifc5-filterable-properties')> =
  await import('@/lib/export/ifc5-filterable-properties').catch(() => ({}));

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

async function modelWithLateWall() {
  const walls = Array.from({ length: 60 }, (_, i) => {
    const id = i + 10;
    return `#${id}=IFCWALL('0${String(id).padStart(21, '0')}',$,'Wall ${id}',$,$,$,$,$,$);`;
  });
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
${walls.join('\n')}
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(store.entities.count > 50, 'late row falls outside the old source sample');
  const view = new MutablePropertyView(store.properties, 'model');
  view.setExpressIdWatermark(100);
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  return { store, view };
}

describe('IFC5 export property filter uses effective candidates (#5249)', () => {
  it('finds a late edited source row and a creation, but excludes tombstones', async () => {
    const hasFilterableIfc5Properties = helper.hasFilterableIfc5Properties;
    assert.ok(hasFilterableIfc5Properties, 'effective candidate helper is available');
    const { store, view } = await modelWithLateWall();
    assert.equal(hasFilterableIfc5Properties(store, view), false);
    view.setProperty(69, 'Pset_Probe', 'CustomLate', 'yes');
    assert.equal(hasFilterableIfc5Properties(store, view), true);
    view.deleteEntity(69);
    assert.equal(hasFilterableIfc5Properties(store, view), false);

    const created = view.createEntity('IfcWall',
      ['0NewWall000000000000001', '$', 'Created wall', '$', '$', '$', '$', '$', '$']);
    view.setProperty(created.expressId, 'Pset_Probe', 'CustomCreated', 'yes');
    assert.equal(hasFilterableIfc5Properties(store, view), true);
    view.deleteEntity(created.expressId);
    assert.equal(hasFilterableIfc5Properties(store, view), false);
  });

  it('updates the open export dialog when a late entity gains or loses an unknown property', async () => {
    const { store, view } = await modelWithLateWall();
    const model = fixtureModel('model');
    model.ifcDataStore = store;
    model.schemaVersion = 'IFC5';
    useViewerStore.setState({
      ...fixtureModels(model), activeModelId: model.id, dirtyModels: new Set(),
      mutationViews: new Map([[model.id, view]]), mutationVersion: 0,
    });
    const ui = render(<ExportDialog />);
    const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Export IFC'));
    assert.ok(trigger);
    click(trigger);
    assert.doesNotMatch(document.body.textContent ?? '', /Only Known IFC5 Properties/);

    await act(async () => {
      view.setProperty(69, 'Pset_Probe', 'CustomLate', 'yes');
      useViewerStore.setState({ mutationVersion: 1 });
    });
    assert.match(document.body.textContent ?? '', /Only Known IFC5 Properties/);

    await act(async () => {
      view.deleteEntity(69);
      useViewerStore.setState({ mutationVersion: 2 });
    });
    assert.doesNotMatch(document.body.textContent ?? '', /Only Known IFC5 Properties/);
  });
});
