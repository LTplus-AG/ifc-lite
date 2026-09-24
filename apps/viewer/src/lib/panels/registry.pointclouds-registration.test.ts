/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Point Clouds side panel's registration
 * (#5507), same shape as `registry.cost-registration.test.ts` (#4858).
 *
 * `PointCloudPanel.i18n.test.tsx` and the ActivityBar/ViewportOverlays
 * suites below cover the panel's actual behaviour, but `PointCloudPanel.tsx`
 * itself predates this issue (it used to render as a floating card) — a
 * revert of #5507 does not delete that file, it only reverts the
 * `WorkspacePanelId` union member and the `WORKSPACE_PANELS` array entry
 * here. `registry.ts` stays free of heavy imports (only `lucide-react` icons
 * and type defs), so it keeps compiling either way — this test is what turns
 * "no longer lists 'pointclouds'" into an assertable failure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry.js';

describe('WORKSPACE_PANELS — point clouds panel registration (#5507)', () => {
  it('registers a pointclouds entry', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'pointclouds');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'pointclouds' panel definition");
    assert.equal(entry?.title, 'Point Clouds');
    assert.equal(entry?.region, 'side');
    assert.equal(entry?.group, 'inspect');
  });
});
