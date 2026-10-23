/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentBlock } from './types';
import { reorderDocumentBlocks } from './reorder-blocks';

const blocks: DocumentBlock[] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ kind: 'text', id, text: id, style: 'body' }));
it('#8066 moves a noncontiguous group in document order and retains every authored object', () => {
  const selected = new Set(['d', 'b']);
  for (const [before, expected] of [[null, 'acebd'], ['a', 'bdace'], ['c', 'abdce'], ['e', 'acbde']] as const) {
    const next = reorderDocumentBlocks(blocks, selected, before);
    assert.equal(next.map(block => block.id).join(''), expected);
    for (const block of next) assert.equal(block, blocks.find(original => original.id === block.id));
    assert.equal(blocks.map(block => block.id).join(''), 'abcde', 'input remains unchanged');
  }
});
it('#8066 empty, stale, selected-target and unchanged moves are no-ops', () => {
  for (const [ids, before] of [[[], null], [['gone'], null], [['b', 'd'], 'd'], [['b'], 'gone'], [['e'], null], [['a', 'b', 'c', 'd', 'e'], null]] as const) {
    assert.equal(reorderDocumentBlocks(blocks, new Set(ids), before), blocks);
  }
});
