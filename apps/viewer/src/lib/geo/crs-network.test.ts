/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resetFeaturesForTest } from '../features/index.js';
import { createViewerCrsLoaders } from './crs-network.js';

it('CRS definition and grid requests honour the viewer privacy policy after loader creation (#10176)', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response('+proj=longlat +datum=WGS84 +no_defs');
  };
  try {
    resetFeaturesForTest();
    const loaders = createViewerCrsLoaders(false);
    assert.ok(loaders.epsgDefinition);
    assert.ok(loaders.gridFile);
    resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
    assert.equal(await loaders.epsgDefinition('999999'), null);
    assert.equal(await loaders.gridFile('fixture.tif'), null);
    assert.deepEqual(requests, []);
    resetFeaturesForTest();
    await loaders.epsgDefinition('999999');
    await loaders.gridFile('fixture.tif');
    assert.deepEqual(requests, ['https://epsg.io/999999.proj4', 'https://cdn.proj.org/fixture.tif']);
  } finally {
    globalThis.fetch = originalFetch;
    resetFeaturesForTest();
  }
});
