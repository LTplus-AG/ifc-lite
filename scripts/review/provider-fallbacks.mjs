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

import {
  runOpenRouterFallback, resolveModelChain, resolveTimeoutMs,
  OPENROUTER_REVIEW_MODELS_DEFAULT, OPENROUTER_TIMEOUT_MS_DEFAULT,
} from './openrouter-reviewer.mjs';
import { runOpenAiFallback } from './openai-reviewer.mjs';

// The single reviewer test never exercises this, and the change belongs beside
// the doc comment below rather than repeated at each call site: the fallback
// TIMEOUT BUDGET IS ONE KNOB FOR THE WHOLE CHAIN, not an OpenRouter-only
// setting that direct OpenAI happens to lack (#4981 finding-4). Both
// providers in the chain are optional, best-effort fallbacks behind the same
// caller policy -- "the judge must fail soft quickly, the reviewer can afford
// to wait longer" -- so both take the SAME resolved `timeoutMs`, computed
// once here regardless of which provider(s) actually end up configured.

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   openRouterModelsEnvVar?: string,  name of the plural (comma-separated) env var
 *   openRouterModelEnvVar?: string,   name of the singular override env var
 *   openRouterDefaultModels?: string[],
 *   openRouterTimeoutMsDefault?: number,  this caller's DEFAULT per-model timeout,
 *     applied to BOTH providers in the chain, OpenRouter and direct OpenAI alike;
 *     `env.OPENROUTER_TIMEOUT_MS`, if set, overrides it for either caller alike.
 *   spawn?: Function,  test-only override forwarded to BOTH providers' own
 *     `spawn` parameter, so a test can observe the timeout each one actually
 *     hands its child process without invoking a real `spawnSync` or network
 *     call. Production never sets this; each provider's own default (the real
 *     `spawnSync`) is used instead.
 * }} [opts]
 *   Reviewer and judge pass their OWN env-var names in here (`OPENROUTER_REVIEW_MODELS`/
 *   `OPENROUTER_REVIEW_MODEL` vs `OPENROUTER_JUDGE_MODELS`/`OPENROUTER_JUDGE_MODEL`) and
 *   their own default chain, so the two cannot silently share one knob. The judge
 *   passes a SHORTER default timeout (120000 vs the reviewer's 300000): it is an
 *   optional precision filter that must fail soft quickly rather than sit on the
 *   job's clock the way the primary review path can afford to.
 * @returns {{ label: string, run: (prompt: string) => (string | { text: string, model?: string }) }[]}
 */
export function resolveProviderFallbacks(env, {
  openRouterModelsEnvVar = 'OPENROUTER_REVIEW_MODELS',
  openRouterModelEnvVar = 'OPENROUTER_REVIEW_MODEL',
  openRouterDefaultModels = OPENROUTER_REVIEW_MODELS_DEFAULT,
  openRouterTimeoutMsDefault = OPENROUTER_TIMEOUT_MS_DEFAULT,
  spawn = undefined,
} = {}) {
  const providers = [];
  // Resolved ONCE, ahead of either provider, so both take the same budget
  // regardless of which one(s) end up configured -- see the module doc
  // comment above.
  const timeoutMs = resolveTimeoutMs(env.OPENROUTER_TIMEOUT_MS, openRouterTimeoutMsDefault);
  const openRouterKey = String(env.OPENROUTER_API_KEY ?? '').trim();
  if (openRouterKey) {
    const models = resolveModelChain({
      modelsRaw: env[openRouterModelsEnvVar],
      modelRaw: env[openRouterModelEnvVar],
      defaults: openRouterDefaultModels,
    });
    providers.push({
      label: 'openrouter-fallback',
      run: (prompt) => runOpenRouterFallback({ prompt, apiKey: openRouterKey, models, timeoutMs, ...(spawn ? { spawn } : {}) }),
    });
  }
  const openAiKey = String(env.OPENAI_API_KEY ?? '').trim();
  if (openAiKey) {
    providers.push({
      label: 'openai-fallback',
      run: (prompt) => runOpenAiFallback({ prompt, apiKey: openAiKey, timeoutMs, ...(spawn ? { spawn } : {}) }),
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
