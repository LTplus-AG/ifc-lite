/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligiblePickModelIds, isEligiblePickModel, pickContext, pickPromptKey, rejectedPickMessage } from './pick-eligibility.js';

const models = new Map([['a', { visible: true }], ['b', { visible: true }], ['c', { visible: true }], ['h', { visible: false }]]);
const names: Record<string, string> = { a: 'A.ifc', b: 'B.ifc', c: 'C.ifc', h: 'H.ifc' };
const nameOf = (id: string) => names[id];
const ctx = (moving: string[], reference = '') => pickContext(new Set(moving), reference, models);

test('source picks accept only moving visible models', () => {
  assert.deepEqual(eligiblePickModelIds('source', models.keys(), ctx(['a', 'h'])), ['a']);
});

test('target picks accept non-moving models, narrowed to the reference when set', () => {
  assert.deepEqual(eligiblePickModelIds('target', models.keys(), ctx(['a'])), ['b', 'c']);
  assert.deepEqual(eligiblePickModelIds('target', models.keys(), ctx(['a'], 'c')), ['c']);
  assert.equal(isEligiblePickModel('target', 'a', ctx(['a'], 'a')), false);
});

test('a hidden or unknown model is never eligible', () => {
  assert.equal(isEligiblePickModel('target', 'h', ctx(['a'])), false);
  assert.equal(isEligiblePickModel('target', 'h', ctx(['a'], 'h')), false);
  assert.equal(isEligiblePickModel('source', 'zz', ctx(['zz'])), false);
});

test('prompt key follows role and reference, and falls back when nothing is eligible', () => {
  assert.equal(pickPromptKey('source', 1, false), 'repositionPanel.pickPromptSource');
  assert.equal(pickPromptKey('target', 1, true), 'repositionPanel.pickPromptTargetReference');
  assert.equal(pickPromptKey('target', 2, false), 'repositionPanel.pickPromptTarget');
  assert.equal(pickPromptKey('target', 0, true), 'repositionPanel.pickPrompt');
});

test('wrong-role hits name the hit model and what the step expects', () => {
  const m = (role: 'source' | 'target', hit: string | null, c = ctx(['a'])) => rejectedPickMessage(role, hit, c, models.keys(), nameOf);
  assert.deepEqual(m('source', 'b'), { key: 'repositionPanel.errorNotMoving', params: { hit: 'B.ifc', expected: 'A.ifc' } });
  assert.deepEqual(m('target', 'a'), { key: 'repositionPanel.errorIsMoving', params: { hit: 'A.ifc', expected: 'B.ifc, C.ifc' } });
});

test('a non-reference model is reported as such', () => {
  const r = rejectedPickMessage('target', 'b', ctx(['a'], 'c'), models.keys(), nameOf);
  assert.deepEqual(r, { key: 'repositionPanel.errorNotReference', params: { hit: 'B.ifc', expected: 'C.ifc' } });
});

test('a wrong-model hit with nothing eligible keeps the generic message', () => {
  // The only moving model is hidden, so there is no model to point the user at.
  assert.equal(rejectedPickMessage('source', 'b', ctx(['h']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  assert.equal(rejectedPickMessage('target', 'a', ctx(['a'], 'h'), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
});

test('no hit, a hidden model or an eligible model keep the generic message', () => {
  for (const hit of [null, 'h', 'b']) {
    assert.equal(rejectedPickMessage('target', hit, ctx(['a']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  }
});
