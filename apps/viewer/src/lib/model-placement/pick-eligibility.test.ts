/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositionPanelEn } from '../../i18n/catalogues/reposition-panel.en.js';
import { repositionPanelDe } from '../../i18n/locales/de/reposition-panel.js';
import { repositionPanelFr } from '../../i18n/locales/fr/reposition-panel.js';
import { repositionPanelIt } from '../../i18n/locales/it/reposition-panel.js';
import { repositionPanelRu } from '../../i18n/locales/ru/reposition-panel.js';
import * as eligibility from './pick-eligibility.js';

const PICK_KEYS = [
  'repositionPanel.pickPromptSource', 'repositionPanel.pickPromptTarget', 'repositionPanel.pickPromptTargetReference',
  'repositionPanel.errorNotMoving', 'repositionPanel.errorIsMoving', 'repositionPanel.errorNotReference', 'repositionPanel.errorNoPoint',
] as const;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every pick-hint key exists in each reposition-panel catalogue with the English placeholders', () => {
  const en = repositionPanelEn as Record<string, string>;
  const locales: Record<string, Record<string, string>> = { de: repositionPanelDe, fr: repositionPanelFr, it: repositionPanelIt, ru: repositionPanelRu };
  for (const key of PICK_KEYS) {
    assert.equal(typeof en[key], 'string', `en ${key}`);
    for (const [name, catalogue] of Object.entries(locales)) {
      assert.equal(typeof catalogue[key], 'string', `${name} ${key}`);
      assert.deepEqual(placeholders(catalogue[key]), placeholders(en[key]), `${name} ${key} placeholders`);
    }
  }
});

const models = new Map([['a', { visible: true }], ['b', { visible: true }], ['c', { visible: true }], ['h', { visible: false }]]);
const names: Record<string, string> = { a: 'A.ifc', b: 'B.ifc', c: 'C.ifc', h: 'H.ifc' };
const nameOf = (id: string) => names[id];
const ctx = (moving: string[], reference = '') => eligibility.pickContext(new Set(moving), reference, models);

test('source picks accept only moving visible models', () => {
  assert.deepEqual(eligibility.eligiblePickModelIds('source', models.keys(), ctx(['a', 'h'])), ['a']);
});

test('target picks accept non-moving models, narrowed to the reference when set', () => {
  assert.deepEqual(eligibility.eligiblePickModelIds('target', models.keys(), ctx(['a'])), ['b', 'c']);
  assert.deepEqual(eligibility.eligiblePickModelIds('target', models.keys(), ctx(['a'], 'c')), ['c']);
  assert.equal(eligibility.isEligiblePickModel('target', 'a', ctx(['a'], 'a')), false);
});

test('a hidden or unknown model is never eligible', () => {
  assert.equal(eligibility.isEligiblePickModel('target', 'h', ctx(['a'])), false);
  assert.equal(eligibility.isEligiblePickModel('target', 'h', ctx(['a'], 'h')), false);
  assert.equal(eligibility.isEligiblePickModel('source', 'zz', ctx(['zz'])), false);
});

test('prompt key follows role and reference, and falls back when nothing is eligible', () => {
  assert.equal(eligibility.pickPromptKey('source', 1, false), 'repositionPanel.pickPromptSource');
  assert.equal(eligibility.pickPromptKey('target', 1, true), 'repositionPanel.pickPromptTargetReference');
  assert.equal(eligibility.pickPromptKey('target', 2, false), 'repositionPanel.pickPromptTarget');
  assert.equal(eligibility.pickPromptKey('target', 0, true), 'repositionPanel.pickPrompt');
});

test('wrong-role hits name the hit model and what the step expects', () => {
  const m = (role: 'source' | 'target', hit: string | null) => eligibility.rejectedPickMessage(role, hit, ctx(['a']), models.keys(), nameOf);
  assert.deepEqual(m('source', 'b'), { key: 'repositionPanel.errorNotMoving', params: { hit: 'B.ifc', expected: 'A.ifc' } });
  assert.deepEqual(m('target', 'a'), { key: 'repositionPanel.errorIsMoving', params: { hit: 'A.ifc', expected: 'B.ifc, C.ifc' } });
});

test('a non-reference model is reported as such', () => {
  const r = eligibility.rejectedPickMessage('target', 'b', ctx(['a'], 'c'), models.keys(), nameOf);
  assert.deepEqual(r, { key: 'repositionPanel.errorNotReference', params: { hit: 'B.ifc', expected: 'C.ifc' } });
});

test('a wrong-model hit with nothing eligible keeps the generic message', () => {
  // The only moving model is hidden, so there is no model to point the user at.
  assert.equal(eligibility.rejectedPickMessage('source', 'b', ctx(['h']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  assert.equal(eligibility.rejectedPickMessage('target', 'a', ctx(['a'], 'h'), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
});

test('no hit, a hidden model or an eligible model keep the generic message', () => {
  for (const hit of [null, 'h', 'b']) {
    assert.equal(eligibility.rejectedPickMessage('target', hit, ctx(['a']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  }
});
