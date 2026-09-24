/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Environment panel's registration (#5506:
 * the docked side panel that replaced the floating "Sun & Sky" panel).
 *
 * `EnvironmentPanel.i18n.test.tsx` covers the panel's own rendered content,
 * but that production file is wholly new — reverting the branch deletes
 * `EnvironmentPanel.tsx` outright, so that suite dies at import
 * (`ERR_MODULE_NOT_FOUND`) rather than failing an assertion. That is a load
 * failure, not a witness (see `registry.cost-registration.test.ts`, the same
 * shape for the Cost panel, #4858).
 *
 * `registry.ts` is the lighter of the two: its own docblock notes it is kept
 * "free of heavy imports" (only `lucide-react` icons and type defs) so that
 * `renderPanelBody` alone carries the panel-component weight. Reverting the
 * branch reverts its hunk too (the `WorkspacePanelId` union member and the
 * `WORKSPACE_PANELS` array entry), so the file keeps compiling — it just no
 * longer lists 'environment'. That turns the revert into a plain, assertable
 * data difference instead of a build break or a console-noise false negative.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry.js';

describe('WORKSPACE_PANELS — environment panel registration (#5506)', () => {
  it('registers an environment entry', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'environment');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'environment' panel definition");
    assert.equal(entry?.title, 'Environment');
    assert.equal(entry?.region, 'side');
  });

  it('is appended after the frozen Alt+1..9/0 shortcut range (#1200)', () => {
    const index = WORKSPACE_PANELS.findIndex((p) => p.id === 'environment');
    assert.ok(index >= 10, `expected 'environment' past index 9 (no Alt shortcut), was at ${index}`);
  });
});
