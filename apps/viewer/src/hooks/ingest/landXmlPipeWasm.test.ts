/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pipeNetworks } from './landXmlPipeWasm.js';

const units = (extra: Record<string, unknown>) => ({
  linear_unit: 'foot', elevation_unit: 'foot', diameter_unit: 'foot', width_unit: 'foot', height_unit: 'foot',
  linear_scale_to_meters: 0.3048, elevation_scale_to_meters: 0.3048, diameter_scale_to_meters: 0.3048,
  width_scale_to_meters: 0.3048, height_scale_to_meters: 0.3048, ...extra,
});
const document = (rootUnits: unknown) => ({
  schema: 'LandXML-1.2', version: '1.2', capability_diagnostics: [], root_units: rootUnits,
  collections: [], features: [], networks: [], refusals: [],
});

describe('pipeNetworks units provenance (#5175, #7693)', () => {
  it('keeps the assumed flag of root units built from an assumed linear unit', () => {
    assert.equal(pipeNetworks(document(units({ assumed: true })))?.rootUnits?.assumed, true);
  });

  it('reads declared units, and records from an older WASM build without the flag, as declared', () => {
    assert.equal(pipeNetworks(document(units({ assumed: false })))?.rootUnits?.assumed, false);
    assert.equal(pipeNetworks(document(units({})))?.rootUnits?.assumed, false);
  });
});
