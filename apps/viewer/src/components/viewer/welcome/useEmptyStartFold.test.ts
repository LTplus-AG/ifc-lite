/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen folds Hierarchy and a Properties-only sidebar pane while
 * the viewer is empty. These pin WHEN: never while a model is loading or
 * loaded, and never over a panel the user (or the welcome card) opened.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyStart, startFoldsSidebarPane } from './useEmptyStartFold.js';

type State = Parameters<typeof startFoldsSidebarPane>[0];

const empty: State = {
  models: new Map(),
  geometryResult: null,
  loading: false,
  sidebarActivePanel: 'properties',
  sidebarSecondaryPanel: null,
};

describe('start-screen panel fold', () => {
  it('folds both sides on an empty, idle viewer', () => {
    assert.equal(isEmptyStart(empty), true);
    assert.equal(startFoldsSidebarPane(empty), true);
  });

  it('unfolds the moment a model starts loading', () => {
    const loading: State = { ...empty, loading: true };
    assert.equal(isEmptyStart(loading), false);
    assert.equal(startFoldsSidebarPane(loading), false);
  });

  it('unfolds once a model is loaded', () => {
    // Only `models.size` is read; a one-entry map stands in for a federated model.
    const models: State['models'] = new Map();
    models.set('m1', models.get('none') ?? Object.create(null));
    assert.equal(isEmptyStart({ ...empty, models }), false);
  });

  it('keeps the sidebar pane open for any panel other than Properties', () => {
    assert.equal(startFoldsSidebarPane({ ...empty, sidebarActivePanel: 'sources' }), false);
    assert.equal(startFoldsSidebarPane({ ...empty, sidebarSecondaryPanel: 'bcf' }), false);
  });
});
