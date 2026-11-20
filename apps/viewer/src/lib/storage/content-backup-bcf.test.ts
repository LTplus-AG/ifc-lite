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
  const restored = parseContentBackup(portable);
  assert.equal(restored.version, 1);
  assert.equal(restored.bcfProject, data);
  assert.equal(parseContentBackup(JSON.stringify(createContentBackup(libraries))).bcfProject, undefined);
});

test('#10976 v3 round trip keeps the BCF working copy alongside clash reviews', () => {
  const data = stored([topic]);
  const localWork = {
    'ifc-lite-clash-reviews': JSON.stringify({ schemaVersion: 1, reviews: { shared: { status: 'accepted', comment: 'Sleeve agreed' } } }),
  };
  const backup = createContentBackup(libraries, undefined, [], data, { localWork, drafts: [], complete: true });
  assert.equal(backup.version, 3);

  const restored = parseContentBackup(JSON.stringify(encodeContentBackup(backup)));
  assert.equal(restored.version, 3);
  assert.equal(restored.bcfProject, data);
  assert.deepEqual(restored.libraries.localWork, localWork);
});

test('#10975 the BCF project codec refuses malformed nested data and unknown versions', () => {
  const invalid = [
    null,
    stored([topic, topic]),
    stored([{ ...topic, comments: [{ guid: 'comment', comment: 4 }] }]),
    stored([{ ...topic, viewpoints: [{ guid: 'view', snapshotData: '===' }] }]),
    stored([{ ...topic, viewpoints: [{ guid: 'view', clippingPlanes: [{ location: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: null, z: 1 } }] }] }]),
    '{"version":9,"project":{"version":"3.0","topics":[]}}',
  ];
  for (const version of [2, 3]) {
    for (const bcfProject of invalid) {
      assert.throws(() => parseContentBackup(JSON.stringify({ version, libraries, bcfProject })), /Invalid BCF working copy/);
    }
  }
});
