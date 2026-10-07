/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS } from './registry';
import { migrateSidebarLayout } from './layout-migration';

test('#6927 old custom layouts keep ordering and unknown extension placements while adding all registered tools', () => {
  const input = { order: ['clash', 'extension:custom', 'ids', 'properties'], hiddenIds: ['extension:custom', 'ids'], mode: 'collapsed', widthPct: 30 };
  const result = migrateSidebarLayout(input);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.layout.mode, 'collapsed');
  assert.ok(result.layout.order.indexOf('clash') < result.layout.order.indexOf('validation'));
  assert.ok(result.layout.hiddenIds.includes('validation'));
  assert.deepEqual(result.layout.preserved, [{ id: 'extension:custom', after: 'clash', hidden: true }]);
  assert.equal(new Set(result.layout.order).size, WORKSPACE_PANELS.length);
  assert.ok(result.changes.some(change => change.kind === 'renamed' && change.from === 'ids'));
  assert.deepEqual(input.order, ['clash', 'extension:custom', 'ids', 'properties']);
});

test('#6927 a versioned layout restores newly available panels at their preserved anchor', () => {
  const result = migrateSidebarLayout({ version: 2, mode: 'expanded', widthPct: 30, order: ['clash', 'properties'], hiddenIds: [],
    preserved: [{ id: 'assistant', after: 'clash', hidden: true }] });
  assert.equal(result.layout.order[result.layout.order.indexOf('clash') + 1], 'assistant');
  assert.ok(result.layout.hiddenIds.includes('assistant'));
  assert.ok(result.changes.some(change => change.kind === 'restored' && change.id === 'assistant'));
});

test('#6927 a newly shipped Assistant joins the final captured Coordinate panel instead of the rail tail', () => {
  const input = { order: [...WORKSPACE_PANELS.map(panel => panel.id).filter(id => id !== 'assistant' && id !== 'properties' && id !== 'compare'), 'properties', 'compare'],
    mode: 'expanded', hiddenIds: [] };
  const result = migrateSidebarLayout(input);
  assert.equal(result.layout.order[result.layout.order.indexOf('properties') + 1], 'assistant');
  assert.deepEqual(result.layout.order.filter(id => id !== 'assistant'), input.order);
});
