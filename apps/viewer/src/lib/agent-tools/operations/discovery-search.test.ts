/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankSearch, stem, tokenize } from './discovery-search';
import { rankOperations, viewerOperations } from './registry';

const top = (query: string, n = 3) => rankOperations(query).slice(0, n).map(op => op.id);

describe('agent discovery ranker', () => {
  it('keeps express_ids one token, so it is not the IDS standard', () => {
    for (const text of ['express_ids', 'expressIds', 'express ids']) {
      const tokens = tokenize(text);
      assert.equal(tokens.length, 1, text);
      assert.ok(!tokens.includes('ids'), text);
    }
    assert.ok(tokenize('run IDS check').includes('ids'));
    assert.ok(top('ids check', 5).some(id => id.startsWith('validation.') || id.startsWith('ids.')), top('ids check', 5).join(', '));
  });
  it('does not tie validation words to every operation that takes express_ids', () => {
    const first = top('validate model', 10);
    assert.ok(first.includes('model.audit'), first.join(', '));
    assert.ok(!first.some(id => /^(selection|visibility|appearance)\./.test(id)), first.join(', '));
  });
  it('splits ids, camelCase and separators, and agrees on inflections', () => {
    assert.deepEqual(tokenize('appearance.resetAll'), ['appearanc', 'reset', 'all']);
    assert.deepEqual(tokenize('idsStudio load_BCF-file'), ['ids', 'studio', 'load', 'bcf', 'file']);
    for (const [a, b] of [['measurements', 'measure'], ['colorize', 'color'], ['walls', 'wall'], ['clipping', 'clip'], ['boxes', 'box']]) {
      assert.equal(stem(a), stem(b), `${a} ~ ${b}`);
    }
    assert.equal(stem('ids'), 'ids', 'an acronym is not a plural');
  });

  it('finds the real catalogue operation for task phrasing a substring match missed', () => {
    for (const [query, expected] of [
      ['measure distance', 'measurements.distance'], ['color walls', 'appearance.colorize'], ['colour walls', 'appearance.colorize'],
      ['take a screenshot', 'exports.screenshot'], ['isolate walls', 'visibility.isolate'], ['hide', 'visibility.hide'],
    ]) assert.ok(top(query).includes(expected), `${query}: ${top(query).join()}`);
  });

  it('ranks all-token matches first and keeps partial matches instead of dropping them', () => {
    assert.equal(rankOperations('measure distance zzzunknown')[0]?.id, 'measurements.distance');
    assert.ok(rankOperations('walls').length > 0, 'an element noun reaches entity operations through synonyms');
  });

  it('is deterministic and lists everything in catalogue order for an empty query', () => {
    const all = viewerOperations().map(op => op.id);
    assert.deepEqual(rankOperations('').map(op => op.id), all);
    assert.deepEqual(rankOperations('the of').map(op => op.id), all, 'stopwords alone are an empty query');
    assert.deepEqual(top('section cut', 20), top('section cut', 20));
    assert.deepEqual(rankOperations('qqqxyzzy'), []);
  });

  it('scores primary-field hits above secondary ones', () => {
    const items = [{ name: 'other', text: 'export things' }, { name: 'export', text: 'unrelated' }];
    const ranked = rankSearch(items, 'export', item => ({ primary: [item.name], secondary: [item.text] }));
    assert.deepEqual(ranked.map(item => item.name), ['export', 'other']);
  });
});
