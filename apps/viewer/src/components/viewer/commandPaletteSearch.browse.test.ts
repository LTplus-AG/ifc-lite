/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseCommands, type Command } from './commandPaletteSearch.js';

const command = (id: string, category: Command['category']): Command => ({
  id, category, label: id, keywords: '', icon: () => null, action: () => {},
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
