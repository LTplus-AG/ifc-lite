/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStreamRoute } from './byok-guard.js';
import { DEFAULT_BYOK_MODEL, BYOK_MODELS } from './models.js';

const ANTHROPIC_MODEL = BYOK_MODELS.find((m) => m.source === 'anthropic')!;
const OPENAI_MODEL = BYOK_MODELS.find((m) => m.source === 'openai')!;

test('resolveStreamRoute returns proxy route for free models', () => {
  const route = resolveStreamRoute('openai/gpt-free', { anthropicKey: '', openaiKey: '' });
  assert.equal(route.kind, 'proxy');
  if (route.kind === 'proxy') {
    assert.equal(route.model, 'openai/gpt-free');
  }
});

test('resolveStreamRoute returns proxy route for unknown model ids', () => {
  const route = resolveStreamRoute('made-up-model', { anthropicKey: 'sk-ant-...', openaiKey: '' });
  assert.equal(route.kind, 'proxy');
});

test('resolveStreamRoute returns anthropic route when key present', () => {
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: 'sk-ant-abc',
    openaiKey: '',
  });
  assert.equal(route.kind, 'anthropic');
  if (route.kind === 'anthropic') {
    assert.equal(route.apiKey, 'sk-ant-abc');
    assert.equal(route.model, ANTHROPIC_MODEL.id);
  }
});

test('resolveStreamRoute returns missing-key when anthropic model selected without key', () => {
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: '',
    openaiKey: 'sk-openai-xyz',
  });
  assert.equal(route.kind, 'missing-key');
  if (route.kind === 'missing-key') {
    assert.equal(route.provider, 'anthropic');
  }
});

test('resolveStreamRoute returns openai route when key present', () => {
  const route = resolveStreamRoute(OPENAI_MODEL.id, {
    anthropicKey: '',
    openaiKey: 'sk-openai-xyz',
  });
  assert.equal(route.kind, 'openai');
  if (route.kind === 'openai') {
    assert.equal(route.apiKey, 'sk-openai-xyz');
  }
});

test('resolveStreamRoute returns missing-key when openai model selected without key', () => {
  const route = resolveStreamRoute(OPENAI_MODEL.id, {
    anthropicKey: 'sk-ant-abc',
    openaiKey: '',
  });
  assert.equal(route.kind, 'missing-key');
  if (route.kind === 'missing-key') {
    assert.equal(route.provider, 'openai');
  }
});

test('resolveStreamRoute treats whitespace-only keys as missing', () => {
  const route = resolveStreamRoute(DEFAULT_BYOK_MODEL.id, {
    anthropicKey: '   ',
    openaiKey: '   ',
  });
  assert.equal(route.kind, 'missing-key');
});
