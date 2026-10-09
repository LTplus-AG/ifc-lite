/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-030: IDS Studio is a registered side panel in the Check group with no
 * model gate (an IDS is authored before a model is loaded), and the
 * "IDS authoring" layout preset docks it above Data validation.
 * `registry.ts` and `layout-presets.ts` are light, pre-existing modules, so a
 * revert of this branch turns into an assertable data difference here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALT_SHORTCUT_PANELS, panelModelGateMode, WORKSPACE_PANELS } from './registry.js';
import { getLayoutPreset, planLayoutPreset, type WorkspaceLayoutState } from './layout-presets.js';

describe('IDS Studio panel registration (IDS-030)', () => {
  it('registers idsStudio in the Check group, docked in the side pane, without a model gate', () => {
    const entry = WORKSPACE_PANELS.find((p) => p.id === 'idsStudio');
    assert.ok(entry, "WORKSPACE_PANELS is missing the 'idsStudio' panel definition");
    assert.equal(entry.titleKey, 'idsStudio.title');
    assert.equal(entry.group, 'check');
    assert.equal(entry.region, 'side');
    assert.equal(panelModelGateMode('idsStudio'), undefined);
    assert.ok(!ALT_SHORTCUT_PANELS.some((p) => p.id === 'idsStudio'), 'appended: the frozen Alt+digit mapping is untouched');
  });

  it('the IDS authoring preset docks Studio above Data validation and puts both first on the rail', () => {
    const preset = getLayoutPreset('idsStudio');
    assert.ok(preset);
    const current: WorkspaceLayoutState = {
      order: ['hierarchy', 'properties', 'clash', 'validation', 'bcf', 'idsStudio', 'assistant'],
      hiddenIds: ['idsStudio'], expanded: false, primary: 'properties', secondary: null, detached: new Set(), assistantPlacement: 'dock',
    };
    const plan = planLayoutPreset(current, preset);
    assert.deepEqual(plan.order.slice(0, 5), ['hierarchy', 'properties', 'idsStudio', 'validation', 'assistant']);
    assert.equal(plan.primary, 'idsStudio');
    assert.equal(plan.secondary, 'validation');
    assert.deepEqual(plan.hiddenIds, [], 'a hidden Studio is shown again');
    assert.ok(!plan.changes.some((c) => c.kind === 'reserved'), 'every panel of the preset is registered');
  });
});
