/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { PIPE_XML } from './wasm-landxml-contracts.mjs';

/** #7693: one `assumedLinearUnit` reaches every LandXML family through the real WASM. */
export function runLandXmlUnitContracts(api, test) {
  test('LandXML assumed linear unit reaches the plan, alignment and pipe families (#7693)', () => {
    assert.equal(api.parseLandXmlTinBytes(new TextEncoder().encode(PIPE_XML)).pipe_networks.root_units.assumed, false);
    const unitless = new TextEncoder().encode(PIPE_XML.replace(/<Units>.*?<\/Units>/, ''));
    const source = api.parseLandXmlSourceBytesWithOptions(unitless, { assumedLinearUnit: 'foot' });
    assert.equal(source.tin.plan.area_scale_to_square_meters, 0.3048 * 0.3048);
    assert.equal(source.alignments.units.assumed, true);
    // Pipe networks reach the viewer through the stream session.
    const session = api.createLandXmlTinStreamSession(unitless.byteLength, { assumedLinearUnit: 'foot' });
    const events = [];
    const drain = () => { while (session.outputPending()) events.push(...session.drain(1024 * 1024)); };
    try {
      session.advanceChunk(unitless);
      drain();
      session.finishCursor();
      drain();
    } finally {
      session.abort();
      session.free();
    }
    const header = events.find((event) => event.kind === 'metadata' && event.metadata_kind === 'header');
    for (const units of [header.plan.units, header.alignments.units, header.pipe_networks.root_units]) {
      assert.equal(units.assumed, true);
      assert.equal(units.linear_scale_to_meters, 0.3048);
    }
    const records = events.filter((event) => event.kind === 'metadata' && event.metadata_kind === 'record');
    const network = records.find((event) => event.record === 'pipe_network');
    assert.equal(network.value.structure_units.assumed, true, 'the network inherits the assumed root units');
    assert.ok(!records.some((event) => event.record === 'pipe_refusal'), 'a unitless pipe network is not refused under an assumed unit');
  });
}
