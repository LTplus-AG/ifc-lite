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

function utf16Le(text) {
  const output = new Uint8Array(2 + text.length * 2);
  output.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    output[2 + index * 2] = codeUnit & 0xff;
    output[3 + index * 2] = codeUnit >>> 8;
  }
  return output;
}

/** Assert the public raw-byte LandXML binding, not a mocked viewer adapter. */
export function runLandXmlContracts(api, test) {
  test('LandXML raw-byte parser accepts UTF-8 and UTF-16LE source', () => {
    const utf8 = api.parseLandXmlTinBytes(new TextEncoder().encode(XML));
    const utf16 = api.parseLandXmlTinBytes(utf16Le(XML.replace('UTF-8', 'UTF-16')));
    assert.equal(utf8.surfaces[0].name, 'grade');
    assert.deepEqual(utf8.surfaces[0].faces, [['1', '2', '3']]);
    assert.equal(utf16.surfaces[0].name, 'grade');
  });

  test('LandXML raw-byte parser preserves stable diagnostics', () => {
    assert.throws(
      () => api.parseLandXmlTinBytes(new TextEncoder().encode(XML.replace('linearUnit="meter"', 'linearUnit="bogus"'))),
      /LXML009: unsupported LandXML unit/,
    );
  });
}

/** Print the shared contract summary and deterministically release the API. */
export function finishContractRun(api, passed, failed, skipped) {
  console.log('\n' + '═'.repeat(50));
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═'.repeat(50));
  api.free();
}
