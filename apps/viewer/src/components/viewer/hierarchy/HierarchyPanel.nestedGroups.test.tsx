/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();

import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider.js';
import { useViewerStore } from '@/store';
import { HierarchyPanel } from '../HierarchyPanel.js';

afterEach(cleanup);

it('expands child zones and hides / isolates descendant spaces from the parent (#7870)', async () => {
  const source = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa1',$,'1.01',$,$,$,$,$,$,$,$);
#11=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa2',$,'1.02',$,$,$,$,$,$,$,$);
#20=IFCZONE('0bbbbbbbbbbbbbbbbbbbb1',$,'Unit A',$,$,$);
#21=IFCZONE('0bbbbbbbbbbbbbbbbbbbb2',$,'Rental units',$,$,$);
#30=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc1',$,$,$,(#10,#11),$,#20);
#31=IFCRELASSIGNSTOGROUP('0cccccccccccccccccccc2',$,$,$,(#20),$,#21);
ENDSEC;
END-ISO-10303-21;`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer as ArrayBuffer, { disableWorkerScan: true });
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const model = { ...fixtureModel('nested-panel'), ifcDataStore: store,
    geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0,
      instancedGeometryHashes: new Map([[10, 1n], [11, 2n]]),
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } } };
  useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: store, hierarchyMode: 'groups',
    selectedEntityId: null, selectedEntityIds: new Set(), hiddenEntities: new Set(), isolatedEntities: null,
    typeVisibility: { ...useViewerStore.getState().typeVisibility, spaces: false },
  });
  const ui = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
  const button = (label: string) => {
    const el = ui.querySelector(`button[aria-label="${label}"]`);
    assert.ok(el, `rendered ${label}`);
    return el;
  };
  assert.doesNotMatch(ui.textContent ?? '', /Unit A/);
  click(button('Expand Rental units'));
  click(button('Expand Unit A'));
  assert.match(ui.textContent ?? '', /1\.01/);
  assert.match(ui.textContent ?? '', /1\.02/);
  assert.equal(ui.querySelectorAll('button[aria-label="Collapse Unit A"]').length, 1);

  click(button('Hide Rental units'));
  assert.deepEqual([...useViewerStore.getState().hiddenEntities].sort(), [10, 11]);
  click(button('Show Rental units'));
  assert.equal(useViewerStore.getState().hiddenEntities.size, 0);
  click(button('Isolate Rental units'));
  assert.deepEqual([...(useViewerStore.getState().isolatedEntities ?? [])].sort(), [10, 11]);
  assert.equal(useViewerStore.getState().typeVisibility.spaces, true, 'isolation reveals nested spaces hidden by default');
});
