/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LLM model registry.
 *
 * Free models: sourced from VITE_LLM_FREE_MODELS env var, served through the server proxy.
 * BYOK models: statically defined Anthropic and OpenAI models, accessed directly from the
 * browser using the user's own API key.
 */

import type { LLMModel } from './types.js';

function readEnv(key: string): string | undefined {
  const importMetaEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const viteVal = importMetaEnv?.[key];
  const nodeVal = typeof process !== 'undefined' ? process.env[key] : undefined;
  const val = typeof viteVal === 'string' ? viteVal : nodeVal;
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCsvEnv(key: string): string[] {
  const raw = readEnv(key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCsvFromFirstDefined(keys: string[]): string[] {
  for (const key of keys) {
    const values = parseCsvEnv(key);
    if (values.length > 0) return values;
  }
  return [];
}

function uniqueInOrder(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function titleCaseProvider(rawProvider: string): string {
  const overrides: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    meta: 'Meta',
    'meta-llama': 'Meta',
    xai: 'xAI',
    'x-ai': 'xAI',
    mistralai: 'Mistral',
    qwen: 'Alibaba',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    'z-ai': 'Zhipu',
  };

  const normalized = rawProvider.toLowerCase();
  if (overrides[normalized]) return overrides[normalized];
  return rawProvider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function humanizeModelSlug(slug: string): string {
  const withoutTier = slug.split(':')[0] ?? slug;
  return withoutTier
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (/^[0-9.]+$/.test(word)) return word;
      const upper = word.toUpperCase();
      if (upper === 'GPT' || upper === 'OSS' || upper === 'R1') return upper;
      if (word.length <= 2) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function buildModel(id: string, tier: 'free' | 'byok', cost?: LLMModel['cost'], source?: LLMModel['source']): LLMModel {
  const [providerRaw, modelRaw = id] = id.split('/');
  return {
    id,
    tier,
    source: source ?? 'proxy',
    name: humanizeModelSlug(modelRaw),
    provider: titleCaseProvider(providerRaw ?? 'Unknown'),
    contextWindow: 128_000,
    supportsImages: false,
    supportsFileAttachments: true,
    cost: tier === 'byok' ? cost : undefined,
  };
}

const freeModelIds = uniqueInOrder(parseCsvFromFirstDefined(['VITE_LLM_FREE_MODELS', 'LLM_FREE_MODELS']));

const rawFreeModels: LLMModel[] = freeModelIds.map((id) => buildModel(id, 'free'));

const imageCapableModelIds = new Set(
  uniqueInOrder(parseCsvFromFirstDefined(['VITE_LLM_IMAGE_MODELS', 'LLM_IMAGE_MODELS'])),
);
const fileCapableModelIds = new Set(
  uniqueInOrder(parseCsvFromFirstDefined(['VITE_LLM_FILE_ATTACHMENT_MODELS', 'LLM_FILE_ATTACHMENT_MODELS'])),
);
const hasImageOverrideList = imageCapableModelIds.size > 0;
const hasFileOverrideList = fileCapableModelIds.size > 0;

function applyCapabilities(model: LLMModel): LLMModel {
  const supportsImages = hasImageOverrideList ? imageCapableModelIds.has(model.id) : model.supportsImages;
  const supportsFileAttachments = hasFileOverrideList
    ? fileCapableModelIds.has(model.id)
    : model.supportsFileAttachments;
  return {
    ...model,
    supportsImages,
    supportsFileAttachments,
  };
}

export const FREE_MODELS: LLMModel[] = rawFreeModels.map(applyCapabilities);

// ── BYOK (Bring Your Own Key) models ───────────────────────────────────────
// Static list of well-known models users can access with their own API keys.
// Requests go directly from the browser to the provider (no server proxy).

const ANTHROPIC_BYOK_MODELS: LLMModel[] = [
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 1_000_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$$',
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 1_000_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$$',
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 1_000_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$$',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 1_000_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 200_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$',
    // Predates Opus 4.7, so it still takes a tuned temperature.
    acceptsSamplingParams: true,
  },
];

const OPENAI_BYOK_MODELS: LLMModel[] = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 1_050_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 1_050_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 1_050_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 400_000,
    supportsImages: false,
    supportsFileAttachments: true,
    cost: '$$',
    // Still current: there is no 5.6 Codex.
    openaiApi: 'responses',
  },
];

export const BYOK_MODELS: LLMModel[] = [...ANTHROPIC_BYOK_MODELS, ...OPENAI_BYOK_MODELS];
export const ALL_MODELS = [...FREE_MODELS, ...BYOK_MODELS];

const FALLBACK_MODEL: LLMModel = {
  id: 'llm-model-missing',
  name: 'No model configured',
  provider: 'Unknown',
  tier: 'free',
  source: 'proxy',
  contextWindow: 128_000,
  supportsImages: false,
  supportsFileAttachments: true,
  notes: 'Set VITE_LLM_FREE_MODELS in environment or add your own API key in Settings.',
};

export const DEFAULT_FREE_MODEL = FREE_MODELS[0] ?? FALLBACK_MODEL;
export const DEFAULT_BYOK_MODEL = BYOK_MODELS[0] ?? DEFAULT_FREE_MODEL;

/**
 * Where an id this picker no longer offers should land.
 *
 * A selection persists in localStorage, so dropping an id silently reassigns
 * whoever had it to the default. That default is Opus 5, which is why this
 * matters: a Haiku user (1/5 per MTok) would land on Opus 5 (5/25) without
 * being told, and BYOK means it is their bill. An OpenAI user would land on an
 * Anthropic model and be asked for a key they never needed.
 *
 * Two kinds of entry, and the difference is worth keeping straight: the first
 * is the same model under a new name, the rest are a different model at a
 * similar price. "No longer offered here" is not the same as "retired" -- the
 * provider still serves Sonnet 4.6 and GPT-5.4; this picker just does not list
 * them any more, and their holders have to land somewhere. Same tier and same
 * provider beats the Opus 5 default, which is dearer and, for the OpenAI rows,
 * would demand a key the user never had.
 */
const MODEL_ID_MIGRATIONS: Record<string, string> = {
  // Same model: the dated snapshot and the alias.
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  // Dropped from the picker: nearest listed model, same provider and tier.
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'gpt-5.5': 'gpt-5.6-sol',
  'gpt-5.4': 'gpt-5.6-sol',
  'gpt-5.4-mini-2026-03-17': 'gpt-5.6-luna',
};

/** Resolve an id this picker no longer lists to one it does. */
export function canonicalModelId(id: string): string {
  return MODEL_ID_MIGRATIONS[id] ?? id;
}

export function getModelById(id: string): LLMModel | undefined {
  const canonical = canonicalModelId(id);
  return ALL_MODELS.find((m) => m.id === canonical);
}

/** Check whether a model ID requires a user-provided API key (BYOK) */
export function requiresByokKey(modelId: string): boolean {
  const model = getModelById(modelId);
  return model?.tier === 'byok';
}

/**
 * Whether to send `temperature`/`top_p`/`top_k` for a model id.
 *
 * Fails closed: an unknown or stale id gets no sampling params, because a
 * dropped temperature is cheaper than the 400 every current frontier model
 * returns when they are present. See `acceptsSamplingParams` in types.ts.
 */
export function sendsSamplingParams(modelId: string): boolean {
  return getModelById(modelId)?.acceptsSamplingParams === true;
}

/** Get BYOK models available for a given provider source */
export function getByokModelsForSource(source: 'anthropic' | 'openai'): LLMModel[] {
  return BYOK_MODELS.filter((m) => m.source === source);
}

export function getDefaultModelForEntitlement(hasByokKey: boolean): LLMModel {
  return hasByokKey ? DEFAULT_BYOK_MODEL : DEFAULT_FREE_MODEL;
}

export function coerceModelForEntitlement(modelId: string | null | undefined, hasByokKey: boolean): string {
  if (modelId) {
    // Return the canonical id, not what was stored: a renamed id must not be
    // written back and re-resolved on every load.
    const canonical = canonicalModelId(modelId);
    const model = getModelById(canonical);
    if (model && (!requiresByokKey(canonical) || hasByokKey)) {
      return canonical;
    }
  }
  return getDefaultModelForEntitlement(hasByokKey).id;
}
