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
const everyEligible = (ids: string[]) => ids;
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
  const m = (role: 'source' | 'target', hit: string | null) => eligibility.rejectedPickMessage(role, hit, ctx(['a']), models.keys(), nameOf, everyEligible);
  assert.deepEqual(m('source', 'b'), { key: 'repositionPanel.errorNotMoving', params: { hit: 'B.ifc', expected: 'A.ifc' } });
  assert.deepEqual(m('target', 'a'), { key: 'repositionPanel.errorIsMoving', params: { hit: 'A.ifc', expected: 'B.ifc, C.ifc' } });
});

test('a non-reference model is reported as such', () => {
  const r = eligibility.rejectedPickMessage('target', 'b', ctx(['a'], 'c'), models.keys(), nameOf, everyEligible);
  assert.deepEqual(r, { key: 'repositionPanel.errorNotReference', params: { hit: 'B.ifc', expected: 'C.ifc' } });
});

test('a wrong-model hit with nothing eligible keeps the generic message', () => {
  // The only moving model is hidden, so there is no model to point the user at.
  assert.equal(eligibility.rejectedPickMessage('source', 'b', ctx(['h']), models.keys(), nameOf, everyEligible).key, 'repositionPanel.errorNoPoint');
  assert.equal(eligibility.rejectedPickMessage('target', 'a', ctx(['a'], 'h'), models.keys(), nameOf, everyEligible).key, 'repositionPanel.errorNoPoint');
});

test('no hit, a hidden model or an eligible model keep the generic message', () => {
  for (const hit of [null, 'h', 'b']) {
    assert.equal(eligibility.rejectedPickMessage('target', hit, ctx(['a']), models.keys(), nameOf, everyEligible).key, 'repositionPanel.errorNoPoint');
  }
});

test('models sharing a display name get an ordinal, unique names stay plain', () => {
  const dup = new Map([['a', 'A.ifc'], ['b', 'B.ifc'], ['c', 'A.ifc']]);
  const labels = eligibility.modelLabels(dup.keys(), (id) => dup.get(id)!);
  assert.deepEqual([...labels], [['a', 'A.ifc (1)'], ['b', 'B.ifc'], ['c', 'A.ifc (2)']]);
});

test('an ordinal never collides with a model literally named like one', () => {
  const names = new Map([['a', 'A.ifc'], ['b', 'A.ifc'], ['c', 'A.ifc (1)']]);
  const labels = eligibility.modelLabels(names.keys(), (id) => names.get(id)!);
  assert.deepEqual([...labels], [['a', 'A.ifc (2)'], ['b', 'A.ifc (3)'], ['c', 'A.ifc (1)']]);
  assert.equal(new Set(labels.values()).size, 3);
});

test('the wrong-model message tells same-named models apart', () => {
  const dupNames: Record<string, string> = { a: 'X.ifc', b: 'X.ifc', c: 'X.ifc', h: 'H.ifc' };
  const r = eligibility.rejectedPickMessage('source', 'b', ctx(['a', 'c']), models.keys(), (id) => dupNames[id], everyEligible);
  assert.deepEqual(r.params, { hit: 'X.ifc (2)', expected: 'X.ifc (1), X.ifc (3)' });
});

test('a model whose every entity is hidden or outside the isolation set is not offered', () => {
  const ids: Record<string, number[]> = { a: [1, 2], b: [3, 4], c: [5], h: [6] };
  const entityIds = (id: string) => ids[id] ?? [];
  const pick = (hidden: number[], isolated: number[] | null) =>
    eligibility.pickableModelIds(['a', 'b', 'c'], entityIds, new Set(hidden), isolated && new Set(isolated));
  assert.deepEqual(pick([], null), ['a', 'b', 'c']);
  assert.deepEqual(pick([3, 4], null), ['a', 'c']);       // b fully hidden
  assert.deepEqual(pick([3], null), ['a', 'b', 'c']);     // b partly hidden stays
  assert.deepEqual(pick([], [1, 5]), ['a', 'c']);         // b outside isolation
  assert.deepEqual(eligibility.pickableModelIds(['x'], () => [], new Set([1]), null), ['x']); // unknown geometry is kept
});

test('the explaining raycast sees the same hidden and isolation sets the pick uses', () => {
  const store = { hiddenEntities: new Set([9]), isolatedEntities: null as Set<number> | null };
  assert.deepEqual(eligibility.explainRaycastFilter(store), { hiddenIds: store.hiddenEntities, isolatedIds: undefined });
  store.isolatedEntities = new Set([1]);
  assert.equal(eligibility.explainRaycastFilter(store).isolatedIds, store.isolatedEntities);
});

test('the explained hit prefers the snap target and maps to a model', () => {
  const modelOf = (id: number) => (id < 100 ? 'a' : 'b');
  assert.equal(eligibility.hitModelId({ snapTarget: { expressId: 150 }, intersection: { expressId: 5 } }, modelOf), 'b');
  assert.equal(eligibility.hitModelId({ snapTarget: null, intersection: { expressId: 5 } }, modelOf), 'a');
  assert.equal(eligibility.hitModelId({ snapTarget: null, intersection: null }, modelOf), null);
  assert.equal(eligibility.hitModelId({ snapTarget: { expressId: 0 }, intersection: null }, modelOf), 'a');
});

test('the wrong-model message names only moving models that are still pickable (#11419)', () => {
  // a and c are moving; b is the non-moving model the user clicked.
  const geometry = (ids: number[]) => ({ visible: true, geometryResult: { meshes: ids.map((expressId) => ({ expressId })) } });
  const store = new Map([['a', geometry([1, 2])], ['b', geometry([3])], ['c', geometry([5])]]);
  const sameName = (id: string) => (id === 'b' ? 'B.ifc' : 'X.ifc');
  const reject = (hidden: number[], isolated: number[] | null) => eligibility.rejectedPickMessage(
    'source', 'b', eligibility.pickContext(new Set(['a', 'c']), '', store), store.keys(), sameName,
    eligibility.pickableFilter(store, new Set(hidden), isolated && new Set(isolated)));
  // a fully hidden: only c is offered, still labelled by its load order among all models.
  assert.deepEqual(reject([1, 2], null), { key: 'repositionPanel.errorNotMoving', params: { hit: 'B.ifc', expected: 'X.ifc (2)' } });
  // c outside the isolation set: only a is offered.
  assert.deepEqual(reject([], [1, 3]).params.expected, 'X.ifc (1)');
  // Neither moving model is pickable: the generic message, not an empty or misleading list.
  assert.equal(reject([1, 2, 5], null).key, 'repositionPanel.errorNoPoint');
  assert.equal(reject([], [3]).key, 'repositionPanel.errorNoPoint');
});
