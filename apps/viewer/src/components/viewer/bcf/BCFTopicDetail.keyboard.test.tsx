/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BCFTopic } from '@ifc-lite/bcf';
import { activate, cleanup, render } from '@/test/render.js';
import { BCFTopicDetail } from './BCFTopicDetail.js';

afterEach(cleanup);

it('#5823 activates snapshot, placeholder, and comment thumbnails from the keyboard', () => {
  const topic: BCFTopic = {
    guid: 'topic', title: 'Viewpoint activation', creationDate: '2026-01-01T00:00:00Z',
    viewpoints: [{ guid: 'snapshot', snapshot: 'data:image/png;base64,AA==' }, { guid: 'placeholder' }],
    comments: [{ guid: 'comment', date: '2026-01-02T00:00:00Z', comment: 'See snapshot', viewpointGuid: 'snapshot' }],
  };
  const activated: string[] = [];
  const ui = render(
    <BCFTopicDetail
      topic={topic} onBack={() => {}} onEditTopic={() => {}} onAddComment={() => {}}
      onAddViewpoint={() => {}} onAddSectionViewpoint={() => {}}
      sectionViewpointBlockReason={null}
      onActivateViewpoint={(viewpoint) => activated.push(viewpoint.guid)}
      onDeleteViewpoint={() => {}} onUpdateStatus={() => {}} onZoomToTopic={() => {}}
      canZoomToTopic={false} onDeleteTopic={() => {}} selectionCount={0}
      hasIsolation={false} hasHiddenEntities={false}
    />,
  );
  const snapshot = ui.querySelector('img[alt="Viewpoint"]')?.closest<HTMLButtonElement>('button');
  const placeholder = ui.querySelector<HTMLButtonElement>('button[aria-label="Viewpoint 2"]');
  const thumbnail = ui.querySelector('img[alt="Associated viewpoint"]')?.closest<HTMLButtonElement>('button');
  assert.ok(snapshot && placeholder && thumbnail);
  assert.equal(snapshot.getAttribute('aria-label'), 'Viewpoint 1');
  activate(snapshot, 'Enter');
  activate(placeholder, ' ');
  activate(thumbnail, 'Enter');
  assert.deepEqual(activated, ['snapshot', 'placeholder', 'snapshot']);
});
