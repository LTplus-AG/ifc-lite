/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `historySlice` and its teardown.
 *
 * The teardown is where the real risk lives: everything this slice owns is
 * keyed by a VIEWER MODEL ID, and a viewer model id is reused by a setup-file
 * reopen. A commit tag that outlived its model would tell the panel a
 * brand-new model is some other project's commit — and, through
 * `isHistoricalModel`, silently make it read-only with nothing on screen
 * saying why.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand';

import { createHistorySlice, type CommitTag, type HistorySlice } from './historySlice.js';
import { historyTeardown } from './historySlice.teardown.js';
import type { ViewerState } from '../index.js';

function tag(commitId: string, historical = false): CommitTag {
  return {
    provider: 'fixture',
    projectId: 'p1',
    sourceModelId: 'sm1',
    commitId,
    artifactDigest: `sha256:${commitId}`,
    historical,
    loadedAt: 1,
  };
}

function makeStore(canCollabEdit = true) {
  return createStore<HistorySlice & { canCollabEdit: () => boolean }>((...args) => ({
    ...createHistorySlice(...args),
    canCollabEdit: () => canCollabEdit,
  }));
}

describe('historySlice — commit tags', () => {
  it('records and removes a tag by viewer model id', () => {
    const store = makeStore();
    store.getState().setCommitTag('viewer-1', tag('c3'));
    assert.equal(store.getState().commitTags.get('viewer-1')?.commitId, 'c3');
    store.getState().removeCommitTag('viewer-1');
    assert.equal(store.getState().commitTags.has('viewer-1'), false);
  });

  it('clears a pending "new version" the moment that model is re-opened', () => {
    const store = makeStore();
    store.getState().setCommitTag('viewer-1', tag('c2'));
    store.getState().noteNewHead('viewer-1', 'c3');
    assert.equal(store.getState().historyNewHeads.get('viewer-1'), 'c3');

    store.getState().setCommitTag('viewer-1', tag('c3'));
    assert.equal(
      store.getState().historyNewHeads.has('viewer-1'),
      false,
      'a banner still up after the user acted on it teaches them to ignore it',
    );
  });

  it('removing a tag that is not there does not allocate a new map', () => {
    const store = makeStore();
    const before = store.getState().commitTags;
    store.getState().removeCommitTag('never-tagged');
    assert.equal(store.getState().commitTags, before);
  });
});

describe('historySlice — isHistoricalModel / canEditModel', () => {
  it('is historical only when the tag says so', () => {
    const store = makeStore();
    store.getState().setCommitTag('live', tag('c3', false));
    store.getState().setCommitTag('past', tag('c1', true));
    assert.equal(store.getState().isHistoricalModel('live'), false);
    assert.equal(store.getState().isHistoricalModel('past'), true);
    assert.equal(store.getState().isHistoricalModel('untagged'), false);
  });

  it('refuses editing a past version even for a single user with no collab session', () => {
    const store = makeStore(true);
    store.getState().setCommitTag('past', tag('c1', true));
    assert.equal(store.getState().canEditModel('past'), false);
    assert.equal(store.getState().canEditModel('live-untagged'), true);
  });

  it('still honours the collab role for a live model', () => {
    const store = makeStore(false);
    store.getState().setCommitTag('live', tag('c3', false));
    assert.equal(store.getState().canEditModel('live'), false);
  });
});

