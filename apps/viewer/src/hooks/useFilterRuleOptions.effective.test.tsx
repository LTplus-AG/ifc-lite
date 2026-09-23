/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useFilterRuleOptions } from './useFilterRuleOptions.js';

const SAMPLE = new URL('../../public/samples/hello-wall.ifc', import.meta.url);

function Probe() {
  const options = useFilterRuleOptions([]);
  return <div data-types={options.ifcTypeOptions.join(',')} data-storeys={options.storeyOptions.map(([name]) => name).join(',')} />;
}

test('filter options refresh after an in-place overlay edit bumps the mutation version (#5249)', async () => {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(store.properties, 'm1');
  view.setExpressIdWatermark(2000);
  const initial = useViewerStore.getState();
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m1'), ifcDataStore: store }),
    mutationViews: new Map([['m1', view]]),
    mutationVersion: 0,
    searchFilterSchema: new Map(),
  });
  try {
    const container = render(<Probe />);
    const probe = container.querySelector('div')!;
    assert.match(probe.dataset.storeys ?? '', /My Storey/);

    act(() => {
      view.deleteEntity(42);
      view.createEntity('IfcBuildingElementProxy', [null, null, 'Authored object']);
      useViewerStore.getState().bumpMutationVersion();
    });

    assert.ok(!(probe.dataset.storeys ?? '').includes('My Storey'));
    assert.match(probe.dataset.types ?? '', /IfcBuildingElementProxy/);
    assert.equal(useViewerStore.getState().searchFilterSchema.get('m1')?.mutationVersion, 1);
  } finally {
    cleanup();
    useViewerStore.setState(initial, true);
  }
});
