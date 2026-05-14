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
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 200_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$$',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 200_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    tier: 'byok',
    source: 'anthropic',
    contextWindow: 200_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$',
  },
];

const OPENAI_BYOK_MODELS: LLMModel[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 128_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$$$',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 128_000,
    supportsImages: false,
    supportsFileAttachments: true,
    cost: '$$',
    openaiApi: 'responses',
  },
  {
    id: 'gpt-5.4-mini-2026-03-17',
    name: 'GPT-5.4 Mini',
    provider: 'OpenAI',
    tier: 'byok',
    source: 'openai',
    contextWindow: 128_000,
    supportsImages: true,
    supportsFileAttachments: true,
    cost: '$',
  },
];

export const BYOK_MODELS: LLMModel[] = [...ANTHROPIC_BYOK_MODELS, ...OPENAI_BYOK_MODELS];

// ── Local (WebLLM, in-browser) models ──────────────────────────────────────
// Model ids are MLC catalog ids — passed verbatim to CreateMLCEngine.
// Assets are fetched from huggingface.co/mlc-ai/<id> on first chat open.

export interface LocalModelMeta {
  /** Approximate on-disk size after download, in MB. Used for the consent banner. */
  approxSizeMB: number;
  /** Approximate VRAM/working-set requirement, in GB. Lets us pick a default. */
  vramRequirementGB: number;
  /** Friendly subtitle for the picker, e.g. "Best balance" or "Mobile-friendly". */
  blurb: string;
}

const LOCAL_MODELS: Array<LLMModel & { local: LocalModelMeta }> = [
  {
    id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
    name: 'Qwen2.5 Coder 7B',
    provider: 'Local (browser)',
    tier: 'local',
    source: 'webllm',
    contextWindow: 32_768,
    supportsImages: false,
    supportsFileAttachments: true,
    notes: 'Recommended local model. Runs in your browser via WebGPU. Free, private, offline after first load. 32K-token context fits the full BIM toolkit.',
    local: { approxSizeMB: 4200, vramRequirementGB: 6, blurb: 'Recommended — full BIM context · desktops & M-series Macs' },
  },
  {
    id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen2.5 Coder 1.5B',
    provider: 'Local (browser)',
    tier: 'local',
    source: 'webllm',
    // MLC's q4f16 1.5B build is compiled with a 4096-token window — much
    // smaller than the model's nominal 32K — to keep KV-cache memory bounded.
    contextWindow: 4_096,
    supportsImages: false,
    supportsFileAttachments: true,
    notes: 'Lightweight — works on most laptops and iPad Safari. 4K-token context is too small for the full BIM toolkit; intended for general chat, not script-assistant tasks.',
    local: { approxSizeMB: 900, vramRequirementGB: 2, blurb: 'Mobile-friendly · 4K context — general chat only' },
  },
  {
    id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    name: 'Hermes 3 (Llama 3.2 3B)',
    provider: 'Local (browser)',
    tier: 'local',
    source: 'webllm',
    contextWindow: 8_192,
    supportsImages: false,
    supportsFileAttachments: true,
    notes: 'Tuned for instruction-following and tool use. 8K context fits short BIM tasks but truncates aggressively — Qwen 7B preferred when you can spare the disk space.',
    local: { approxSizeMB: 1800, vramRequirementGB: 3, blurb: 'Better explanations · 8K context' },
  },
];

export const LOCAL_WEBLLM_MODELS: LLMModel[] = LOCAL_MODELS.map(({ local: _local, ...m }) => m);

const LOCAL_MODEL_META: Record<string, LocalModelMeta> = Object.fromEntries(
  LOCAL_MODELS.map((m) => [m.id, m.local]),
);

export function getLocalModelMeta(id: string): LocalModelMeta | undefined {
  return LOCAL_MODEL_META[id];
}

export const ALL_MODELS = [...FREE_MODELS, ...BYOK_MODELS, ...LOCAL_WEBLLM_MODELS];

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

export function getModelById(id: string): LLMModel | undefined {
  return ALL_MODELS.find((m) => m.id === id);
}

/** Check whether a model ID requires a user-provided API key (BYOK) */
export function requiresByokKey(modelId: string): boolean {
  const model = getModelById(modelId);
  return model?.tier === 'byok';
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
    const model = getModelById(modelId);
    if (model && (!requiresByokKey(modelId) || hasByokKey)) {
      return modelId;
    }
  }
  return getDefaultModelForEntitlement(hasByokKey).id;
}
