/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-030: the Studio slice is the only way the open IDS changes. A refused
 * batch changes nothing and is kept for its remedy; undo prunes a selection
 * whose node no longer exists; a session reset keeps the user's document.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { viewerTeardown } from '@/store/teardown-registry';
import { wallFixture } from '@/test/ids-studio-fixture';
import { addFacetOps, setFieldOp } from '@/lib/ids-studio/ops';

afterEach(() => useViewerStore.getState().idsStudioClose());

async function opened() {
  const fixture = await wallFixture();
  useViewerStore.getState().idsStudioSetContexts(fixture.contexts);
  useViewerStore.getState().idsStudioOpen(fixture.doc);
  return fixture;
}

describe('idsStudioSlice (IDS-030)', () => {
  it('refuses an ungrounded edit, keeps the document, and records the batch for a remedy', async () => {
    const { doc, propertyId } = await opened();
    const ops = [setFieldOp(propertyId, 'property.propertySet', { kind: 'equals', value: 'Pset_WallComon' })];
    const outcome = useViewerStore.getState().idsStudioDispatch(ops);
    assert.equal(outcome.ok, false);
    const s = useViewerStore.getState();
    assert.equal(s.idsStudioState?.doc, doc, 'the document object is untouched');
    assert.deepEqual(s.idsStudioRejection?.ops, ops);
    assert.equal(s.idsStudioRejection?.issues[0].code, 'GATE-PSET-001');
  });

  it('refuses every edit while the schema tables are not loaded', async () => {
    const { doc, propertyId } = await wallFixture();
    useViewerStore.setState({ idsStudioContexts: null });
    useViewerStore.getState().idsStudioOpen(doc);
    const outcome = useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.value', { kind: 'equals', value: 'EI60' })]);
    assert.equal(outcome.ok, false);
    assert.equal(useViewerStore.getState().idsStudioState?.doc, doc);
  });

  it('applies an accepted batch, clears the last refusal, and undo removes a selection that no longer exists', async () => {
    const { specId } = await opened();
    const store = useViewerStore.getState();
    store.idsStudioDispatch([setFieldOp(specId, 'entity.name', { kind: 'equals', value: 'IfcWall' })]); // refused: a spec is not a facet
    assert.ok(useViewerStore.getState().idsStudioRejection);
    const { ops, facetId } = addFacetOps(specId, 'requirements', { type: 'material', value: { kind: 'equals', value: 'Concrete' } }, 'required');
    assert.equal(store.idsStudioDispatch(ops).ok, true);
    assert.equal(useViewerStore.getState().idsStudioRejection, null);
    store.idsStudioSelect(facetId);
    useViewerStore.getState().idsStudioUndo();
    const after = useViewerStore.getState();
    assert.equal(after.idsStudioState?.doc.ids.specifications[0].requirements.length, 1, 'the material requirement is undone');
    assert.equal(after.idsStudioSelection, null, 'the selection of the removed facet is dropped');
    useViewerStore.getState().idsStudioRedo();
    assert.equal(useViewerStore.getState().idsStudioState?.doc.ids.specifications[0].requirements.length, 2);
  });

  it('a session reset clears the transient refusal but keeps the document', async () => {
    const { doc, propertyId } = await opened();
    useViewerStore.getState().idsStudioDispatch([setFieldOp(propertyId, 'property.baseName', { kind: 'equals', value: 'Nope' })]);
    const patch = viewerTeardown({ kind: 'session-reset' }, useViewerStore.getState());
    assert.equal('idsStudioRejection' in patch, true);
    assert.equal(patch.idsStudioRejection, null);
    assert.equal('idsStudioState' in patch, false, 'the IDS being authored is the user\'s work');
    assert.equal(useViewerStore.getState().idsStudioState?.doc, doc);
  });
});
