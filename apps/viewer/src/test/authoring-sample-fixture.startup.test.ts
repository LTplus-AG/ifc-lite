/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

// #8133 startup invariant: native parsing/reference checks must work without loading
// the viewer store or remesh service. Reject actual module loads, rather than
// inspecting import statements. This file has the runner's normal process
// isolation, so the hook cannot affect tests that exercise the full seeder.
register(new URL(`data:text/javascript,${encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.includes('/src/store/') || url.includes('/src/lib/remesh/')) {
    throw new Error('Parser-only fixture loaded viewer state: ' + url);
  }
  return nextLoad(url, context);
}
`)}`), import.meta.url);

test('authoring fixture parses the real SketchUp sample without viewer state or DOM setup', async () => {
  const { parseIfc, danglingReferences, BACK_WALL, BACK_WALL_NAME } = await import('./authoring-sample-fixture');
  const source = readFileSync(new URL('../../public/samples/building-architecture.ifc', import.meta.url));
  // Exercise the byte-view contract too: bytes outside the supplied view must
  // never become part of the IFC input.
  const padded = new Uint8Array(source.length + 8).fill(0xff);
  padded.set(source, 4);
  const store = await parseIfc(padded.subarray(4, 4 + source.length));
  const wall = store.entities.getExpressIdByGlobalId(BACK_WALL);
  assert.equal(store.schemaVersion, 'IFC4');
  assert.equal(store.entities.getTypeName(wall), 'IfcWall');
  assert.equal(store.entities.getName(wall), BACK_WALL_NAME);
  assert.deepEqual(danglingReferences(source.toString('utf8')), []);
  assert.deepEqual(danglingReferences("#1=IFCWALL('literal #999 and ''#998''',#2);\n#2=IFCMATERIAL($);\n#3=IFCPROPERTYSINGLEVALUE($,$,#4,$);"), [4]);
});
