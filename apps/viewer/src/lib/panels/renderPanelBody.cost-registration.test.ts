/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for the Cost panel's wiring (#4858).
 *
 * `CostPanel.federated-selection.test.tsx`, `CostPanel.teardown.test.tsx`
 * and `cost-tree.test.ts` cover the panel's actual behaviour (the five
 * cost-data states, federated `modelId:expressId` selection, teardown), but
 * every production file they exercise is wholly new — reverting the branch
 * deletes `CostPanel.tsx` and `cost-tree.ts` outright, so those suites die
 * at import (`ERR_MODULE_NOT_FOUND`) rather than failing an assertion. That
 * is a load failure, not a witness: the revert oracle correctly refuses to
 * credit it as coverage (verdict `REVERT-BROKE-BUILD`).
 *
 * This test instead goes through `renderPanelBody` and `WORKSPACE_PANELS` —
 * both PRE-EXISTING files whose diff is a small, self-contained hunk (a
 * union member, an array entry, a switch case, an import line). Reverting
 * the branch reverts those hunks along with everything else, so the file
 * keeps compiling — it just no longer wires up 'cost'. That turns the
 * revert into an observable behaviour change instead of a build break:
 * `renderPanelBody('cost', ...)` falls out of the switch and returns
 * `undefined`, and `WORKSPACE_PANELS` no longer lists a 'cost' entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderPanelBody } from './renderPanelBody.js';
import { WORKSPACE_PANELS } from './registry.js';

describe('renderPanelBody — cost panel registration (#4858)', () => {
  it('WORKSPACE_PANELS registers a cost entry', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'cost');
    assert.notEqual(entry, undefined, "WORKSPACE_PANELS is missing the 'cost' panel definition");
    assert.equal(entry?.title, 'Cost');
  });

  it("renderPanelBody('cost', ...) returns a rendered element, not undefined", () => {
    const element = renderPanelBody('cost', () => {});
    assert.notEqual(element, undefined, "renderPanelBody has no case for 'cost' — the Cost panel is unreachable");
  });
});
