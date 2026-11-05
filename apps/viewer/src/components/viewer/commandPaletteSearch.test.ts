/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankCommand, score, searchCommands, type Command } from './commandPaletteSearch.js';

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

describe('command palette search tiers (#8946)', () => {
  it('orders exact, prefix, word-start, initials, substring and fuzzy label matches', () => {
    const labels = ['CS', 'CS export', 'Open CS', 'Color Spaces', 'Acscore', 'Caves'];
    const scores = labels.map(label => score('cs', label));
    assert.ok(scores.every((value, index) => value > 0 && (index === 0 || scores[index - 1] > value)),
      'every label match tier strictly outranks the next');
    assert.equal(score('xyz', 'Export JSON'), 0);
    assert.equal(score('   ', 'Export JSON'), 0);
  });

  it('keeps every direct label tier above keywords, then category, then fuzzy fallback', () => {
    const cmd = command();
    const substring = rankCommand({ ...cmd, label: 'Wireframe', keywords: '', category: 'Tools' }, 'frame');
    const keywords = rankCommand({ ...cmd, keywords: 'frame' }, 'frame');
    const category = rankCommand({ ...cmd, keywords: '', category: 'Tools' }, 'tools');
    const fuzzy = rankCommand({ ...cmd, label: 'Frapme', keywords: '', category: 'Tools' }, 'frame');
    assert.ok(substring > keywords && keywords > category && category > fuzzy && fuzzy > 0);
  });

  it('searches localized and English labels equally, plus localized categories', () => {
    const cmd = command();
    assert.equal(rankCommand(cmd, 'JSON exportieren', 'JSON exportieren'), rankCommand(cmd, 'Export JSON'));
    assert.ok(rankCommand(cmd, 'exportieren', 'JSON exportieren') > rankCommand(cmd, 'download'));
    assert.ok(rankCommand(cmd, 'Ausgabe', undefined, 'Ausgabe') > 0);
  });

  it('uses recency only within a tier, then stable registry order', () => {
    const make = (id: string, label: string) => ({ ...command(), id, label, keywords: '' });
    const commands = [make('a', 'Frame all'), make('b', 'Frame selection'), make('c', 'Frame model'), make('exact', 'Frame')];
    assert.deepEqual(searchCommands(commands, 'frame', ['b', 'c', 'removed']).map(cmd => cmd.id), ['exact', 'b', 'c', 'a']);
    assert.deepEqual(searchCommands(commands, 'frame', []).map(cmd => cmd.id), ['exact', 'a', 'b', 'c']);
    assert.deepEqual(searchCommands(commands, 'no-such-command', []), []);
  });
});
