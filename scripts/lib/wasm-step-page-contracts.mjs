/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function runStepPageContracts(api, test) {
  const vectors = JSON.parse(readFileSync(new URL('../../tests/fixtures/step-page-directive.json', import.meta.url), 'utf8'));
  for (const { name, literal } of vectors) {
    test(`#7540 PAGE operand: ${name} retains real WASM byte/string scan boundaries`, () => {
      const records = [
        `#20=IFCWALL('id20',$,${literal},$) /* ) ; */ ;`,
        "#21=IFCWALL('id21',$,'W-2',$);",
        "#22=IFCWALL('id22',$,'W-3',$);",
        `#30=IFCDOOR('id30',$,${literal},$);`,
        '#31=IFCCARTESIANPOINT((1.,2.,3.));',
      ];
      const content = ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION((${literal}),'2;1');`,
        'ENDSEC;', 'DATA;', ...records, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
      const bytes = new TextEncoder().encode(content);
      for (const refs of [api.scanEntitiesFast(content), api.scanEntitiesFastBytes(bytes)]) {
        assert.deepEqual(refs.map(ref => ref.expressId), [20, 21, 22, 30, 31]);
        assert.equal(refs.malformedRecordCount, 0);
        for (const [index, ref] of refs.entries()) {
          assert.equal(new TextDecoder().decode(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength)), records[index]);
        }
      }
    });
  }
}
