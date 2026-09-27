/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { activeChangesJsonMutations } from './export-changes-json.js';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));

test('#5902 JSON delta follows top Undo/Redo and excludes a discarded redo branch', () => {
  const view = new MutablePropertyView(null, 'A');
  const model = fixtureModel('A');
  useViewerStore.setState({ models: new Map([['A', model]]), activeModelId: 'A',
    mutationViews: new Map([['A', view]]), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    editEnabled: true, collabRoomId: null });
  const active = () => {
    return activeChangesJsonMutations('A', view.getMutations(), useViewerStore);
  };

  const first = useViewerStore.getState().setProperty('A', 101, 'Pset_Test', 'Status', 'draft', PropertyValueType.Label);
  assert.ok(first);
  assert.deepEqual(active().map(mutation => mutation.id), [first.id]);
  useViewerStore.getState().undo('A');
  assert.deepEqual(active(), [], 'the raw view still records the undone edit, but the delta does not');
  useViewerStore.getState().redo('A');
  assert.deepEqual(active().map(mutation => mutation.id), [first.id]);
  useViewerStore.getState().undo('A');
  const next = useViewerStore.getState().setProperty('A', 101, 'Pset_Test', 'ReviewCode', 'B1', PropertyValueType.Label);
  assert.ok(next);
  assert.deepEqual(active().map(mutation => mutation.id), [next.id], 'discarding Redo cannot revive its stale JSON record');
  const direct = view.setProperty(102, 'Pset_Test', 'Code', 'direct', PropertyValueType.Label);
  assert.deepEqual(active().map(mutation => mutation.id), [next.id, direct.id],
    'a direct view writer without undo bookkeeping remains in the delta');
});
