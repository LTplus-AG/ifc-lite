/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredExportModelId } from './export-model-default.js';

test('Export IFC follows the active destination instead of the first loaded scan (#4477)', () => {
  assert.equal(preferredExportModelId(['scan.glb', 'authored.ifc'], 'authored.ifc'), 'authored.ifc');
  assert.equal(preferredExportModelId(['scan.glb', 'authored.ifc'], 'missing'), 'scan.glb');
  assert.equal(preferredExportModelId([], null), '');
});
