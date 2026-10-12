/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveElement } from './identity';
import { buildCards } from './cards';
import { element, fakeModel, finding } from './test-support';

const arch = fakeModel('m1', 'arch.ifc', ['W1', 'W2']);
const mep = fakeModel('m2', 'mep.ifc', ['P1', 'W1']);

// Invariant: a finding joins a card only when its element resolves to exactly one loaded model.
test('a GlobalId in exactly one named model resolves with its express id', () => {
  assert.deepEqual(resolveElement(element('W2', 'arch.ifc', 'm1'), [arch, mep]),
    { state: 'resolved', modelId: 'm1', modelName: 'arch.ifc', expressId: 2 });
});

test('an element named without a model that exists in two models is ambiguous, never guessed', () => {
  const result = resolveElement(element('W1', null), [arch, mep]);
  assert.equal(result.state, 'ambiguous');
  assert.deepEqual(result.state === 'ambiguous' && result.modelNames.sort(), ['arch.ifc', 'mep.ifc']);
});

test('a model-less element present in one model resolves to it', () => {
  assert.equal(resolveElement(element('P1', null), [arch, mep]).state, 'resolved');
});

test('a GlobalId absent from the named model is missing even when another model has it', () => {
  assert.equal(resolveElement(element('P1', 'arch.ifc'), [arch, mep]).state, 'missing');
});

test('a historical element carries only a durable model name and resolves through it', () => {
  assert.equal(resolveElement(element('W1', 'mep.ifc', null), [arch, mep]).state, 'resolved');
  assert.equal(resolveElement(element('W1', 'gone.ifc', null), [arch, mep]).state, 'missing');
});

test('two loaded models sharing a file name cannot be told apart by their durable key', () => {
  const copy = fakeModel('m3', 'arch.ifc', ['W1']);
  assert.equal(resolveElement(element('W2', 'arch.ifc', 'm1'), [arch, copy]).state, 'ambiguous');
});

test('a native identity failure overrules a GlobalId match', () => {
  assert.equal(resolveElement({ ...element('W2', 'arch.ifc', 'm1'), nativeUnresolved: 'ambiguous' }, [arch]).state, 'ambiguous');
  assert.equal(resolveElement({ ...element('W2', 'arch.ifc', 'm1'), nativeUnresolved: 'unmatched' }, [arch]).state, 'missing');
});

// #7372: exercise the public card owner rather than exporting an unused key decoder.
test('card identity preserves distinct file names and shared GlobalIds across scene reloads', () => {
  const names = ['a b/c.ifc', 'ab/c.ifc'];
  const models = names.map((name, index) => fakeModel(`scene-${index}`, name, ['0abc$_']));
  const findings = names.map((name, index) => finding(`native-${index}`, 'validation', [element('0abc$_', name)]));
  const first = buildCards(findings, models);
  assert.equal(first.cards.length, 2, 'different named owners never merge on the shared GlobalId');
  assert.equal(new Set(first.cards.map(card => card.key)).size, 2);
  assert.deepEqual(first.cards.flatMap(card => card.elements.map(item => item.modelName)).sort(), names);
  assert.ok(first.cards.every(card => card.identity === 'validated' && card.elements[0].globalId === '0abc$_'));
  const reloaded = buildCards(findings, names.map((name, index) => fakeModel(`reloaded-${index}`, name, ['0abc$_'])));
  assert.deepEqual(reloaded.cards.map(card => card.key), first.cards.map(card => card.key), 'scene ids never replace file identity');
  assert.ok(reloaded.cards.every(card => card.elements[0].resolvedModelId?.startsWith('reloaded-')));
});
