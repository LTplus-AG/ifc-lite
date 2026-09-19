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

// ============================================ finding-3: per-caller OpenRouter timeouts

test('resolveProviderFallbacks accepts a caller-supplied OpenRouter timeout default and still builds the chain', () => {
  // Full timing behaviour (the env override winning, the fetch-level abort, the
  // spawnSync budget) is unit-tested against `resolveTimeoutMs`/
  // `runOpenRouterFallback` directly in openrouter-reviewer.test.mjs, where a
  // fake `spawn`/`fetchImpl` can be injected. This only proves the option
  // reaches `resolveProviderFallbacks` without changing the shape of what it
  // returns -- `runOpenRouterFallback`'s default `spawn` is the real
  // `spawnSync`, which this file must not invoke.
  const providers = resolveProviderFallbacks(
    { OPENROUTER_API_KEY: 'k' },
    { openRouterTimeoutMsDefault: 42 },
  );
  assert.equal(providers.length, 1);
  assert.equal(providers[0].label, 'openrouter-fallback');
  assert.equal(typeof providers[0].run, 'function');
});

test('an OPENROUTER_TIMEOUT_MS env override is accepted alongside a caller default without throwing', () => {
  const providers = resolveProviderFallbacks(
    { OPENROUTER_API_KEY: 'k', OPENROUTER_TIMEOUT_MS: '9999' },
    { openRouterTimeoutMsDefault: 300000 },
  );
  assert.equal(providers.length, 1);
});

// ================================== finding-1/finding-4: behavioural timeout, real code path

/**
 * REPLACES A SOURCE-TEXT ASSERTION. This drives `resolveProviderFallbacks` --
 * the actual function both run-judge.mjs and run-reviewer.mjs call -- with the
 * judge's own options object, and observes the timeout each provider actually
 * hands its child process via an injected `spawn`. No `spawnSync` and no
 * network are invoked: `spawn` is swapped out through the same test-only
 * option `runOpenRouterFallback`/`runOpenAiFallback` already accept, so what
 * is asserted is real wiring, not a string pinned in run-judge.mjs's source.
 */
test('#finding-1/#finding-4: the judge\'s OpenRouter AND OpenAI fallbacks get a 120000ms timeout; the reviewer\'s get 300000ms', () => {
  const seenOpenRouterEnv = [];
  const seenOpenAiEnv = [];
  const fakeSpawn = (_cmd, _args, opts) => {
    if (opts.env.OPENROUTER_TIMEOUT_MS !== undefined) seenOpenRouterEnv.push(opts.env.OPENROUTER_TIMEOUT_MS);
    if (opts.env.OPENAI_TIMEOUT_MS !== undefined) seenOpenAiEnv.push(opts.env.OPENAI_TIMEOUT_MS);
    return { status: 0, stdout: 'MODEL_USED:x\n', stderr: '' };
  };

  const env = { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oai-key' };

  // The judge's own options, straight out of run-judge.mjs.
  const judgeProviders = resolveProviderFallbacks(env, {
    openRouterModelsEnvVar: 'OPENROUTER_JUDGE_MODELS',
    openRouterModelEnvVar: 'OPENROUTER_JUDGE_MODEL',
    openRouterTimeoutMsDefault: 120_000,
    spawn: fakeSpawn,
  });
  for (const p of judgeProviders) {
    try { p.run('prompt'); } catch { /* the fake spawn's stdout is not a real OpenAI response; only the env matters here */ }
  }

  // The reviewer takes NO override at all -- its own real call site.
  const reviewerProviders = resolveProviderFallbacks(env, { spawn: fakeSpawn });
  for (const p of reviewerProviders) {
    try { p.run('prompt'); } catch { /* same */ }
  }

  assert.deepEqual(seenOpenRouterEnv, ['120000', '300000'], 'OpenRouter: judge first (120000), then reviewer (300000)');
  assert.deepEqual(seenOpenAiEnv, ['120000', '300000'], 'OpenAI: judge first (120000), then reviewer (300000)');
});
