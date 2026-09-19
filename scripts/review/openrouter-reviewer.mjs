#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/**
 * A CHAIN, not a single model. OpenRouter fronts many providers behind one
 * key, so a model-specific outage (rate limit, deprecation, a provider's own
 * downtime) does not have to take the whole fallback down with it: the next
 * model in the list is tried before giving up. All three are verified present
 * on OpenRouter's /models list at the time this was written.
 */
export const OPENROUTER_REVIEW_MODELS_DEFAULT = ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna'];
export const OPENROUTER_JUDGE_MODELS_DEFAULT = ['anthropic/claude-haiku-4.5', 'openai/gpt-5.4-mini'];

/** Kept as a plain single-model constant: the first of the review chain. */
export const OPENROUTER_REVIEW_MODEL = OPENROUTER_REVIEW_MODELS_DEFAULT[0];

/** Extract the model's text, whether it comes back as a string or an array of parts. */
export function responseText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
  }
  return '';
}

export async function requestOpenRouterReview({ prompt, apiKey, model = OPENROUTER_REVIEW_MODEL, fetchImpl = fetch }) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/LTplus-AG/ifc-lite',
      'X-Title': 'ifc-lite review lane',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 32768,
      reasoning: { effort: 'high' },
    }),
  });
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  if (!response.ok) {
    const detail = String(parsed?.error?.message ?? body ?? '(empty)').slice(0, 2000);
    throw new Error(`OpenRouter chat completions API returned HTTP ${response.status}: ${detail}`);
  }
  const text = responseText(parsed?.choices?.[0]?.message);
  if (!text) throw new Error('OpenRouter response completed without output text.');
  return text;
}

/**
 * Split a comma-separated model list. Returns `[]` (not the caller's default)
 * on empty input, so a caller can tell "nothing configured" from "configured
 * to one model" and choose its own fallback -- see `resolveModelChain`.
 */
export function parseModelChain(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return [];
  return trimmed.split(',').map((m) => m.trim()).filter(Boolean);
}

/**
 * The plural env var wins when set; the singular one is accepted as an
 * override that becomes a one-element chain, so an existing
 * `OPENROUTER_REVIEW_MODEL` (or `OPENROUTER_JUDGE_MODEL`) setting keeps
 * working unchanged rather than being silently ignored once the chain
 * shipped.
 */
export function resolveModelChain({ modelsRaw, modelRaw, defaults }) {
  const plural = parseModelChain(modelsRaw);
  if (plural.length > 0) return plural;
  const single = String(modelRaw ?? '').trim();
  if (single) return [single];
  return defaults;
}

/**
 * Try each model in order. A model-level failure -- HTTP error, empty
 * content, anything `requestOpenRouterReview` throws -- logs and moves to the
 * next one; only exhausting the whole chain is a hard failure. Returns which
 * model actually answered, because the caller (`runReviewerWithFailover`)
 * reports it in the posted envelope rather than leaving "which model" a
 * mystery on a run that used the third choice.
 */
export async function requestOpenRouterReviewChain({ prompt, apiKey, models, fetchImpl = fetch }) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('No OpenRouter model configured.');
  }
  const failures = [];
  for (const [i, model] of models.entries()) {
    try {
      const text = await requestOpenRouterReview({ prompt, apiKey, model, fetchImpl });
      return { text, model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = models[i + 1] ?? '(no more models)';
      console.error(`provider openrouter: ${model} failed: ${message}; trying ${next}`);
      failures.push(`${model}: ${message}`);
    }
  }
  throw new Error(`Every OpenRouter model failed:\n${failures.join('\n')}`);
}

/**
 * Run async fetch in an isolated child while the Claude CLI path stays
 * synchronous. The chosen model cannot travel back to the parent through
 * stdout -- that channel is the review text itself -- so it rides a single
 * `MODEL_USED:` line on stderr instead, which the parent strips out below.
 */
export function runOpenRouterFallback({ prompt, apiKey, models = OPENROUTER_REVIEW_MODELS_DEFAULT, spawn = spawnSync }) {
  const result = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OPENROUTER_API_KEY: apiKey, OPENROUTER_REVIEW_MODELS: models.join(',') },
  });
  if (result.error) throw new Error(`Could not spawn OpenRouter fallback: ${result.error.message}`);
  const stderr = String(result.stderr ?? '');
  if (result.status !== 0) {
    throw new Error(`OpenRouter fallback exited ${result.status}: ${stderr.trim() || '(empty)'}`);
  }
  const text = String(result.stdout ?? '').trim();
  if (!text) throw new Error('OpenRouter fallback exited 0 without output text.');
  const modelUsed = stderr.match(/^MODEL_USED:(\S+)$/m)?.[1];
  return { text, model: modelUsed };
}

if (isMainEntry(import.meta.url)) {
  try {
    const apiKey = String(process.env.OPENROUTER_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing.');
    const models = resolveModelChain({
      modelsRaw: process.env.OPENROUTER_REVIEW_MODELS,
      modelRaw: process.env.OPENROUTER_REVIEW_MODEL,
      defaults: OPENROUTER_REVIEW_MODELS_DEFAULT,
    });
    const { text, model } = await requestOpenRouterReviewChain({ prompt: readFileSync(0, 'utf8'), apiKey, models });
    process.stderr.write(`MODEL_USED:${model}\n`);
    process.stdout.write(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
