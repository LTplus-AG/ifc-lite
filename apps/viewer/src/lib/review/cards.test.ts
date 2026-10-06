/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCards } from './cards';
import { element, fakeModel, finding, run } from './test-support';

const arch = fakeModel('m1', 'arch.ifc', ['W1', 'W2', 'W3']);
const mep = fakeModel('m2', 'mep.ifc', ['P1', 'P2']);
const models = [arch, mep];
const wall = (g: string) => element(g, 'arch.ifc', 'm1');
const pipe = (g: string) => element(g, 'mep.ifc', 'm2');

// Invariant: findings naming exactly the same validated elements form one card; every finding is in exactly one card.
test('findings from different analyses on the same element pair share one card', () => {
  const findings = [
    finding('c1', 'clash', [wall('W1'), pipe('P1')]),
    finding('v1', 'validation', [pipe('P1'), wall('W1')]),
    finding('c2', 'clash', [wall('W2'), pipe('P2')]),
  ];
  const { cards } = buildCards(findings, models);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.findings.length).sort(), [1, 2]);
  assert.equal(cards.flatMap(card => card.findings).length, findings.length, 'no finding dropped or duplicated');
  assert.deepEqual(cards.find(card => card.findings.length === 2)?.sources, ['clash', 'validation']);
});

test('cards are not transitive: a finding on one element stays a separate, related card', () => {
  const { cards } = buildCards([
    finding('c1', 'clash', [wall('W1'), pipe('P1')]),
    finding('v1', 'validation', [wall('W1')]),
  ], models);
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.related.length, 1);
  assert.deepEqual(cards[0].related, [cards[1].key]);
});

test('an unresolved or ambiguous element never merges: the finding keeps a card of its own, marked unvalidated', () => {
  const ghost = element('NOPE', 'arch.ifc', 'm1');
  const { cards, totals } = buildCards([
    finding('v1', 'validation', [ghost]), finding('v2', 'validation', [ghost]),
    finding('b1', 'bcf', [element('W1', null)]), finding('b2', 'bcf', [element('W1', null)]),
  ], [arch, fakeModel('m3', 'arch-rev.ifc', ['W1'])]);
  assert.equal(cards.length, 4, 'two missing + two ambiguous findings, none merged');
  assert.ok(cards.every(card => card.identity === 'unvalidated'));
  assert.equal(totals.uniqueElements, 0);
  assert.equal(totals.unverifiedElements, 2);
});

test('a finding with one resolved and one missing element is not merged into the card of the resolved one', () => {
  const { cards } = buildCards([
    finding('half', 'clash', [wall('W1'), element('GONE', 'mep.ifc', 'm2')]), finding('whole', 'validation', [wall('W1')]),
  ], models);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.identity).sort(), ['unvalidated', 'validated']);
  assert.deepEqual(cards.find(card => card.identity === 'unvalidated')?.related, [], 'an unvalidated card claims no relations');
});

test('a finding naming no element is never merged with another', () => {
  const { cards } = buildCards([finding('a', 'linked', []), finding('b', 'linked', [])], models);
  assert.equal(cards.length, 2);
});

// Invariant: totals count different things and are never derived from one another.
test('totals do not double count an element or a finding across analyses', () => {
  const current = run('clash:current', 'clash');
  const historical = run('clash:baseline', 'clash', { temporal: 'historical' });
  const { totals } = buildCards([
    finding('c1', 'clash', [wall('W1'), pipe('P1')], { run: current }),
    finding('v1', 'validation', [wall('W1')]),
    finding('h1', 'clash', [wall('W1'), pipe('P1')], { run: historical, lifecycle: 'persistent' }),
    finding('t1', 'bcf', [wall('W1')], { lifecycle: 'record', evidence: { kind: 'bcf', topicGuid: 'T1' } }),
  ], models);
  assert.deepEqual(totals, { uniqueElements: 2, unverifiedElements: 0, currentFindings: 2, historicalFindings: 1, cards: 2, topics: 1 });
});

// Invariant: historical evidence never becomes current by matching; partial runs never resolve anything.
test('card state keeps historical evidence apart from current evidence', () => {
  const historical = run('clash:baseline', 'clash', { temporal: 'historical' });
  const states = (lifecycle: 'no-longer-observed' | 'not-evaluated' | 'persistent') => buildCards(
    [finding('h', 'clash', [wall('W1'), pipe('P1')], { run: historical, lifecycle })], models).cards[0].state;
  assert.equal(states('no-longer-observed'), 'resolution-candidate');
  assert.equal(states('not-evaluated'), 'not-evaluated');
});

test('one not-evaluated finding keeps the whole card from becoming a resolution candidate', () => {
  const historical = run('clash:baseline', 'clash', { temporal: 'historical' });
  const pair = [wall('W1'), pipe('P1')];
  const { cards } = buildCards([
    finding('h1', 'clash', pair, { run: historical, lifecycle: 'no-longer-observed' }),
    finding('h2', 'comparison', pair, { run: run('comparison:saved:1', 'comparison', { temporal: 'historical' }), lifecycle: 'not-evaluated' }),
  ], models);
  assert.equal(cards[0].state, 'not-evaluated');
});

test('a current finding alongside historical ones makes the card current; a BCF topic alone is a record', () => {
  const historical = run('clash:baseline', 'clash', { temporal: 'historical' });
  const pair = [wall('W1'), pipe('P1')];
  const withCurrent = buildCards([finding('h', 'clash', pair, { run: historical, lifecycle: 'not-evaluated' }), finding('c', 'validation', pair)], models);
  assert.equal(withCurrent.cards[0].state, 'current');
  const record = buildCards([finding('t', 'bcf', pair, { lifecycle: 'record', evidence: { kind: 'bcf', topicGuid: 'T9' } })], models);
  assert.equal(record.cards[0].state, 'record');
  assert.deepEqual(record.cards[0].topics, ['T9']);
});

test('card order and keys are deterministic regardless of input order', () => {
  const findings = [
    finding('a', 'clash', [wall('W1'), pipe('P1')]), finding('b', 'validation', [wall('W2')]),
    finding('c', 'validation', [wall('W1'), pipe('P1')]), finding('d', 'validation', [pipe('P2')]),
  ];
  const forward = buildCards(findings, models).cards.map(card => card.key);
  const backward = buildCards([...findings].reverse(), models).cards.map(card => card.key);
  assert.deepEqual(forward, backward);
});

test('durable card keys use model names, so they survive reloading the same files under new model ids', () => {
  const reloaded = [fakeModel('x9', 'arch.ifc', ['W1', 'W2', 'W3']), fakeModel('x8', 'mep.ifc', ['P1', 'P2'])];
  const before = buildCards([finding('c', 'clash', [wall('W1'), pipe('P1')])], models).cards[0].key;
  const after = buildCards([finding('c', 'clash', [element('W1', 'arch.ifc', 'x9'), element('P1', 'mep.ifc', 'x8')])], reloaded).cards[0].key;
  assert.equal(before, after);
});
