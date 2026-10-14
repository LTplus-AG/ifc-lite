/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter"/></Units>
  <Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>
    <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
  </Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>
</LandXML>`;

/** The LandXML root `CoordinateSystem` record at the real wasm boundary. */
export function runLandXmlCrsContracts(api, test) {
  // #7604: the viewer's decoder (`readLandXmlCoordinateSystem`) reads these
  // snake_case keys from both the whole-document and the streamed header; a
  // dropped or renamed key is a CRS silently lost on LandXML → IFC.
  test('LandXML coordinate system crosses the boundary with name, epsg_code and datums (#7604)', () => {
    const record = '<CoordinateSystem name="CH1903+ / LV95" epsgCode="2056" horizontalDatum="CH1903+" verticalDatum="LN02"/>';
    const source = new TextEncoder().encode(XML.replace('<Units>', `${record}<Units>`));
    const expected = { horizontal_datum: 'CH1903+', vertical_datum: 'LN02', epsg_code: '2056', name: 'CH1903+ / LV95' };
    assert.deepEqual(api.parseLandXmlTinBytes(source).coordinate_system, expected);
    const nameOnly = new TextEncoder().encode(XML.replace('<Units>', '<CoordinateSystem name="CH1903+ / LV95"/><Units>'));
    // serde_wasm_bindgen writes an absent Option as a present key holding
    // `undefined`; the decoder's `typeof === 'string'` guards are what drop them.
    assert.deepEqual(
      api.parseLandXmlTinBytes(nameOnly).coordinate_system,
      { horizontal_datum: undefined, vertical_datum: undefined, epsg_code: undefined, name: 'CH1903+ / LV95' },
    );

    const session = api.createLandXmlTinStreamSession(source.byteLength);
    try {
      const events = [];
      session.advanceChunk(source);
      while (session.outputPending()) events.push(...session.drain(1024 * 1024));
      session.finishCursor();
      while (session.outputPending()) events.push(...session.drain(1024 * 1024));
      const header = events.find((event) => event.kind === 'metadata' && event.metadata_kind === 'header');
      assert.ok(header, 'the metadata cursor emits a header');
      assert.deepEqual(header.terrain.coordinate_system, expected);
    } finally {
      session.abort();
      session.free();
    }
  });
}
