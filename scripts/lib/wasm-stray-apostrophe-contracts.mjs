/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #7541: the real wasm scan against the same vectors the TypeScript scans,
// the Blob worker and the Rust scanner run (rust/core/tests/fixtures/step-stray-apostrophe.json).
const HEADER = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n" +
  "FILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";

export function runStrayApostropheContracts(api, test) {
  const vectors = JSON.parse(readFileSync(new URL('../../rust/core/tests/fixtures/step-stray-apostrophe.json', import.meta.url), 'utf8'));
  for (const v of vectors) {
    test(`#7541 stray apostrophe: ${v.name} gives the shared ids and report on the real WASM scan`, () => {
      const joiner = v.joiner ?? '\n';
      const content = HEADER + v.records.join(joiner) + (joiner || '\n') + 'ENDSEC;\nEND-ISO-10303-21;\n';
      const bytes = new TextEncoder().encode(content);
      for (const refs of [api.scanEntitiesFast(content), api.scanEntitiesFastBytes(bytes)]) {
        assert.deepEqual(refs.map(ref => ref.expressId), v.ids);
        assert.equal(refs.malformedRecordCount > 0, v.malformed.length > 0);
        for (const ref of refs) {
          if (v.misframed?.includes(ref.expressId)) continue;
          const decl = `#${ref.expressId}=`;
          const record = v.records.find(r => r.includes(decl));
          assert.equal(new TextDecoder().decode(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength)),
            record.slice(record.indexOf(decl)));
        }
      }
    });
  }
}
