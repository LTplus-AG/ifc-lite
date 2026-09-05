/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankCommand, score, type Command } from './commandPaletteSearch.js';

function command(overrides: Partial<Command> = {}): Command {
  return {
    id: 'export:json',
    label: 'Export JSON',
    keywords: 'download data',
    category: 'Export',
    icon: () => null,
    action: () => {},
    ...overrides,
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
