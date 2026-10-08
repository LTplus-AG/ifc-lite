/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCards } from './cards';
import { facetOptions, filterCards } from './facets';
import { element, fakeModel, finding, run } from './test-support';
import type { ReviewWorkspace } from './workspace';

const arch = fakeModel('m1', 'arch.ifc', ['W1', 'W2', 'W3']);
const mep = fakeModel('m2', 'mep.ifc', ['P1']);
const e = (g: string, model: 'arch.ifc' | 'mep.ifc') => element(g, model, model === 'arch.ifc' ? 'm1' : 'm2');
const clashRun = run('clash:current', 'clash', { label: 'Arch vs MEP' });
const { cards } = buildCards([
  finding('c1', 'clash', [e('W1', 'arch.ifc'), e('P1', 'mep.ifc')], { run: clashRun, disciplines: ['Architecture', 'MEP'], storeys: ['L1'] }),
  finding('v1', 'validation', [e('W1', 'arch.ifc'), e('P1', 'mep.ifc')], { disciplines: ['Architecture'], storeys: ['L1'] }),
  finding('v2', 'validation', [e('W2', 'arch.ifc')], { storeys: ['L2'] }),
  finding('v3', 'validation', [e('W3', 'arch.ifc')]),
], [arch, mep]);
const workspace: ReviewWorkspace = { version: 1, id: 'w', name: 'w', decisions: [
  { cardKey: cards.find(card => card.elements.length === 1 && card.elements[0].globalId === 'W2')!.key, status: 'resolved', comment: '', updatedAt: '2026-01-01T00:00:00.000Z' }] };

test('options count cards, never findings: the two-finding card counts once per value', () => {
  const options = facetOptions(cards, [clashRun], workspace);
  assert.deepEqual(options.source.map(o => [o.value, o.cards]), [['validation', 3], ['clash', 1]]);
  assert.deepEqual(options.run.map(o => o.label).sort(), ['Arch vs MEP', 'validation:current']);
  assert.deepEqual(options.decision.map(o => [o.value, o.cards]).sort(), [['none', 2], ['resolved', 1]]);
  assert.deepEqual(options.storey.map(o => o.value).sort(), ['L1', 'L2']);
});

test('a card passes when every active facet has at least one selected value; empty facets do not filter', () => {
  assert.equal(filterCards(cards, {}, workspace).length, 3);
  assert.equal(filterCards(cards, { source: ['clash'] }, workspace).length, 1);
  assert.equal(filterCards(cards, { source: ['clash', 'validation'] }, workspace).length, 3, 'values within a facet are alternatives');
  assert.equal(filterCards(cards, { source: ['validation'], storey: ['L1'] }, workspace).length, 1, 'facets combine');
  assert.equal(filterCards(cards, { source: ['clash'], storey: ['L2'] }, workspace).length, 0);
  assert.equal(filterCards(cards, { decision: ['resolved'] }, workspace).length, 1);
  assert.equal(filterCards(cards, { decision: ['none'] }, workspace).length, 2);
  assert.equal(filterCards(cards, { discipline: ['MEP'] }, workspace).length, 1, 'discipline is a candidate list, not an owner');
});
