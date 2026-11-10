/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore as store } from '@/store/index.js';

it('NEW-2: repeated load availability writes do not notify; real changes still do', () => {
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const s = store.getState();
  s.setCesiumAvailable(s.cesiumAvailable);
  s.setPointCloudAssetCount(0);
  s.setPointCloudAssetCount(NaN);
  s.setPointCloudClassCounts('missing', null);
  s.incrementPointCloudAssetCount(0);
  s.incrementPointCloudAssetCount(-10);
  s.incrementPointCloudAssetCount(NaN);
  assert.equal(notifications, 0);
  s.setCesiumAvailable(!s.cesiumAvailable);
  s.setPointCloudAssetCount(2);
  const counts = { 2: 10 };
  s.setPointCloudClassCounts('scan', counts);
  assert.equal(notifications, 3);
  s.setPointCloudClassCounts('scan', counts);
  assert.equal(notifications, 3);
  s.setPointCloudClassCounts('scan', null);
  assert.equal(notifications, 4);
  unsubscribe();
});
