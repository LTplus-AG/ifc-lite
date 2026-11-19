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
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';
import { resetFeaturesForTest } from '@/lib/features';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { seedReviewedRoom, roomEnvelope } from '@/test/reviewed-room-fixture';
import { MODEL } from '@/test/native-sdk-model';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';

let host: ToolHost;
const invoke = (id: string, input: unknown = {}, write = false) => dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
  ...(viewerOperation(id).needs === 'model' ? { model_id: MODEL } : {}), operation_id: id, input,
}, { canEdit: () => true });
function answer<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  const value = (result.structured as { result: { native_json?: string } }).result;
  return (value?.native_json === undefined ? value : JSON.parse(value.native_json)) as T;
}
const prepare = () => invoke('authoring.room.prepare', { proposal_json: JSON.stringify(roomEnvelope()) });
/** Run `change` in the same store update as the operation's own wall remesh, as an outside writer racing it would. */
function alongsideRemesh(change: () => void) {
  const geometry = useViewerStore.getState().models.get(MODEL)?.geometryResult;
  const stop = useViewerStore.subscribe(state => {
    if (state.models.get(MODEL)?.geometryResult === geometry) return;
    stop(); change();
  });
  return stop;
}

describe('authoring.room.prepare through the operation executor (#10908)', () => {
  const initial = useViewerStore.getState();
  beforeEach(() => { resetFeaturesForTest(); });
  afterEach(() => { clearModelLayouts(MODEL); setRemeshClientFactory(null); useViewerStore.setState(initial, true); });

  it('prepares despite its own wall remesh, and the token applies', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const geometry = useViewerStore.getState().models.get(MODEL)?.geometryResult;
    const { token } = answer<{ token: string }>(await prepare());
    assert.notEqual(useViewerStore.getState().models.get(MODEL)?.geometryResult, geometry, 'the prepare did remesh the walls');
    const { receipt } = answer<{ receipt: { kind?: string; applied: unknown[] } }>(await invoke('authoring.graph.apply', { token }, true));
    assert.equal(receipt.kind, 'room.command');
    assert.ok(receipt.applied.length > 0, 'the room was created');
  });

  it('still refuses a prepare when an edit lands while it runs', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const stop = alongsideRemesh(() => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })));
    try { assert.match((await prepare()).text, /Model replaced, closed, or edited during the operation/); } finally { stop(); }
  });

  it('still refuses a prepare when something other than geometry replaces the model entry while it runs', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await seedReviewedRoom();
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    const stop = alongsideRemesh(() => useViewerStore.setState(s => {
      const model = s.models.get(MODEL)!;
      return { models: new Map(s.models).set(MODEL, { ...model, name: `${model.name} (renamed)` }) };
    }));
    try { assert.match((await prepare()).text, /Model replaced, closed, or edited during the operation/); } finally { stop(); }
  });
});
