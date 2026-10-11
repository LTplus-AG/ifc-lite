/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the request service may assume about a model, derived only from the
 * registry (`models.ts`) and the route ceilings (`shared/ai/output-budget`).
 * Nothing here is a guess: where the registry has no real figure the field
 * is null.
 */

import { ANTHROPIC_OUTPUT_TOKEN_CEILING, OPENAI_OUTPUT_TOKEN_CEILING, PROXY_OUTPUT_TOKEN_CEILING } from '../../../../../shared/ai/output-budget.js';
import { getModelById } from './models.js';
import type { LLMModel } from './types.js';

export interface ModelCapabilities {
  id: string;
  /** Which client carries the request. Unknown ids go through the proxy, as `resolveStreamRoute` does. */
  route: LLMModel['source'];
  tier: LLMModel['tier'] | 'unknown';
  /**
   * Context window from the registry's static BYOK rows. Null for proxy
   * models: the registry gives them a generic placeholder, not a figure
   * for the model actually routed.
   */
  contextWindow: number | null;
  /** The hard output ceiling the route enforces (client and server side). */
  maxOutputTokens: number;
  /**
   * Whether the direct transport implements a provider JSON Schema request.
   * This is a protocol capability, not a live-model success claim. Unsupported
   * models fail their schema request without silently retrying as plain text.
   */
  structuredOutput: boolean;
  /** Whether provider usage can arrive on this route's stream. */
  usageReporting: 'provider' | 'upstream-dependent';
}

const OUTPUT_CEILING: Record<LLMModel['source'], number> = {
  proxy: PROXY_OUTPUT_TOKEN_CEILING,
  openai: OPENAI_OUTPUT_TOKEN_CEILING,
  anthropic: ANTHROPIC_OUTPUT_TOKEN_CEILING,
};

export function modelCapabilities(modelId: string): ModelCapabilities {
  const model = getModelById(modelId);
  const route = model?.source ?? 'proxy';
  return {
    id: model?.id ?? modelId,
    route,
    tier: model?.tier ?? 'unknown',
    contextWindow: model && model.tier === 'byok' ? model.contextWindow : null,
    maxOutputTokens: OUTPUT_CEILING[route],
    structuredOutput: route !== 'proxy',
    // Anthropic always reports usage; OpenAI does when `include_usage` is sent,
    // which the direct client does. The proxy forwards whatever its upstream sends.
    usageReporting: route === 'proxy' ? 'upstream-dependent' : 'provider',
  };
}
