/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model transport for the IDS agent in the viewer (IDS-085): the model
 * chosen for the Assistant, called directly with the user's own key.
 *
 * The agent needs tool calling. The hosted proxy carries text completions
 * only, so the free route is refused here with a reason the panel shows,
 * rather than degraded into the JSON-proposal path this replaces. Keys stay
 * in the browser (`byok-guard.ts`); the Anthropic client is the one place
 * that adds the workspace header (`anthropic-client.ts`).
 */

import type { ToolTurnTransport } from '@ifc-lite/ai';
import { anthropicTransport } from '@ifc-lite/ids-agent/anthropic';
import { openAiTransport } from '@ifc-lite/ids-agent/openai';
import { createAnthropicClient } from '@/lib/llm/anthropic-client';
import { resolveStreamRoute } from '@/lib/llm/byok-guard';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';
import { getApiKeys } from '@/services/api-keys';

export type AgentRoute =
  | { kind: 'ready'; route: 'anthropic' | 'openai'; model: string; transport: ToolTurnTransport }
  | { kind: 'missing-model' }
  | { kind: 'missing-key'; provider: 'anthropic' | 'openai' }
  /** The hosted free models do not offer tool calling through the proxy. */
  | { kind: 'needs-key' };

export function idsAgentRoute(model: string | null | undefined): AgentRoute {
  if (!model || model === UNCONFIGURED_MODEL_ID) return { kind: 'missing-model' };
  const route = resolveStreamRoute(model, getApiKeys());
  if (route.kind === 'missing-key') return route;
  if (route.kind === 'proxy') return { kind: 'needs-key' };
  if (route.kind === 'anthropic') {
    return { kind: 'ready', route: 'anthropic', model: route.model, transport: anthropicTransport(createAnthropicClient(route.credentials)) };
  }
  return { kind: 'ready', route: 'openai', model: route.model, transport: openAiTransport({ apiKey: route.apiKey }) };
}
