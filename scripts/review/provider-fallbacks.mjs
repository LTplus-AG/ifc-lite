/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ONE shared builder for the independent-provider chain, used by both
 * run-reviewer.mjs and run-judge.mjs. Two separate call sites hand-building
 * this list is how they drift: the reviewer gaining a provider the judge never
 * sees is a silent gap, not a loud one, because the judge fails soft anyway.
 *
 * ORDER: OpenRouter first (itself a chain of models, see openrouter-reviewer.mjs),
 * then direct OpenAI. OpenRouter is the maintainer's chosen primary independent
 * provider; direct OpenAI stays wired as a last resort since it is already paid
 * for even while it returns 429 "no credits" -- the moment credits are restored
 * it starts working again with no code change.
 */

import { runOpenRouterFallback, resolveModelChain, OPENROUTER_REVIEW_MODELS_DEFAULT } from './openrouter-reviewer.mjs';
import { runOpenAiFallback } from './openai-reviewer.mjs';

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   openRouterModelsEnvVar?: string,  name of the plural (comma-separated) env var
 *   openRouterModelEnvVar?: string,   name of the singular override env var
 *   openRouterDefaultModels?: string[],
 * }} [opts]
 *   Reviewer and judge pass their OWN env-var names in here (`OPENROUTER_REVIEW_MODELS`/
 *   `OPENROUTER_REVIEW_MODEL` vs `OPENROUTER_JUDGE_MODELS`/`OPENROUTER_JUDGE_MODEL`) and
 *   their own default chain, so the two cannot silently share one knob.
 * @returns {{ label: string, run: (prompt: string) => (string | { text: string, model?: string }) }[]}
 */
export function resolveProviderFallbacks(env, {
  openRouterModelsEnvVar = 'OPENROUTER_REVIEW_MODELS',
  openRouterModelEnvVar = 'OPENROUTER_REVIEW_MODEL',
  openRouterDefaultModels = OPENROUTER_REVIEW_MODELS_DEFAULT,
} = {}) {
  const providers = [];
  const openRouterKey = String(env.OPENROUTER_API_KEY ?? '').trim();
  if (openRouterKey) {
    const models = resolveModelChain({
      modelsRaw: env[openRouterModelsEnvVar],
      modelRaw: env[openRouterModelEnvVar],
      defaults: openRouterDefaultModels,
    });
    providers.push({
      label: 'openrouter-fallback',
      run: (prompt) => runOpenRouterFallback({ prompt, apiKey: openRouterKey, models }),
    });
  }
  const openAiKey = String(env.OPENAI_API_KEY ?? '').trim();
  if (openAiKey) {
    providers.push({
      label: 'openai-fallback',
      run: (prompt) => runOpenAiFallback({ prompt, apiKey: openAiKey }),
    });
  }
  return providers;
}

/** The "provider fallback:" log line, shared so the two callers say the same thing the same way. */
export function describeProviderFallbacks(providers) {
  if (providers.length === 0) {
    return 'provider fallback: NOT configured (set OPENROUTER_API_KEY or OPENAI_API_KEY).';
  }
  return `provider fallback: configured (${providers.map((p) => p.label).join(' then ')}).`;
}
