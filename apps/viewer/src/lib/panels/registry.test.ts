/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  WORKSPACE_PANELS,
  isBottomPanel,
  isWorkspacePanelId,
  workspacePanelForShortcutCode,
} from './registry.js';

// Pure routing the Alt+digit keyboard shortcut depends on (#1200/#1208). The
// hook itself needs a DOM to test; this locks the decision it delegates to.
describe('workspacePanelForShortcutCode (Alt+digit routing #1200/#1208)', () => {
  it('Digit1 opens the first panel (Information)', () => {
    assert.strictEqual(workspacePanelForShortcutCode('Digit1'), WORKSPACE_PANELS[0].id);
    assert.strictEqual(workspacePanelForShortcutCode('Digit1'), 'properties');
  });

  it('Digit9 opens the ninth panel; Digit0 wraps to the tenth', () => {
    assert.strictEqual(workspacePanelForShortcutCode('Digit9'), WORKSPACE_PANELS[8].id);
    assert.strictEqual(workspacePanelForShortcutCode('Digit0'), WORKSPACE_PANELS[9].id);
  });

  it('Numpad codes route identically to Digit codes (layout-independent)', () => {
    assert.strictEqual(
      workspacePanelForShortcutCode('Numpad5'),
      workspacePanelForShortcutCode('Digit5'),
    );
    assert.strictEqual(workspacePanelForShortcutCode('Numpad0'), WORKSPACE_PANELS[9].id);
  });

  it('the ten digit shortcuts map to the first ten registry panels, in order', () => {
    const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    const ids = codes.map((c) => workspacePanelForShortcutCode(c));
    assert.ok(ids.every((id) => id !== undefined && isWorkspacePanelId(id)));
    assert.strictEqual(new Set(ids).size, codes.length, 'no two digits collide');
    // Only the first ten registry entries get an Alt shortcut; later additions
    // (e.g. Hierarchy, #1267) are reachable from the rail but have no digit.
    assert.deepStrictEqual(ids, WORKSPACE_PANELS.slice(0, 10).map((p) => p.id));
  });

  it('registry panels past the tenth have no Alt+digit shortcut (#1267)', () => {
    // Hierarchy is appended so the frozen Alt+1..0 mapping stays intact.
    assert.ok(WORKSPACE_PANELS.length >= 11, 'expected Hierarchy appended to the registry');
    const shortcutTargets = new Set(
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']
        .map((c) => workspacePanelForShortcutCode(c)),
    );
    for (const def of WORKSPACE_PANELS.slice(10)) {
      assert.ok(!shortcutTargets.has(def.id), `${def.id} should not be bound to a digit`);
    }
  });

  it('bottom-strip panels are reachable by shortcut and flagged as bottom', () => {
    // Script / Schedule / Lists are the last three (Alt+8 / Alt+9 / Alt+0).
    const last = workspacePanelForShortcutCode('Digit0');
    assert.ok(last !== undefined && isBottomPanel(last));
    const ninth = workspacePanelForShortcutCode('Digit8');
    assert.ok(ninth !== undefined && isBottomPanel(ninth));
  });

  it('non-digit and malformed codes return undefined (other Alt combos fall through)', () => {
    for (const code of ['KeyA', 'Backslash', 'Digit', 'Numpad', 'F1', '', 'Digit12', 'digit1']) {
      assert.strictEqual(workspacePanelForShortcutCode(code), undefined, code);
    }
  });
});
