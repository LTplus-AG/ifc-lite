/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocumentSpec } from '../document/types';
import { buildCards } from './cards';
import { reviewDocument } from './report';
import { element, fakeModel, finding, run } from './test-support';

const models = [fakeModel('m1', 'arch.ifc', ['W1', 'W2'])];
const e = (g: string) => element(g, 'arch.ifc', 'm1');
const historical = run('clash:baseline', 'clash', { temporal: 'historical', label: 'Baseline', complete: false, incomplete: [{ code: 'truncated' }] });
const { cards, totals } = buildCards([
  finding('v1', 'validation', [e('W1')], { nativeStatus: 'failed' }),
  finding('h1', 'clash', [e('W2')], { run: historical, lifecycle: 'not-evaluated', nativeStatus: 'hard' }),
], models);
const workspace = { version: 1 as const, id: 'w', name: 'w', decisions: [{ cardKey: cards[0].key, status: 'accepted' as const, comment: 'known', updatedAt: '2026-01-01T00:00:00.000Z' }] };
const text = (doc: ReturnType<typeof reviewDocument>) => doc.blocks.map(block => block.kind === 'text' ? JSON.stringify(block.text) : '').join('\n');

test('the report is a valid new native document whose values are literal text', () => {
  const doc = reviewDocument('  Weekly review  ', cards, totals, workspace, new Date('2026-03-01T00:00:00.000Z'));
  assert.deepEqual(validateDocumentSpec(doc), []);
  assert.equal(doc.name, 'Weekly review');
  assert.ok(doc.blocks.every(block => block.kind === 'text'), 'no bound or live blocks: it stays readable after the runs change');
});

test('historical evidence, partial runs and the reviewer decision are stated, and totals are counted separately', () => {
  const body = text(reviewDocument('R', cards, totals, workspace, new Date('2026-03-01T00:00:00.000Z')));
  assert.match(body, /Historical evidence only; not re-evaluated/);
  assert.match(body, /clash, historical: Baseline, incomplete run/);
  assert.match(body, /Reviewer decision: accepted — known/);
  assert.match(body, /Reviewer decision: none recorded/);
  assert.match(body, /2 unique validated element\(s\)/);
  assert.match(body, /1 current finding\(s\), 1 historical finding\(s\)/);
  assert.doesNotMatch(body, /resolved/i, 'nothing is described as resolved');
});

test('an empty name falls back to a title and a subset of cards says how many of the total it includes', () => {
  const doc = reviewDocument('   ', cards.slice(0, 1), totals, workspace);
  assert.equal(doc.name, 'Coordination review');
  assert.match(text(doc), /1 of 2 card\(s\) included/);
});
