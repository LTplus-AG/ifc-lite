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

// pick-eligibility.ts is a new module. It is loaded per test, not statically, so
// that a run without it fails each test on an assertion instead of killing the
// whole file at import (which the revert oracle reads as "never observed").
type Eligibility = typeof import('./pick-eligibility.js');
const load = (): Promise<Eligibility> => import('./pick-eligibility.js');

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
async function setup() {
  const m = await load();
  const ctx = (moving: string[], reference = '') => m.pickContext(new Set(moving), reference, models);
  return { ...m, ctx };
}

test('source picks accept only moving visible models', async () => {
  const { eligiblePickModelIds, ctx } = await setup();
  assert.deepEqual(eligiblePickModelIds('source', models.keys(), ctx(['a', 'h'])), ['a']);
});

test('target picks accept non-moving models, narrowed to the reference when set', async () => {
  const { eligiblePickModelIds, isEligiblePickModel, ctx } = await setup();
  assert.deepEqual(eligiblePickModelIds('target', models.keys(), ctx(['a'])), ['b', 'c']);
  assert.deepEqual(eligiblePickModelIds('target', models.keys(), ctx(['a'], 'c')), ['c']);
  assert.equal(isEligiblePickModel('target', 'a', ctx(['a'], 'a')), false);
});

test('a hidden or unknown model is never eligible', async () => {
  const { isEligiblePickModel, ctx } = await setup();
  assert.equal(isEligiblePickModel('target', 'h', ctx(['a'])), false);
  assert.equal(isEligiblePickModel('target', 'h', ctx(['a'], 'h')), false);
  assert.equal(isEligiblePickModel('source', 'zz', ctx(['zz'])), false);
});

test('prompt key follows role and reference, and falls back when nothing is eligible', async () => {
  const { pickPromptKey } = await setup();
  assert.equal(pickPromptKey('source', 1, false), 'repositionPanel.pickPromptSource');
  assert.equal(pickPromptKey('target', 1, true), 'repositionPanel.pickPromptTargetReference');
  assert.equal(pickPromptKey('target', 2, false), 'repositionPanel.pickPromptTarget');
  assert.equal(pickPromptKey('target', 0, true), 'repositionPanel.pickPrompt');
});

test('wrong-role hits name the hit model and what the step expects', async () => {
  const { rejectedPickMessage, ctx } = await setup();
  const m = (role: 'source' | 'target', hit: string | null) => rejectedPickMessage(role, hit, ctx(['a']), models.keys(), nameOf);
  assert.deepEqual(m('source', 'b'), { key: 'repositionPanel.errorNotMoving', params: { hit: 'B.ifc', expected: 'A.ifc' } });
  assert.deepEqual(m('target', 'a'), { key: 'repositionPanel.errorIsMoving', params: { hit: 'A.ifc', expected: 'B.ifc, C.ifc' } });
});

test('a non-reference model is reported as such', async () => {
  const { rejectedPickMessage, ctx } = await setup();
  const r = rejectedPickMessage('target', 'b', ctx(['a'], 'c'), models.keys(), nameOf);
  assert.deepEqual(r, { key: 'repositionPanel.errorNotReference', params: { hit: 'B.ifc', expected: 'C.ifc' } });
});

test('a wrong-model hit with nothing eligible keeps the generic message', async () => {
  const { rejectedPickMessage, ctx } = await setup();
  // The only moving model is hidden, so there is no model to point the user at.
  assert.equal(rejectedPickMessage('source', 'b', ctx(['h']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  assert.equal(rejectedPickMessage('target', 'a', ctx(['a'], 'h'), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
});

test('no hit, a hidden model or an eligible model keep the generic message', async () => {
  const { rejectedPickMessage, ctx } = await setup();
  for (const hit of [null, 'h', 'b']) {
    assert.equal(rejectedPickMessage('target', hit, ctx(['a']), models.keys(), nameOf).key, 'repositionPanel.errorNoPoint');
  }
});
