/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio slice gets its authoring runtime from `loadIdsStudioRuntime`
 * (a dynamic import the lazy Studio panel awaits before it mounts), so the
 * root store keeps `@ifc-lite/ids-authoring` out of the eager bundle. Before
 * the runtime is installed the synchronous actions refuse explicitly; they
 * never silently no-op or turn async. A failed load rejects and is retryable.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { addFacetOps, setFieldOp } from '@/lib/ids-studio/ops';
import { loadIdsStudioRuntime } from '@/lib/ids-studio/runtime-loader';
import { IDS_STUDIO_RUNTIME_NOT_LOADED } from './idsStudioSlice';

afterEach(async () => {
  useViewerStore.getState().idsStudioClose();
  await loadIdsStudioRuntime();
});

describe('idsStudioSlice lazy authoring runtime', () => {
  it('refuses explicitly before the runtime is installed', async () => {
    const { doc, state, propertyId, contexts } = await wallFixture();
    useViewerStore.getState().idsStudioSetContexts(contexts);
    useViewerStore.setState({ idsStudioRuntime: null, idsStudioState: null });

    assert.throws(() => useViewerStore.getState().idsStudioOpen(doc), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });
    assert.equal(useViewerStore.getState().idsStudioState, null, 'a refused open leaves no document');

    // A document present without the runtime (not reachable through the UI): edits refuse as data.
    useViewerStore.setState({ idsStudioState: state });
    const outcome = useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.value', { kind: 'equals', value: 'EI60' })]);
    assert.equal(outcome.ok, false);
    assert.equal(useViewerStore.getState().idsStudioRejection?.issues[0].code, 'GATE-OP-001');
    assert.equal(useViewerStore.getState().idsStudioState, state, 'a refused edit changes nothing');
    assert.throws(() => useViewerStore.getState().idsStudioUndo(), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });
    assert.throws(() => useViewerStore.getState().idsStudioRedo(), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });
  });

  it('once loaded, open, dispatch, undo and redo work synchronously', async () => {
    const { doc, specId, contexts } = await wallFixture();
    useViewerStore.setState({ idsStudioRuntime: null });
    await loadIdsStudioRuntime();
    const store = useViewerStore.getState();
    store.idsStudioSetContexts(contexts);
    store.idsStudioOpen(doc);
    assert.equal(useViewerStore.getState().idsStudioState?.doc, doc);
    const { ops } = addFacetOps(specId, 'requirements', { type: 'material', value: { kind: 'equals', value: 'Concrete' } }, 'required');
    assert.deepEqual(store.idsStudioDispatch(ops), { ok: true });
    const requirements = () => useViewerStore.getState().idsStudioState?.doc.ids.specifications[0].requirements.length;
    assert.equal(requirements(), 2);
    store.idsStudioUndo();
    assert.equal(requirements(), 1);
    store.idsStudioRedo();
    assert.equal(requirements(), 2);
  });

  it('a failed load rejects with its error, leaves the actions refusing, and a retry recovers', async () => {
    const { doc } = await wallFixture();
    useViewerStore.setState({ idsStudioRuntime: null, idsStudioState: null });
    const failure = new Error('chunk failed to load');
    await assert.rejects(loadIdsStudioRuntime(() => Promise.reject(failure)), failure);
    assert.equal(useViewerStore.getState().idsStudioRuntime, null);
    assert.throws(() => useViewerStore.getState().idsStudioOpen(doc), { message: IDS_STUDIO_RUNTIME_NOT_LOADED });

    await loadIdsStudioRuntime();
    useViewerStore.getState().idsStudioOpen(doc);
    assert.equal(useViewerStore.getState().idsStudioState?.doc, doc);
  });
});
