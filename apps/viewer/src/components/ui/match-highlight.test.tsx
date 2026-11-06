/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { MatchHighlight } from './match-highlight.js';

afterEach(cleanup);

function marked(text: string, query: string) {
  const ui = render(<span data-test=""><MatchHighlight text={text} query={query} /></span>);
  const host = ui.querySelector('[data-test]')!;
  return { text: host.textContent, mark: host.querySelector('mark')?.textContent ?? null };
}

it('marks the first case-insensitive occurrence and keeps the label intact (#8802 R4)', () => {
  assert.deepEqual(marked('IFC model', 'ifc'), { text: 'IFC model', mark: 'IFC' });
  assert.deepEqual(marked('Draw walls', ' WALL '), { text: 'Draw walls', mark: 'wall' });
});

it('renders the label plain when the query does not occur in it', () => {
  assert.deepEqual(marked('Model inspector', 'wall'), { text: 'Model inspector', mark: null });
  assert.deepEqual(marked('Model inspector', '   '), { text: 'Model inspector', mark: null });
});

// CodeRabbit on #9044: under a Turkish locale `toLocaleLowerCase` folds 'I'
// to dotless 'ı', so 'IFC' never matched 'ifc'. Pin the locale-sensitive
// method to Turkish rules for the duration of the test; locale-free folding
// must not care.
it('highlights IFC for the query ifc even when the locale is Turkish', () => {
  const original = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = function turkish(this: string) {
    return original.call(this, 'tr');
  };
  try {
    assert.equal('I'.toLocaleLowerCase(), 'ı', 'the Turkish pin is in effect');
    assert.deepEqual(marked('IFC model', 'ifc'), { text: 'IFC model', mark: 'IFC' });
  } finally {
    String.prototype.toLocaleLowerCase = original;
  }
});

// Claude review on #9044: 'İ' lower-cases to two code units, so a guard on
// the lower-cased copy dropped the highlight for any name containing one.
it('highlights a name whose lower-cased form changes length', () => {
  assert.deepEqual(marked('İstanbul', 'İ'), { text: 'İstanbul', mark: 'İ' });
  assert.deepEqual(marked('İstanbul office', 'OFFICE'), { text: 'İstanbul office', mark: 'office' });
});

it('treats regular-expression characters in the query literally', () => {
  assert.deepEqual(marked('Export (IFC) a.b-c/d', '(ifc)'), { text: 'Export (IFC) a.b-c/d', mark: '(IFC)' });
  assert.deepEqual(marked('Export (IFC) a.b-c/d', 'a.b-c/d'), { text: 'Export (IFC) a.b-c/d', mark: 'a.b-c/d' });
  assert.deepEqual(marked('Model inspector', '.*'), { text: 'Model inspector', mark: null });
});
