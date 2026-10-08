/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import { loadPersistedModelTags, savePersistedModelTags, MODEL_TAGS_STORAGE_KEY } from './persistence';

beforeEach(() => {
  window.localStorage.removeItem(MODEL_TAGS_STORAGE_KEY);
  useViewerStore.setState({ modelTags: new Map(), modelTagsSaveFailed: false, modelTagAssignments: new Map() });
});
afterEach(() => {
  window.localStorage.removeItem(MODEL_TAGS_STORAGE_KEY);
  useViewerStore.setState({ modelTags: new Map(), modelTagsSaveFailed: false, modelTagAssignments: new Map() });
});

function refuseStorage(work: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const storage = window.localStorage;
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage),
    setItem: () => { throw new Error('quota exceeded'); },
  } });
  try { work(); } finally {
    if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    else Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  }
}

describe('model tag persistence refusal and recovery (#6612)', () => {
  it('reports the actual persistence outcome and restores native tag definitions', () => {
    const tags = [{ id: 'structure', name: 'Structure' }];
    assert.equal(savePersistedModelTags(tags), true);
    assert.deepEqual(loadPersistedModelTags(), tags);
    refuseStorage(() => assert.equal(savePersistedModelTags([{ id: 'other', name: 'Other' }]), false));
    assert.deepEqual(loadPersistedModelTags(), tags, 'a refused write preserves previously saved vocabulary');
  });

  it('keeps unsaved vocabulary visible across model teardown and retries the same identities', () => {
    let tagId: string | null = null;
    refuseStorage(() => {
      tagId = useViewerStore.getState().createModelTag('Structure');
      assert.ok(tagId);
      assert.equal(loadPersistedModelTags().length, 0);
      useViewerStore.getState().clearAllModels();
      assert.equal(useViewerStore.getState().modelTagsSaveFailed, true);
      assert.equal(useViewerStore.getState().modelTags.get(tagId)?.name, 'Structure');
    });
    assert.equal(useViewerStore.getState().retryModelTagsSave(), true);
    assert.equal(useViewerStore.getState().modelTagsSaveFailed, false);
    assert.deepEqual(loadPersistedModelTags(), [{ id: tagId, name: 'Structure' }]);
  });
});