describe('historySlice — focus and compare picks', () => {
  it('drops the A/B picks when focus moves to another model', () => {
    const store = makeStore();
    store.getState().setHistoryFocus('viewer-1');
    store.getState().pickCommit('A', { projectId: 'p1', modelId: 'sm1', commitId: 'c1' });
    store.getState().pickCommit('B', { projectId: 'p1', modelId: 'sm1', commitId: 'c3' });

    store.getState().setHistoryFocus('viewer-2');
    // A pair spanning two different models is a diff `getCommitDiff` refuses
    // (`invalid`) and that would mean nothing if it did not.
    assert.equal(store.getState().historyPickA, null);
    assert.equal(store.getState().historyPickB, null);
  });

  it('keeps the picks when focus is re-set to the same model', () => {
    const store = makeStore();
    store.getState().setHistoryFocus('viewer-1');
    store.getState().pickCommit('A', { projectId: 'p1', modelId: 'sm1', commitId: 'c1' });
    store.getState().setHistoryFocus('viewer-1');
    assert.equal(store.getState().historyPickA?.commitId, 'c1');
  });
});

describe('historyTeardown', () => {
  const scope = {
    kind: 'model-removed' as const,
    modelId: 'viewer-1',
    isStale: () => false,
    nextActiveModelId: null,
  };

  it('owns exactly the model-keyed fields, and not the panel flag', () => {
    assert.deepEqual([...historyTeardown.owns].sort(), [
      'commitTags',
      'historyFocusModelId',
      'historyNewHeads',
      'historyPickA',
      'historyPickB',
      'localLineage',
    ]);
    assert.ok(
      !historyTeardown.owns.includes('historyPanelVisible' as never),
      'the docked-panel flag is where the user left their workspace; no other panel destroys it on a file swap',
    );
  });

  it('drops the removed model tag and leaves the others', () => {
    const state = {
      commitTags: new Map([['viewer-1', tag('c1')], ['viewer-2', tag('c2')]]),
      localLineage: new Map(),
      historyNewHeads: new Map(),
      historyFocusModelId: 'viewer-2',
    } as unknown as Readonly<Partial<ViewerState>>;

    const patch = historyTeardown.teardown(scope, state) as { commitTags?: Map<string, CommitTag> };
    assert.deepEqual([...patch.commitTags!.keys()], ['viewer-2']);
  });

  it('drops a lineage link whose BASE model was removed', () => {
    const state = {
      commitTags: new Map(),
      localLineage: new Map([
        ['viewer-3', { baseModelId: 'viewer-1', decidedAt: 1, evidence: {} }],
      ]),
      historyNewHeads: new Map(),
      historyFocusModelId: null,
    } as unknown as Readonly<Partial<ViewerState>>;

    const patch = historyTeardown.teardown(scope, state) as { localLineage?: Map<string, unknown> };
    assert.equal(
      patch.localLineage!.size,
      0,
      'a link pointing at a model that is gone describes a lineage nothing can resolve',
    );
  });

  it('clears the focus when the focused model is the one removed', () => {
    const state = {
      commitTags: new Map(),
      localLineage: new Map(),
      historyNewHeads: new Map(),
      historyFocusModelId: 'viewer-1',
      historyPickA: { projectId: 'p1', modelId: 'sm1', commitId: 'c1' },
    } as unknown as Readonly<Partial<ViewerState>>;

    const patch = historyTeardown.teardown(scope, state) as Record<string, unknown>;
    assert.equal(patch.historyFocusModelId, null);
    assert.equal(patch.historyPickA, null);
  });

  it('writes nothing when the removed model was never tagged', () => {
    const state = {
      commitTags: new Map([['viewer-2', tag('c2')]]),
      localLineage: new Map(),
      historyNewHeads: new Map(),
      historyFocusModelId: 'viewer-2',
    } as unknown as Readonly<Partial<ViewerState>>;

    // Idempotence is what lets `syncSourceModel` re-run the same scope after
    // `removeModel` without re-allocating everything.
    assert.deepEqual(historyTeardown.teardown(scope, state), {});
  });

  it('empties everything on a session reset', () => {
    const patch = historyTeardown.teardown({ kind: 'session-reset' }, {}) as Record<string, unknown>;
    assert.equal((patch.commitTags as Map<string, unknown>).size, 0);
    assert.equal((patch.localLineage as Map<string, unknown>).size, 0);
    assert.equal(patch.historyFocusModelId, null);
  });
});
