/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Measurements panel's registration (#5502).
 * `MeasurementsPanel.test.tsx` covers the panel's own content, but that
 * production file is wholly new, so reverting the branch makes that suite
 * fail to LOAD rather than fail an assertion. `registry.ts` keeps compiling
 * after a revert (it only loses the union member and the array entry), so
 * this turns the revert into a plain, assertable data difference — the same
 * shape as `registry.environment-registration.test.ts` (#5506).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry.js';

describe('WORKSPACE_PANELS — measurements panel registration (#5502)', () => {
  it('registers a measurements side panel', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'measurements');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'measurements' panel definition");
    assert.equal(entry?.title, 'Measurements');
    assert.equal(entry?.region, 'side');
  });

  it('is appended after the frozen Alt+1..9/0 shortcut range (#1200)', () => {
    const index = WORKSPACE_PANELS.findIndex((p) => p.id === 'measurements');
    assert.ok(index >= 10, `expected 'measurements' past index 9 (no Alt shortcut), was at ${index}`);
  });
});
