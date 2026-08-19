/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mergeAttachmentNames` / `resolveAttachments` are the two pure functions
 * PlaygroundChat uses to keep its pending-attachment chip list from ever
 * disagreeing with the `UploadStore`'s own last-wins de-dupe by basename
 * (see the integration test in playground-attach-dupes.test.tsx for the
 * end-to-end repro of the bug this closes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAttachmentNames, resolveAttachments, type UploadedFile } from './playground-uploads.js';

function entry(name: string, text: string): UploadedFile {
  return { name, mimeType: 'text/plain', size: text.length, text, uploadedAt: 0 };
}

describe('mergeAttachmentNames', () => {
  it('appends new names in order', () => {
    assert.deepEqual(mergeAttachmentNames([], ['a.ids', 'b.ids']), ['a.ids', 'b.ids']);
    assert.deepEqual(mergeAttachmentNames(['a.ids'], ['b.ids']), ['a.ids', 'b.ids']);
  });

  it('collapses a duplicate name within one added batch to a single entry', () => {
    assert.deepEqual(mergeAttachmentNames([], ['spec.ids', 'spec.ids']), ['spec.ids']);
  });

  it('does not re-add a name already pending', () => {
    assert.deepEqual(mergeAttachmentNames(['spec.ids'], ['spec.ids', 'other.ids']), ['spec.ids', 'other.ids']);
  });
});

describe('resolveAttachments', () => {
  it('projects each pending name to its current store entry', () => {
    const uploads = [entry('a.ids', 'A'), entry('b.ids', 'B')];
    assert.deepEqual(
      resolveAttachments(uploads, ['b.ids', 'a.ids']).map((u) => u.text),
      ['B', 'A'],
    );
  });

  it('drops a name whose upload is no longer in the store', () => {
    const uploads = [entry('a.ids', 'A')];
    assert.deepEqual(resolveAttachments(uploads, ['a.ids', 'gone.ids']).map((u) => u.name), ['a.ids']);
  });

  it('reflects the store last-wins content for a name, not a stale copy', () => {
    // Two uploads that shared a basename collapse to ONE store entry
    // (UploadStore.add's job); resolveAttachments must show whatever the
    // store currently holds for that name — the second file's content.
    const uploads = [entry('spec.ids', '<B/>')];
    const resolved = resolveAttachments(uploads, ['spec.ids']);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.text, '<B/>');
  });
});
