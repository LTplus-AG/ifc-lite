/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankCommand, score, type Command } from './commandPaletteSearch.js';

// @ts-expect-error #5878: a palette option cannot invent a static command label without a registry id or runtime owner.
const unownedOption: Command = { id: 'raw:foo', label: 'Foo', keywords: '', category: 'Tools', icon: () => null, action: () => {} };
void unownedOption;

function command(): Command {
  return {
    id: 'auto:export-json',
    label: 'Export JSON',
    runtimeSource: 'script-template',
    keywords: 'download data',
    category: 'Export',
    icon: () => null,
    action: () => {},
  };
}

describe('command palette search extraction (#3957)', () => {
  it('preserves exact, initials, fuzzy, and rejected-match score tiers', () => {
    assert.equal(score('json', 'Export JSON'), 100);
    assert.equal(score('ej', 'Export JSON'), 50);
    assert.ok(score('ept', 'Export') > 0 && score('ept', 'Export') < 50);
    assert.equal(score('xyz', 'Export JSON'), 0);
  });

  it('keeps label matches ahead of keyword and category matches', () => {
    const cmd = command();
    assert.equal(rankCommand(cmd, 'json'), 100);
    assert.equal(rankCommand(cmd, 'download'), 90);
    assert.equal(rankCommand(cmd, 'export'), 100);
  });
});
