/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContentBackup, encodeContentBackup, parseContentBackup } from './content-backup.js';

const libraries = { validation: [], comparison: [], document: [] };
const topic = { guid: 'topic', title: 'Issue', comments: [{ guid: 'comment', comment: 'Check again' }],
  viewpoints: [{ guid: 'view', snapshotData: 'AAEC', snapshot: 'data:image/png;base64,AAEC' }] };
const stored = (topics: unknown[]) => JSON.stringify({ version: 1, project: { version: '3.0', topics } });

test('#10975 the BCF project codec survives a library backup round trip', () => {
  const data = stored([topic]);
  const backup = createContentBackup(libraries, undefined, [], data);
  const portable = JSON.stringify(encodeContentBackup(backup));
  assert.equal(parseContentBackup(portable).bcfProject, data);
  assert.equal(parseContentBackup(JSON.stringify(createContentBackup(libraries))).bcfProject, undefined);
});

test('#10975 the BCF project codec refuses malformed nested data and unknown versions', () => {
  const invalid = [
    stored([topic, topic]),
    stored([{ ...topic, comments: [{ guid: 'comment', comment: 4 }] }]),
    stored([{ ...topic, viewpoints: [{ guid: 'view', snapshotData: '===' }] }]),
    stored([{ ...topic, viewpoints: [{ guid: 'view', clippingPlanes: [{ direction: { x: 0, y: null, z: 1 } }] }] }]),
    '{"version":9,"project":{"version":"3.0","topics":[]}}',
  ];
  for (const bcfProject of invalid) {
    assert.throws(() => parseContentBackup(JSON.stringify({ version: 2, libraries, bcfProject })), /Invalid BCF working copy/);
  }
});
