/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { structuralEvidenceFixture as fixture } from '@/test/structural-evidence-fixture';
import { exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createStructuralAdapter } from '@/sdk/adapters/structural-adapter';
import { entityRefToString } from '@/store/types';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
interface EvidenceRow { data: { modelId: string; structural: { nativeResolvedActivityCount: number | null;
  activities: Array<{ AppliedLoad: { components: { ForceX?: number } } | null }> } } }
const rows = (): EvidenceRow[] => JSON.parse(captureEvidence('selection').payload).evidence.rows;

test('#7195 native structural deleted membership and actual undo invalidate the shared reader', async () => {
  const { file, relationId } = await fixture();
  const adapter = createStructuralAdapter(useViewerStore);
  assert.equal(adapter.data('native').members[0].activityGlobalIds.length, 1);
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  recordCompoundMutation(view, draft => draft.deleteEntity(relationId));
  const removed = await exportAndReparse('native', file);
  assert.equal(removed.getEntity(relationId), null);
  assert.equal(extractStructuralOnDemand(removed).members[0].activityGlobalIds.length, 0);
  assert.equal(rows()[0].data.structural.nativeResolvedActivityCount, 0);
  assert.equal(adapter.data('native').members[0].activityGlobalIds.length, 0);
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Expected recorded native inverse'); });
  const restored = await exportAndReparse('native', file);
  assert.equal(extractStructuralOnDemand(restored).members[0].activityGlobalIds.length, 1);
  assert.equal(rows()[0].data.structural.nativeResolvedActivityCount, 1);
  assert.equal(adapter.data('native').members[0].activityGlobalIds.length, 1);
});

test('#7195 native structural same EXPRESS identities in two models remain isolated after load edits', async () => {
  const a = await fixture(); const b = await fixture();
  const native = useViewerStore.getState().models.get('native'); assert.ok(native);
  useViewerStore.setState({ models: new Map([
    ['a', { ...native, id: 'a', name: 'a', ifcDataStore: a.file, idOffset: 0 }],
    ['b', { ...native, id: 'b', name: 'b', ifcDataStore: b.file, idOffset: 1_000_000 }],
  ]), activeModelId: 'a', ifcDataStore: a.file, selectedEntitiesSet: new Set([
    entityRefToString({ modelId: 'a', expressId: a.memberId }), entityRefToString({ modelId: 'b', expressId: b.memberId }),
  ]) });
  const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view);
  view.setAttribute(b.loadId, 'ForceX', '2345');
  const saved = await exportAndReparse('b', b.file);
  assert.equal(extractStructuralOnDemand(saved).activities[0].appliedLoad?.components.ForceX, 2345);
  assert.equal(extractStructuralOnDemand(a.file).activities[0].appliedLoad?.components.ForceX, 1234);
  assert.deepEqual(rows().map(row => [row.data.modelId, row.data.structural.activities[0].AppliedLoad?.components.ForceX]),
    [['a', 1234], ['b', 2345]]);
});
