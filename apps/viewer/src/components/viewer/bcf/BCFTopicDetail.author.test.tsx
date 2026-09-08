/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import type { BCFTopic } from '@ifc-lite/bcf';
import { BCFTopicDetail } from './BCFTopicDetail.js';

afterEach(cleanup);

const TOPIC: BCFTopic = {
  guid: 'topic-1',
  title: 'Untitled author',
  creationDate: '2026-01-01T00:00:00Z',
  comments: [{
    guid: 'comment-1',
    date: '2026-01-02T00:00:00Z',
    comment: 'The source omitted this required author.',
  }],
  viewpoints: [],
};

describe('BCFTopicDetail author display (#3574)', () => {
  it('shows an authorless comment date without a user icon or dangling separator', () => {
    const container = render(
      <BCFTopicDetail
        topic={TOPIC}
        onBack={() => {}}
        onEditTopic={() => {}}
        onAddComment={() => {}}
        onAddViewpoint={() => {}}
        onActivateViewpoint={() => {}}
        onDeleteViewpoint={() => {}}
        onUpdateStatus={() => {}}
        onZoomToTopic={() => {}}
        canZoomToTopic={false}
        onDeleteTopic={() => {}}
        selectionCount={0}
        hasIsolation={false}
        hasHiddenEntities={false}
      />,
    );

    const comment = [...container.querySelectorAll('p')].find((node) =>
      node.textContent?.includes(TOPIC.comments[0].comment),
    )?.parentElement;
    assert.ok(comment, 'comment card must render');
    assert.equal(comment.querySelector('svg.lucide-user'), null, 'missing author has no user icon');
    assert.ok(!comment.textContent?.includes('-'), 'missing author has no dangling date separator');
  });
});
