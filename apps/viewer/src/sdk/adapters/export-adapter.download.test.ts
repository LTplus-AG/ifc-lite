/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useViewerStore } from '@/store';
import { createExportAdapter } from './export-adapter.js';

test('#11247 direct CSV downloads sanitize the filename while preserving the extension', t => {
  const filenames: string[] = [];
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) {
    filenames.push(this.download);
  });
  const adapter = createExportAdapter(useViewerStore);
  assert.equal(adapter.csv([], { columns: ['Name'] }), 'Name');
  assert.deepEqual(filenames, []);
  assert.equal(adapter.csv([], { columns: ['Name'], filename: 'DRAWINGS/000.000.csv' }), 'Name');
  assert.deepEqual(filenames, ['DRAWINGS-000.000.csv']);
});
