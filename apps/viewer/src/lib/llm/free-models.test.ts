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

  process.env.VITE_LLM_FREE_MODELS = configuredFreeModels.join(',');
  process.env.VITE_LLM_IMAGE_MODELS = '';
  process.env.VITE_LLM_FILE_ATTACHMENT_MODELS = '';

  const { FREE_MODELS } = await import(`./models.ts?ts=${Date.now()}`) as { FREE_MODELS: LLMModel[] };
  assert.deepEqual(
    FREE_MODELS.map((model) => model.id),
    configuredFreeModels,
    'FREE_MODELS must follow VITE_LLM_FREE_MODELS order and values',
  );
});

test('model capabilities follow override env lists', async () => {
  process.env.VITE_LLM_FREE_MODELS = 'qwen/qwen3-coder,mistralai/devstral-2512';
  process.env.VITE_LLM_IMAGE_MODELS = 'mistralai/devstral-2512';
  process.env.VITE_LLM_FILE_ATTACHMENT_MODELS = 'qwen/qwen3-coder';

  const { ALL_MODELS } = await import(`./models.ts?ts=${Date.now()}`) as { ALL_MODELS: LLMModel[] };
  const qwen = ALL_MODELS.find((m) => m.id === 'qwen/qwen3-coder');
  const devstral = ALL_MODELS.find((m) => m.id === 'mistralai/devstral-2512');

  assert.ok(qwen, 'Expected qwen model in registry');
  assert.ok(devstral, 'Expected devstral model in registry');
  assert.equal(qwen.supportsImages, false);
  assert.equal(qwen.supportsFileAttachments, true);
  assert.equal(devstral.supportsImages, true);
  assert.equal(devstral.supportsFileAttachments, false);
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
