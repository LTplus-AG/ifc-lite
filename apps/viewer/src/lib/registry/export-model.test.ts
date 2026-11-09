/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
