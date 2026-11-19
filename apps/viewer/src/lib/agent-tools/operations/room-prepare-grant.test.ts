/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { resetFeaturesForTest } from '@/lib/features';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL } from '@/test/native-sdk-model';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';

describe('authoring.room.prepare needs the edit grant, since it remeshes walls (#10919)', () => {
  const initial = useViewerStore.getState();
  beforeEach(() => { resetFeaturesForTest(); });
  afterEach(() => { clearModelLayouts(MODEL); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });

  for (const tool of ['viewer_operation_inspect', 'viewer_operation_execute'] as const) {
    it(`is refused through ${tool} without the edit grant, and leaves the geometry alone`, async (t) => {
      if (!ensureRoomWasm(t)) return;
      await seedReviewedRoom();
      const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
      const geometry = useViewerStore.getState().models.get(MODEL)?.geometryResult;
      const result = await dispatchMainViewerTool(host, tool, {
        model_id: MODEL, operation_id: 'authoring.room.prepare', input: { proposal_json: JSON.stringify(roomEnvelope()) },
      }, { canEdit: () => false });
      assert.equal(result.isError, true);
      assert.match(result.text, tool === 'viewer_operation_inspect' ? /Inspect only accepts read operations/ : /Commands and edits grant is required/);
      assert.equal(useViewerStore.getState().models.get(MODEL)?.geometryResult, geometry, 'the walls were not remeshed');
    });
  }
});
