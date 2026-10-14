/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function runMalformedExportContracts(api, test) {
  const text = readFileSync(new URL('../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
  test('#7541 real WASM plain and mutation-log exports refuse incomplete source and retain valid edits', () => {
    const bytes = new TextEncoder().encode(text);
    const refs = api.scanEntitiesFastBytes(bytes);
    assert.deepEqual(refs.map(ref => ref.expressId), [1, 2, 3, 21, 22, 31]);
    assert.equal(refs.malformedRecordCount, 1);
    const log = JSON.stringify({ mutations: [{ type: 'UPDATE_ATTRIBUTE', entityId: 21, attributeName: 'Name', newValue: 'Authored edit' }] });
    for (const edits of ['', log]) {
      assert.throws(() => api.exportStep(bytes, 'IFC4', undefined, edits), /source index incomplete/);
    }
    const clean = text.replace("it's", "it''s").replace("Bob's", "Bob''s");
    const exported = new TextDecoder().decode(api.exportStep(new TextEncoder().encode(clean), 'IFC4', undefined, log));
    assert.ok(exported.includes("'Authored edit'"));
    assert.deepEqual(api.scanEntitiesFast(exported).map(ref => ref.expressId), [1, 2, 3, 20, 21, 22, 30, 31]);
  });

}
