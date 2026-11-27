/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useViewerStore } from '@/store';
import { createViewerOpenModel } from '@/lib/flow/open-model';
import { editedRegistryModel } from '@/test/registry-model-fixture';
import { exportRegistryModel } from './export-model';

test('registry publishing exports the complete active IFC with its pending property edit (#8310)', async () => {
  const { bytes, parser, store, wall } = await editedRegistryModel();
  const exported = await exportRegistryModel();
  assert.equal(exported.filename, 'edited.ifc');
  const text = new TextDecoder().decode(exported.bytes);
  assert.match(text, /END-ISO-10303-21;/);
  assert.match(text, /Registry persisted wall/);
  assert.notDeepEqual(exported.bytes, bytes, 'publishing must not reuse the initial source bytes');
  const reopened = await parser.parseColumnar(exported.bytes.buffer, { disableWorkerScan: true });
  assert.equal(reopened.entityCount, store.entityCount, 'the full model is retained');
  const originalWall = reopened.entityIndex.byId.get(wall!);
  assert(originalWall, 'the edited wall still exists after re-parsing');
  assert.equal(reopened.entities.getName(wall!), 'Registry persisted wall', 'the edit belongs to the exported wall');
});

test('distinct reserved and underscore-prefixed registry names survive publishing and reopening (#11442)', async () => {
  const { id } = await editedRegistryModel();
  const published = new Set<string>();
  const longStem = `CON.${'a'.repeat(51)}`;
  for (const name of [`${longStem}A.ifc`, `${longStem}B.ifc`, 'CON.ifc', '_CON.ifc']) {
    const models = new Map(useViewerStore.getState().models);
    models.set(id, { ...models.get(id)!, name });
    useViewerStore.setState({ models });
    const { bytes, filename } = await exportRegistryModel();
    assert.ok(filename.length <= 60);
    assert.match(filename, /^_CON.*\.ifc$/);
    if (name === '_CON.ifc') assert.equal(filename, name);
    published.add(filename);
    await createViewerOpenModel(async file => {
      assert.equal(file.name, filename);
      return id;
    })(bytes, filename);
  }
  assert.equal(published.size, 4);
});
