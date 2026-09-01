/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { LLMModel } from './types.js';

const viewerEnvUrl = new URL('../../../.env.local', import.meta.url);
const VERIFY_OPENROUTER_MODELS = process.env.IFC_LITE_VERIFY_OPENROUTER_MODELS === '1';

function parseEnvValue(envText: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = envText.match(new RegExp(`^${escapedKey}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function parseCsvList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function readConfiguredFreeModels(): Promise<string[] | null> {
  const envOverride = process.env.VITE_LLM_FREE_MODELS ?? process.env.LLM_FREE_MODELS;
  if (typeof envOverride === 'string' && envOverride.trim().length > 0) {
    return parseCsvList(envOverride);
  }

  try {
    const envText = await readFile(viewerEnvUrl, 'utf8');
    const configuredFreeModels = parseCsvList(parseEnvValue(envText, 'VITE_LLM_FREE_MODELS'));
    return configuredFreeModels.length > 0 ? configuredFreeModels : null;
  } catch {
    return null;
  }
}

test('registry free models match configured env list', async (t) => {
  const configuredFreeModels = await readConfiguredFreeModels();
  if (!configuredFreeModels) {
    t.skip('Viewer LLM env is not configured in this environment.');
    return;
  }

  await withEnv({
    VITE_LLM_FREE_MODELS: configuredFreeModels.join(','),
    VITE_LLM_IMAGE_MODELS: '',
    VITE_LLM_FILE_ATTACHMENT_MODELS: '',
  }, async () => {
    const { FREE_MODELS } = await import(`./models.ts?ts=${Date.now()}`) as { FREE_MODELS: LLMModel[] };
    assert.deepEqual(
      FREE_MODELS.map((model) => model.id),
      configuredFreeModels,
      'FREE_MODELS must follow VITE_LLM_FREE_MODELS order and values',
    );
  });
});

const CAPABILITY_ENV_KEYS = [
  'VITE_LLM_FREE_MODELS',
  'VITE_LLM_IMAGE_MODELS',
  'VITE_LLM_FILE_ATTACHMENT_MODELS',
] as const;

/**
 * Restore the env these tests mutate. `readConfiguredFreeModels` prefers
 * `process.env` over `.env.local`, so a test that leaves its fixtures behind
 * silently redirects every later test at them — which is how the OpenRouter
 * catalog check below spent its life validating this test's fixtures instead
 * of the configured list.
 */
function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = new Set<string>([...CAPABILITY_ENV_KEYS, ...Object.keys(values)]);
  const saved = new Map([...keys].map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('model capabilities follow override env lists', async () => {
  await withEnv({
    VITE_LLM_FREE_MODELS: 'test/model-a,test/model-b',
    VITE_LLM_IMAGE_MODELS: 'test/model-b',
    VITE_LLM_FILE_ATTACHMENT_MODELS: 'test/model-a',
  }, async () => {
    const { ALL_MODELS } = await import(`./models.ts?ts=${Date.now()}`) as { ALL_MODELS: LLMModel[] };
    const modelA = ALL_MODELS.find((m) => m.id === 'test/model-a');
    const modelB = ALL_MODELS.find((m) => m.id === 'test/model-b');

    assert.ok(modelA, 'Expected model A in registry');
    assert.ok(modelB, 'Expected model B in registry');
    assert.equal(modelA.supportsImages, false);
    assert.equal(modelA.supportsFileAttachments, true);
    assert.equal(modelB.supportsImages, true);
    assert.equal(modelB.supportsFileAttachments, false);
  });
});

test('each configured free model exists in OpenRouter catalog', async (t) => {
  if (!VERIFY_OPENROUTER_MODELS) {
    t.skip('Set IFC_LITE_VERIFY_OPENROUTER_MODELS=1 to run the live OpenRouter catalog check.');
    return;
  }

  const configuredFreeModels = await readConfiguredFreeModels();
  if (!configuredFreeModels) {
    t.skip('Viewer LLM env is not configured in this environment.');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    assert.equal(response.ok, true, `OpenRouter models API failed with HTTP ${response.status}`);

    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const modelIdSet = new Set(
      Array.isArray(payload.data)
        ? payload.data.map((model) => model.id).filter((id): id is string => typeof id === 'string')
        : [],
    );

    const missing = configuredFreeModels.filter((id) => !modelIdSet.has(id));
    assert.deepEqual(
      missing,
      [],
      `Configured free model IDs missing from OpenRouter catalog: ${missing.join(', ')}`,
    );
  } finally {
    clearTimeout(timeout);
  }
});

// The `acceptsSamplingParams` default is inverted (send only where flagged).
// stream-direct.test.ts covers the OpenAI request body; this covers the
// decision itself, so the Anthropic path and the positive case are not left
// to a call site no test imports.
test('sendsSamplingParams is true only for the models flagged for it', async () => {
  const { sendsSamplingParams, BYOK_MODELS } = await import(`./models.ts?ts=${Date.now()}`) as {
    sendsSamplingParams: (id: string) => boolean;
    BYOK_MODELS: LLMModel[];
  };

  // Haiku 4.5 predates Opus 4.7 and still takes a tuned temperature.
  assert.equal(sendsSamplingParams('claude-haiku-4-5'), true);
  // Everything current rejects them with a 400.
  assert.equal(sendsSamplingParams('claude-opus-5'), false);
  assert.equal(sendsSamplingParams('gpt-5.6-sol'), false);
  // Fails closed on an id that is not in the registry at all.
  assert.equal(sendsSamplingParams('vendor/not-a-real-model'), false);

  // Guard the shape, not a count: a future entry that copies the flag by
  // accident shows up here.
  const optedIn = BYOK_MODELS.filter((m) => m.acceptsSamplingParams === true).map((m) => m.id);
  assert.deepEqual(optedIn, ['claude-haiku-4-5']);
});

// A selection persists in localStorage. Dropping an id silently reassigns
// whoever had it to DEFAULT_BYOK_MODEL, which is Opus 5 at 5x Haiku's price
// on the user's own key. Renamed ids must survive the refresh.
test('a retired model id migrates instead of falling back to the default', async () => {
  const { canonicalModelId, getModelById, coerceModelForEntitlement, DEFAULT_BYOK_MODEL } =
    await import(`./models.ts?ts=${Date.now()}`) as {
      canonicalModelId: (id: string) => string;
      getModelById: (id: string) => LLMModel | undefined;
      coerceModelForEntitlement: (id: string | null | undefined, hasByok: boolean) => string;
      DEFAULT_BYOK_MODEL: LLMModel;
    };

  const dated = 'claude-haiku-4-5-20251001';
  assert.equal(canonicalModelId(dated), 'claude-haiku-4-5');
  assert.equal(getModelById(dated)?.id, 'claude-haiku-4-5');

  // The regression this guards: without the alias this returned Opus 5.
  assert.notEqual(DEFAULT_BYOK_MODEL.id, 'claude-haiku-4-5');
  assert.equal(coerceModelForEntitlement(dated, true), 'claude-haiku-4-5');

  // A retired model migrates to its nearest surviving neighbour rather than
  // to the Opus 5 default, which would be a price jump nobody asked for.
  assert.equal(coerceModelForEntitlement('claude-sonnet-4-6', true), 'claude-sonnet-5');
  // An OpenAI selection must not land on an Anthropic model, or the user is
  // asked for a key they never needed.
  assert.equal(getModelById(coerceModelForEntitlement('gpt-5.5', true))?.source, 'openai');

  // An id with no migration still falls back to the default.
  assert.equal(coerceModelForEntitlement('vendor/long-gone', true), DEFAULT_BYOK_MODEL.id);
});
