/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Studio slice gets its authoring runtime installed by the Studio's lazy
 * loading (the panel awaits it before it mounts; `loadStudioContexts` loads it
 * too), so the root store keeps `@ifc-lite/ids-authoring` out of the eager
 * bundle. Without the runtime the synchronous actions refuse explicitly; they
 * never silently no-op or turn async.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { wallFixture } from '@/test/ids-studio-fixture';
import { addFacetOps, setFieldOp } from '@/lib/ids-studio/ops';
import { loadStudioContexts } from '@/lib/ids-studio/context';

const NOT_LOADED = /authoring runtime is not loaded/;

afterEach(async () => {
  useViewerStore.getState().idsStudioClose();
  await loadStudioContexts();
});

describe('idsStudioSlice lazy authoring runtime', () => {
  it('refuses explicitly while the runtime is not installed', async () => {
    const { doc, state, propertyId, contexts } = await wallFixture();
    useViewerStore.getState().idsStudioSetContexts(contexts);
    useViewerStore.setState({ idsStudioRuntime: null, idsStudioState: null });

    assert.throws(() => useViewerStore.getState().idsStudioOpen(doc), NOT_LOADED);
    assert.equal(useViewerStore.getState().idsStudioState, null, 'a refused open leaves no document');

    // A document present without the runtime (not reachable through the UI): edits refuse as data.
    useViewerStore.setState({ idsStudioState: state, idsStudioRejection: null });
    const outcome = useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.value', { kind: 'equals', value: 'EI60' })]);
    assert.equal(outcome.ok, false);
    assert.equal(useViewerStore.getState().idsStudioRejection?.issues[0].code, 'GATE-OP-001');
    assert.equal(useViewerStore.getState().idsStudioState, state, 'a refused edit changes nothing');
    assert.throws(() => useViewerStore.getState().idsStudioUndo(), NOT_LOADED);
    assert.throws(() => useViewerStore.getState().idsStudioRedo(), NOT_LOADED);
  });

  it('loading the Studio installs the runtime; then open, dispatch, undo and redo work synchronously', async () => {
    const { doc, specId } = await wallFixture();
    useViewerStore.setState({ idsStudioRuntime: null, idsStudioState: null });
    const contexts = await loadStudioContexts();
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
});
