/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState, act } from 'react';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '@ifc-lite/mutations';
import { emptyFilterGroup } from '@ifc-lite/rules';
import { render, cleanup, click, advance } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useBulkQueryTargets } from './useBulkQueryTargets.js';

const groups = [emptyFilterGroup()];

function QueryCountProbe() {
  const [suspended, setSuspended] = useState(false);
  const { ids } = useBulkQueryTargets(true, suspended, 'model-a', groups);
  return <>
    <button onClick={() => setSuspended((value) => !value)}>{suspended ? 'Finish run' : 'Start run'}</button>
    <output>{ids.length}</output>
  </>;
}

afterEach(cleanup);

it('#5898: a multi-chunk Bulk run refreshes its Query count once after completion', async () => {
  const model = fixtureModel('model-a', { entities: Array.from({ length: 1001 }, (_, index) => ({
    expressId: index + 1, type: 'IfcWall', name: `Wall ${index + 1}`,
  })) });
  useViewerStore.setState({
    ...fixtureModels(model),
    mutationViews: new Map([['model-a', new MutablePropertyView(null, 'model-a')]]),
    mutationVersion: 0,
    collabRole: null,
  });

  const original = BulkQueryEngine.prototype.select;
  let scans = 0;
  BulkQueryEngine.prototype.select = function (criteria) {
    scans++;
    return original.call(this, criteria);
  };
  try {
    const container = render(<QueryCountProbe />);
    await advance(0);
    assert.equal(container.querySelector('output')?.textContent, '1001');
    const beforeRun = scans;
    click(container.querySelector('button')!);

    act(() => {
      for (const id of [1, 501, 1001]) {
        useViewerStore.getState().setProperty('model-a', id, 'Pset_Run', 'Code', 'X', PropertyValueType.Label);
      }
    });
    assert.equal(scans, beforeRun, 'per-chunk mutationVersion updates do not repeat the whole-model scan');
    click(container.querySelector('button')!);
    await advance(0);
    assert.equal(scans, beforeRun + 1, 'one fresh count runs after the writer finishes');
  } finally {
    BulkQueryEngine.prototype.select = original;
  }
});
