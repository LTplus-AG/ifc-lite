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
  const route = resolveStreamRoute('openai/gpt-free', { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
  assert.equal(route.kind, 'proxy');
  if (route.kind === 'proxy') {
    assert.equal(route.model, 'openai/gpt-free');
  }
});

test('resolveStreamRoute returns proxy route for unknown model ids', () => {
  const route = resolveStreamRoute('made-up-model', { anthropicKey: 'sk-ant-...', anthropicWorkspaceId: '', openaiKey: '' });
  assert.equal(route.kind, 'proxy');
});

test('resolveStreamRoute returns anthropic route when key present', () => {
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: 'sk-ant-abc',
    anthropicWorkspaceId: '',
    openaiKey: '',
  });
  assert.equal(route.kind, 'anthropic');
  if (route.kind === 'anthropic') {
    assert.equal(route.credentials.apiKey, 'sk-ant-abc');
    assert.equal(route.credentials.workspaceId, '');
    assert.equal(route.model, ANTHROPIC_MODEL.id);
  }
});

test('resolveStreamRoute carries the workspace id alongside the anthropic key', () => {
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: '  sk-ant-abc  ',
    anthropicWorkspaceId: '  wrkspc_01abc  ',
    openaiKey: '',
  });
  assert.equal(route.kind, 'anthropic');
  if (route.kind === 'anthropic') {
    assert.equal(route.credentials.apiKey, 'sk-ant-abc');
    assert.equal(route.credentials.workspaceId, 'wrkspc_01abc');
  }
});

test('resolveStreamRoute still routes when only the workspace id is set', () => {
  // A workspace id without a key is not a credential — the missing-key branch
  // must win, or the modal never opens and the send fails at the API instead.
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: '',
    anthropicWorkspaceId: 'wrkspc_01abc',
    openaiKey: '',
  });
  assert.equal(route.kind, 'missing-key');
});

test('resolveStreamRoute returns missing-key when anthropic model selected without key', () => {
  const route = resolveStreamRoute(ANTHROPIC_MODEL.id, {
    anthropicKey: '',
    anthropicWorkspaceId: '',
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
    anthropicWorkspaceId: '',
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
    anthropicWorkspaceId: '',
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
    anthropicWorkspaceId: '',
    openaiKey: '   ',
  });
  assert.equal(route.kind, 'missing-key');
});
