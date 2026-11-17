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

// #8946 round 2: irrelevant subsequences must not crowd out clear answers.
describe('command palette fuzzy fallback (#8946)', () => {
  const make = (id: string, label: string, keywords = ''): Command => ({ ...command(), id, label, keywords });
  const commands = [
    make('annotate', 'Annotate'), make('annotations', 'Annotations'),
    make('validation', 'Data validation', 'validation annotation checking'),
    make('noise', 'Export anonymized subset', 'anonymization output'),
    make('section', 'Section plane'),
  ];

  it('keeps direct labels and metadata and suppresses fuzzy-only matches for annot', () => {
    assert.ok(rankCommand(commands[3], 'annot') > 0, 'fixture exercises the fuzzy noise');
    assert.deepEqual(searchCommands(commands, 'annot', ['noise']).map(cmd => cmd.id),
      ['annotate', 'annotations', 'validation']);
  });

  it('keeps the secton typo fallback when no direct hit exists', () => {
    assert.deepEqual(searchCommands(commands, 'secton', []).map(cmd => cmd.id), ['section']);
  });

  it('#8947 ranks a visible-name typo ahead of hidden aliases despite registry order and recency', () => {
    const rows = [make('down', 'Down (Z)', 'section plane down'), make('section', 'Section')];
    assert.deepEqual(searchCommands(rows, 'secton', ['down']).map(cmd => cmd.id), ['section', 'down']);
    assert.ok(rankCommand(rows[0], 'secton') > 0, 'the alias remains discoverable');
  });

  it('#8947 preserves localized-name typo priority over hidden metadata', () => {
    const rows = [make('down', 'Down (Z)', 'Schnitt'), make('section', 'Section')];
    assert.deepEqual(searchCommands(rows, 'schnt', ['down'],
      cmd => cmd.id === 'section' ? 'Schnitt' : cmd.label).map(cmd => cmd.id), ['section', 'down']);
  });

  it('applies the same suppression to translated labels and categories', () => {
    const rows = [make('translated', 'Section plane'), make('noise', 'Sicherheit')];
    assert.ok(rankCommand(rows[1], 'sicht') > 0, 'translated search has a fuzzy alternative');
    assert.deepEqual(searchCommands(rows, 'sicht', [],
      cmd => cmd.id === 'translated' ? 'Sicht' : cmd.label).map(cmd => cmd.id), ['translated']);
    assert.deepEqual(searchCommands(rows, 'sicht', [], undefined,
      cmd => cmd.id === 'translated' ? 'Sicht' : 'Tools').map(cmd => cmd.id), ['translated']);
  });
});
