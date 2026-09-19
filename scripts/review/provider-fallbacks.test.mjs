/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderFallbacks, describeProviderFallbacks } from './provider-fallbacks.mjs';

test('neither key set: no providers, and the log line names both env vars', () => {
  const providers = resolveProviderFallbacks({});
  assert.deepEqual(providers, []);
  assert.match(describeProviderFallbacks(providers), /NOT configured.*OPENROUTER_API_KEY.*OPENAI_API_KEY/);
});

test('OpenRouter first, then OpenAI, when both keys are set', () => {
  const providers = resolveProviderFallbacks({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oai-key' });
  assert.deepEqual(providers.map((p) => p.label), ['openrouter-fallback', 'openai-fallback']);
  assert.match(describeProviderFallbacks(providers), /openrouter-fallback then openai-fallback/);
});

test('only OpenAI set: openai-fallback alone', () => {
  const providers = resolveProviderFallbacks({ OPENAI_API_KEY: 'oai-key' });
  assert.deepEqual(providers.map((p) => p.label), ['openai-fallback']);
});

test('only OpenRouter set: openrouter-fallback alone', () => {
  const providers = resolveProviderFallbacks({ OPENROUTER_API_KEY: 'or-key' });
  assert.deepEqual(providers.map((p) => p.label), ['openrouter-fallback']);
});

test('a blank secret is treated as absent, same as unset (mirrors resolveTokens)', () => {
  const providers = resolveProviderFallbacks({ OPENROUTER_API_KEY: '   ', OPENAI_API_KEY: '' });
  assert.deepEqual(providers, []);
});
