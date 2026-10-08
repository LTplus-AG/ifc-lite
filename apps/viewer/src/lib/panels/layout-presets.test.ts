/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry';
import { COORDINATOR_PRESET, planLayoutPreset, type WorkspaceLayoutState } from './layout-presets';

const current = (): WorkspaceLayoutState => ({
  order: WORKSPACE_PANELS.map(panel => panel.id), hiddenIds: ['clash', 'environment'],
  expanded: false, primary: 'properties', secondary: null,
  detached: new Set(), assistantPlacement: 'dock',
});

test('#6926 coordinator layout preserves every tool and exposes its coordination shortcuts', () => {
  const input = current();
  const plan = planLayoutPreset(input, COORDINATOR_PRESET);
  assert.equal(new Set(plan.order).size, input.order.length);
  assert.deepEqual([...plan.order].sort(), [...input.order].sort());
  assert.ok(plan.order.indexOf('clash') < plan.order.indexOf('environment'));
  assert.deepEqual(plan.hiddenIds, ['environment']);
  assert.equal(plan.primary, 'clash');
  assert.equal(plan.secondary, 'bcf');
  assert.equal(plan.assistantPlacement, 'split');
  assert.ok(plan.changes.some(change => change.kind === 'expand'));
  assert.deepEqual(input.hiddenIds, ['clash', 'environment'], 'preview leaves the current layout intact');
});

test('#6926 a detached coordination panel is never pulled back into the dock by a preset', () => {
  const input = { ...current(), detached: new Set(['clash'] as const) };
  const plan = planLayoutPreset(input, COORDINATOR_PRESET);
  assert.equal(plan.primary, null);
  assert.equal(plan.secondary, null);
  assert.ok(plan.changes.some(change => change.kind === 'keepDetached' && change.ids.includes('clash')));
});

test('#6926 a missing reserved panel is reported rather than invented in the rail', () => {
  const plan = planLayoutPreset(current(), { ...COORDINATOR_PRESET, rail: [...COORDINATOR_PRESET.rail, 'future-panel'] });
  assert.ok(plan.changes.some(change => change.kind === 'reserved' && change.ids.includes('future-panel')));
  assert.equal(plan.order.some(id => String(id) === 'future-panel'), false);
});
