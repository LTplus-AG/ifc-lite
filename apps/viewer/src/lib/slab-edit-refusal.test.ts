/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addSlabToStore, resolveSpatialAnchor } from '@ifc-lite/create';
// Keep the existing viewer contract loadable when production is reverted.
import { resolveSlabEditChain } from './slab-edit.js';

it('#6232 refuses nonfinite slab dimensions and zero-area profiles before exposing split geometry', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const slab = addSlabToStore(editor, anchor, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: .3 });
  const read = (id = slab.slabId, scale = 1) => resolveSlabEditChain(store, view, editor, id, scale);
  const snapshot = () => structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
  assert.deepEqual(read()?.footprint, [[0, 0], [4, 0], [4, 3], [0, 3]]);
  for (const [id, slot, valid] of [[slab.solidId, 3, .3], [slab.profileId, 3, 4], [slab.profileId, 4, 3]]) {
    for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) {
      editor.setPositionalAttribute(id, slot, invalid);
      const before = snapshot();
      assert.equal(read(), null);
      assert.deepEqual(snapshot(), before);
    }
    editor.setPositionalAttribute(id, slot, valid);
  }
  for (const scale of [NaN, Infinity, 0, -1, Number.MAX_VALUE]) assert.equal(read(slab.slabId, scale), null);
  const polygon = (OuterCurve: Array<[number, number]>) => addSlabToStore(editor, anchor, { Profile: 'polygon', OuterCurve, Thickness: .3 }).slabId;
  for (const points of [[[0, 0], [0, 0], [0, 0]], [[0, 0], [1, 1], [2, 2]]] satisfies Array<Array<[number, number]>>) {
    const id = polygon(points), before = snapshot();
    assert.equal(read(id), null);
    assert.deepEqual(snapshot(), before);
  }
  const triangle = read(polygon([[0, 0], [4, 0], [0, 3]]));
  assert.deepEqual(triangle?.footprint, [[0, 0], [4, 0], [0, 3]]);
  assert.equal(triangle?.thickness, .3);
});
