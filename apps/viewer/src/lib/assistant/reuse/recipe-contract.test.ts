/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRecipe, type AssistantRecipe } from './recipe';
import { recipeRefusals, stepAvailability, type HostSnapshot } from './recipe-availability';
import { decodePreferences, projectScope } from './preferences';
import { containsCredential } from './credentials';

const recipe: AssistantRecipe = { version: 1, id: 'delivery', origin: 'conversation', revision: 1,
  title: 'Delivery check', description: '', createdAt: '2026-10-07T00:00:00Z',
  steps: [{ kind: 'analysis', source: 'validation' }, { kind: 'ask', source: 'validation', prompt: 'Explain missing values' },
    { kind: 'publish', target: 'bcf' }] };

test('#6924 imported steps cannot carry evidence or declare away their host requirements', () => {
  const decoded = decodeRecipe({ ...recipe, capturedEvidence: 'model content', steps: [
    { kind: 'ask', source: 'validation', prompt: 'Explain missing values', requirements: [], apiKey: 'secret', evidence: 'private' },
  ] });
  assert.deepEqual(decoded?.steps, [{ kind: 'ask', source: 'validation', prompt: 'Explain missing values' }]);
  assert.equal(Object.hasOwn(decoded ?? {}, 'capturedEvidence'), false);
  assert.equal(decodeRecipe({ ...recipe, steps: [{ kind: 'execute', script: 'unsafe' }] }), null);
});

test('#6924 missing grants refuse a recipe while missing analysis state only disables its step', () => {
  const host: HostSnapshot = { modelCount: 0, readySources: new Set(), clashResult: false, validationReport: false,
    compareResult: false, flowGraph: false, assistantModel: false, bcfServer: false, savedFlowIds: new Set() };
  assert.deepEqual(recipeRefusals(recipe, host), [
    { stepIndex: 1, requirement: 'assistantModel' }, { stepIndex: 2, requirement: 'bcfServer' },
  ]);
  assert.deepEqual(stepAvailability(recipe.steps[0], host), { available: false, missing: ['models'] });
  assert.deepEqual(recipeRefusals(recipe, { ...host, assistantModel: true, bcfServer: true }), []);
  assert.deepEqual(stepAvailability(recipe.steps[1], { ...host, assistantModel: true }), { available: false, missing: ['evidence'] });
});

test('#6924 project preferences bind the exact model fingerprint set across order and duplicates', () => {
  const scope = projectScope([{ sourceFingerprint: 'a' }, { sourceFingerprint: 'b' }]);
  assert.deepEqual(projectScope([{ sourceFingerprint: 'b' }, { sourceFingerprint: 'a' }, { sourceFingerprint: 'b' }]), scope);
  assert.notEqual(projectScope([{ sourceFingerprint: 'a' }])?.id, scope?.id);
  assert.equal(projectScope([]), null);
  assert.equal(projectScope([{ sourceFingerprint: 'a' }, {}]), null, 'an unidentified federated member cannot reuse a single-model preference scope');
  assert.ok(scope);
  const entry = { version: 1, ...scope, updatedAt: '2026-10-07T00:00:00Z', language: 'en' };
  assert.ok(decodePreferences(entry));
  assert.equal(decodePreferences({ ...entry, fingerprints: ['other'] }), null);
  assert.equal(decodePreferences({ ...entry, maxRequests: 0 }), null);
});

test('#6924 portable free text refuses configured and provider-shaped credentials', () => {
  assert.equal(containsCredential(['Use token local-private-token'], ['local-private-token']), true);
  assert.equal(containsCredential(['Authorization: Bearer abcdefghijklmnopqrstuvwxyz'], []), true);
  assert.equal(containsCredential(['Review walls with missing FireRating'], []), false);
});
