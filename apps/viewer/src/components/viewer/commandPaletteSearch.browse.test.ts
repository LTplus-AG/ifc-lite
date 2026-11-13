/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseCommands, searchCommands, type Command } from './commandPaletteSearch.js';

const command = (id: string, category: Command['category']): Command => ({
  id, category, label: id, runtimeSource: 'script-template', keywords: '', icon: () => null, action: () => {},
});

test('extension and Learn rows stay in their browse groups (#5862)', () => {
  const { grouped, flatItems } = browseCommands([
    command('learn:hub', 'Learn'),
    command('ext:example', 'Extensions'),
    command('panel:cost', 'Panels'),
  ], []);

  assert.deepEqual(grouped.map((group) => group.category), ['Panels', 'Extensions', 'Learn']);
  assert.deepEqual(flatItems.map((item) => item.cmd.id), ['panel:cost', 'ext:example', 'learn:hub']);
});

// #8947 R3: only inactive recovery leaves browse; unavailable tools stay discoverable.
test('browse omits inactive recovery even from recents, keeps live recovery and every search result (#8947)', () => {
  const recoveryIds = ['file:cancel-load', 'file:retry-load', 'file:dismiss-load-error'];
  const recovery = recoveryIds.map((id): Command => ({ ...command(id, 'File'),
    availability: { status: 'disabled', reasonKey: 'commandPalette.availability.noLoadError' } }));
  const other: Command = { ...command('vis:hide', 'Visibility'),
    availability: { status: 'disabled', reasonKey: 'commandPalette.availability.selection' } };
  const rows = [...recovery, other, command('file:open', 'File')];
  const recents = [...recoveryIds, other.id];
  const browse = browseCommands(rows, recents);
  assert.deepEqual(browse.grouped.find(group => group.category === 'Recent')?.items.map(item => item.cmd.id), [other.id]);
  assert.ok(browse.flatItems.every(item => !recoveryIds.includes(item.cmd.id)));
  assert.ok(browse.flatItems.some(item => item.cmd.id === other.id), 'ordinary unavailable command stays in browse');
  for (const id of recoveryIds) {
    assert.ok(searchCommands(rows, id, recents).some(cmd => cmd.id === id), 'inactive recovery stays searchable');
  }
  for (const active of [['file:cancel-load'], ['file:retry-load', 'file:dismiss-load-error']]) {
    const live = browseCommands(rows.map((cmd): Command => active.includes(cmd.id)
      ? { ...cmd, availability: { status: 'available' } } : cmd), recents);
    assert.deepEqual(live.grouped.find(group => group.category === 'Recent')?.items.map(item => item.cmd.id), [...active, other.id]);
    assert.deepEqual(live.flatItems.filter(item => recoveryIds.includes(item.cmd.id)).map(item => item.cmd.id), [...active, ...active]);
    assert.deepEqual(live.flatItems.map(item => item.flatIdx), live.flatItems.map((_, index) => index));
  }
});
