/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georef placement editor implies edit mode, and edit mode is the Model
 * workspace (#6232): turning the editor on enters the workspace rather than
 * setting a bare `editEnabled` that no session backs, and a role that cannot
 * edit gets neither.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ editEnabled: false, cesiumPlacementEditMode: false });
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true, cesiumPlacementEditMode: false });
});

describe('georef placement editor and the Model workspace (#6232 WP2)', () => {
  it('turning the editor on enters the workspace; edit mode and workspace agree', () => {
    useViewerStore.getState().toggleCesiumPlacementEditMode();
    const s = useViewerStore.getState();
    assert.equal(s.cesiumPlacementEditMode, true);
    assert.equal(s.editEnabled, true);
    assert.equal(s.workspaceMode, 'model');
  });

  it('a role that cannot edit turns on neither', () => {
    useViewerStore.setState({ collabRole: 'viewer', canCollabEdit: () => false });
    useViewerStore.getState().setCesiumPlacementEditMode(true);
    const s = useViewerStore.getState();
    assert.equal(s.cesiumPlacementEditMode, false);
    assert.equal(s.editEnabled, false);
    assert.equal(s.workspaceMode, 'view');
  });
});
