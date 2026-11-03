/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen folds Hierarchy and a Properties-only sidebar pane while
 * the viewer is empty. These pin WHEN: never while a model is loading or
 * loaded, never over a panel the user (or the welcome card) opened — and that
 * an explicit panel action while folded lifts the fold instead of writing the
 * stored layout behind a pane the user cannot see (#8728 review).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { isEmptyStart, liftStartFold, startFoldsHierarchy, startFoldsSidebarPane } from './useEmptyStartFold.js';

type State = Parameters<typeof startFoldsSidebarPane>[0];

const empty: State = {
  models: new Map(),
  geometryResult: null,
  loading: false,
  sidebarActivePanel: 'properties',
  sidebarSecondaryPanel: null,
  startFoldLifted: { left: false, right: false },
};

describe('start-screen panel fold', () => {
  it('folds both sides on an empty, idle viewer', () => {
    assert.equal(isEmptyStart(empty), true);
    assert.equal(startFoldsHierarchy(empty), true);
    assert.equal(startFoldsSidebarPane(empty), true);
  });

  it('unfolds the moment a model starts loading', () => {
    const loading: State = { ...empty, loading: true };
    assert.equal(isEmptyStart(loading), false);
    assert.equal(startFoldsHierarchy(loading), false);
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

  it('honours a lift per side', () => {
    const left: State = { ...empty, startFoldLifted: { left: true, right: false } };
    assert.equal(startFoldsHierarchy(left), false);
    assert.equal(startFoldsSidebarPane(left), true, 'lifting Hierarchy must not open the Properties pane');
  });
});

describe('liftStartFold (store)', () => {
  const RESET = {
    loading: false,
    models: new Map(),
    geometryResult: null,
    leftPanelCollapsed: false,
    sidebarActivePanel: 'properties',
    sidebarSecondaryPanel: null,
    startFoldLifted: { left: false, right: false },
  } as const;
  afterEach(() => useViewerStore.setState(RESET));

  it('reveals a folded Hierarchy without writing the stored collapse state', () => {
    useViewerStore.setState(RESET);
    assert.equal(liftStartFold('left'), true, 'the fold was hiding Hierarchy');
    const s = useViewerStore.getState();
    assert.deepEqual(s.startFoldLifted, { left: true, right: false });
    assert.equal(s.leftPanelCollapsed, false, 'the user\'s preference is untouched');
    assert.equal(startFoldsHierarchy(s), false);
  });

  it('does nothing when nothing is folded, so a real toggle still toggles', () => {
    useViewerStore.setState({ ...RESET, loading: true });
    assert.equal(liftStartFold('left'), false);
    assert.deepEqual(useViewerStore.getState().startFoldLifted, { left: false, right: false });
  });
});

describe('palette panel commands on the folded start screen (#8728 review)', () => {
  const RESET = {
    loading: false,
    models: new Map(),
    geometryResult: null,
    leftPanelCollapsed: false,
    sidebarActivePanel: 'properties',
    sidebarSecondaryPanel: null,
    startFoldLifted: { left: false, right: false },
  } as const;
  afterEach(() => useViewerStore.setState(RESET));

  it('"Properties" reveals the folded pane instead of re-selecting a hidden panel', async () => {
    useViewerStore.setState(RESET);
    const { surfaceCommand } = await import('../surface-commands.js');
    surfaceCommand('panel:properties', 'palette').run({ surface: 'palette' });
    assert.equal(startFoldsSidebarPane(useViewerStore.getState()), false, 'the Properties pane is shown');
  });

  it('"Hierarchy" reveals the folded panel without storing "collapsed"', async () => {
    useViewerStore.setState(RESET);
    const { surfaceCommand } = await import('../surface-commands.js');
    surfaceCommand('panel:tree', 'palette').run({ surface: 'palette' });
    const s = useViewerStore.getState();
    assert.equal(startFoldsHierarchy(s), false, 'Hierarchy is shown');
    assert.equal(s.leftPanelCollapsed, false, 'the toggle did not flip the stored preference');
  });
});
