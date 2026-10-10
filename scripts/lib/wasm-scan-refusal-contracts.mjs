/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

/**
 * #7393: the scan's refusal counts cross the wasm boundary as own properties
 * of the returned array, so @ifc-lite/parser can route them through
 * onDiagnostic. The array itself must stay an array for existing callers.
 */
export function runScanRefusalContracts(api, test) {
  test('scanEntitiesFast/Bytes carry refusal counts on the result array (#7393)', () => {
    const source = [
      'DATA;',
      "#1=IFCWALL('a',$,$,$,$,$,$,$,.NOTDEFINED.);",
      "#2=IFCWALL('b',$,$,$,$,$,$,$,.NOTDEFINED.)",
      "#4294967297=IFCWALL('c',$,$,$,$,$,$,$,.NOTDEFINED.);",
      "#3=IFCWALL('d',$,$,$,$,$,$,$,.NOTDEFINED.);",
      'ENDSEC;',
    ].join('\n');
    for (const result of [api.scanEntitiesFast(source), api.scanEntitiesFastBytes(new TextEncoder().encode(source))]) {
      assert.ok(Array.isArray(result), 'result must stay an array for existing callers');
      assert.deepEqual(result.map((r) => r.expressId), [1, 3]);
      assert.equal(result.oversizedIdCount, 1);
      assert.equal(result.malformedRecordCount, 1);
    }
    const clean = api.scanEntitiesFast("DATA;\n#1=IFCWALL('a',$,$,$,$,$,$,$,.NOTDEFINED.);\nENDSEC;");
    assert.equal(clean.oversizedIdCount, 0);
    assert.equal(clean.malformedRecordCount, 0);
  });
}
