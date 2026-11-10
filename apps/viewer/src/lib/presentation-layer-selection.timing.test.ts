/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import * as presentation from './presentation-layers.js';
import { generatedLayerModel } from '../test/fixtures/presentation-layer-model.js';

// #9273: a selection may inspect 31 shape entities, never all 620,000 records.
// This is a broad latency guard, not a throughput benchmark. Exclusive A/B runs
// use this exact generated input and report their measurements separately.
test('#9273 bounds cold and edited selection cost in 20,000 BREP walls with zero/one layer', async () => {
  assert.equal(typeof presentation.presentationLayersByProduct, 'function', '#9273 selection lookup is available');
  const timings: Record<string, number> = {};
  for (const withLayer of [false, true]) {
    const source = new TextEncoder().encode(generatedLayerModel(20_000, withLayer));
    const store = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'timing');
    for (const edited of [false, true]) {
      if (edited) view.setProperty(1, 'Pset_Test', 'Unrelated', 'changed');
      const start = performance.now();
      const layers = presentation.presentationLayersByProduct(store, view).get(1) ?? [];
      timings[`${withLayer ? 'oneLayer' : 'noLayers'}-${edited ? 'edited' : 'cold'}`] = performance.now() - start;
      assert.deepEqual(layers.map(layer => layer.Name), withLayer ? ['BREP layer'] : []);
    }
  }
  console.log('#9273 selection milliseconds', JSON.stringify(timings));
  for (const [name, elapsed] of Object.entries(timings)) assert.ok(elapsed < 1_000, `${name}: selection took ${elapsed.toFixed(1)}ms (limit 1000ms)`);
});
