/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createBCFTopic, placeholderSnapshotPng, type BCFTopic } from '@ifc-lite/bcf';
import { topicSnapshotDataUrl } from './generate-document-pdf';

const real = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function topic(viewpoints: BCFTopic['viewpoints']): BCFTopic {
  return { ...createBCFTopic({ title: 'T', author: 'a@example.com' }), viewpoints };
}

// IDS exports carry a blank interop placeholder (#7974); a document page must
// not show it as if it were the issue's picture.
it('skips the interop placeholder snapshot in document pages', () => {
  assert.equal(topicSnapshotDataUrl(topic([{ guid: 'a', snapshotData: placeholderSnapshotPng() }])), null);
  const placeholderUrl = `data:image/png;base64,${btoa(String.fromCharCode(...placeholderSnapshotPng()))}`;
  assert.equal(topicSnapshotDataUrl(topic([{ guid: 'a', snapshot: placeholderUrl }])), null);
  assert.equal(topicSnapshotDataUrl(topic([{ guid: 'a', snapshotData: placeholderSnapshotPng() }, { guid: 'b', snapshot: real }])), real);
});
