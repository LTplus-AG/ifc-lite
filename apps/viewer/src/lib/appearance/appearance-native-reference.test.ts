/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { assertReferencePlacementCurrent } from './appearance-native-reference.js';

type Prepared = Parameters<typeof assertReferencePlacementCurrent>[0];

test('a prepared reference is refused once its source, frame or room changed (#10587)', () => {
  const initial = useViewerStore.getState();
  const source = { id: 'source-1' } as unknown as Prepared['source'];
  useViewerStore.setState({ appearanceSources: [source] as never, collabRoomId: null });
  const prepared = { source, record: { sourceId: 'source-1', frameKey: placementFrameKey(useViewerStore.getState()) } } as Prepared;
  const refused = (value = prepared) => assert.throws(() => assertReferencePlacementCurrent(value), /sourceChanged/);
  try {
    assertReferencePlacementCurrent(prepared);
    useViewerStore.setState({ appearanceSources: [{ id: 'source-1' }] as never });
    refused();
    useViewerStore.setState({ appearanceSources: [source] as never, collabRoomId: 'room' });
    refused();
    useViewerStore.setState({ collabRoomId: null });
    refused({ ...prepared, record: { ...prepared.record, frameKey: 'other' } } as Prepared);
  } finally {
    useViewerStore.setState({ appearanceSources: initial.appearanceSources, collabRoomId: initial.collabRoomId });
  }
});
