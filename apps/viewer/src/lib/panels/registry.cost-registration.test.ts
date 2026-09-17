/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Cost panel's registration (#4858).
 *
 * `CostPanel.federated-selection.test.tsx`, `CostPanel.teardown.test.tsx`
 * and `cost-tree.test.ts` cover the panel's actual behaviour (the five
 * cost-data states, federated `modelId:expressId` selection, teardown), but
 * every production file they exercise is wholly new — reverting the branch
 * deletes `CostPanel.tsx` and `cost-tree.ts` outright, so those suites die
 * at import (`ERR_MODULE_NOT_FOUND`) rather than failing an assertion. That
 * is a load failure, not a witness.
 *
 * `renderPanelBody.tsx` is a pre-existing entry point too, and its own hunk
 * (the `case 'cost': return <CostPanel .../>`) survives a revert the same
 * way — but it unconditionally imports every panel component, which pulls
 * in the viewer store at module scope and hits an unrelated pre-existing
 * `localStorage is not defined` ReferenceError under `node:test` (no DOM).
 * That text matches the oracle's `LOAD_ERROR_PATTERNS` — deliberately broad,
 * per its own comment, because that shape is usually a dead import — so a
 * real, correctly-red assertion there still reads as a load failure.
 *
 * `registry.ts` is the lighter of the two: its own docblock notes it is kept
 * "free of heavy imports" (only `lucide-react` icons and type defs) so that
 * `renderPanelBody` alone carries the panel-component weight. Reverting the
 * branch reverts its hunk too (the `WorkspacePanelId` union member and the
 * `WORKSPACE_PANELS` array entry), so the file keeps compiling — it just no
 * longer lists 'cost'. That turns the revert into a plain, assertable data
 * difference instead of a build break or a console-noise false negative.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry.js';

describe('WORKSPACE_PANELS — cost panel registration (#4858)', () => {
  it('registers a cost entry', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'cost');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'cost' panel definition");
    assert.equal(entry?.title, 'Cost');
    assert.equal(entry?.group, 'inspect');
  });
});
