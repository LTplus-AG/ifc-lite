/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Placement panel's registration (#5505: the
 * docked side panel with Local / Georeference tabs that replaced the
 * floating `RepositionPanel` and the floating `CesiumPlacementEditor`).
 * Same reasoning `registry.environment-registration.test.ts` documents
 * (#5506) — `PlacementPanel.test.tsx` (via `LocalTab.test.tsx` /
 * `GeoreferenceTab.mapAbsolute.test.tsx`) covers rendered content, but those
 * production files are wholly new, so a revert kills that suite at import
 * rather than failing an assertion. `registry.ts` stays free of heavy
 * imports, so a revert of the branch's hunk here turns into a plain,
 * assertable data difference instead of a build break.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry.js';

describe('WORKSPACE_PANELS — placement panel registration (#5505)', () => {
  it('registers a placement entry', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'placement');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'placement' panel definition");
    assert.equal(entry?.title, 'Placement');
    assert.equal(entry?.region, 'side');
  });

  it('is appended after the frozen Alt+1..9/0 shortcut range (#1200)', () => {
    const index = WORKSPACE_PANELS.findIndex((p) => p.id === 'placement');
    assert.ok(index >= 10, `expected 'placement' past index 9 (no Alt shortcut), was at ${index}`);
  });
});
