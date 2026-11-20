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

  // Execute already refuses every call without the grant; inspect is where a read declaration let the remesh through.
  for (const granted of [false, true]) {
    it(`is refused through viewer_operation_inspect ${granted ? 'even with' : 'without'} the edit grant, and leaves the geometry alone`, async (t) => {
      if (!ensureRoomWasm(t)) return;
      await seedReviewedRoom();
      const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
      const geometry = useViewerStore.getState().models.get(MODEL)?.geometryResult;
      const result = await dispatchMainViewerTool(host, 'viewer_operation_inspect', {
        model_id: MODEL, operation_id: 'authoring.room.prepare', input: { proposal_json: JSON.stringify(roomEnvelope()) },
      }, { canEdit: () => granted });
      assert.equal(result.isError, true);
      assert.match(result.text, /Inspect only accepts read operations/);
      assert.equal(useViewerStore.getState().models.get(MODEL)?.geometryResult, geometry, 'the walls were not remeshed');
    });
  }

  it('prepares through viewer_operation_execute with the edit grant, and the token applies', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const run = (operation_id: string, input: unknown) => dispatchMainViewerTool(host, 'viewer_operation_execute', { model_id: MODEL, operation_id, input }, { canEdit: () => true });
    const prepared = await run('authoring.room.prepare', { proposal_json: JSON.stringify(roomEnvelope()) });
    assert.equal(prepared.isError, false, prepared.text);
    const { token } = (prepared.structured as { result: { token: string } }).result;
    const applied = await run('authoring.graph.apply', { token });
    assert.equal(applied.isError, false, applied.text);
    const { receipt } = JSON.parse((applied.structured as { result: { native_json: string } }).result.native_json) as { receipt: { kind?: string; applied: unknown[] } };
    assert.equal(receipt.kind, 'room.command');
    assert.ok(receipt.applied.length > 0, 'the room was created');
  });
});
