/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CLI's AI service for `ai.*` Flow nodes (#6923).
 *
 * Opt-in through the environment, never through the graph:
 *
 *   IFC_LITE_AI_MODEL     model id sent to the provider (required)
 *   IFC_LITE_AI_API_KEY   bearer key (required; never logged, never in a checkpoint)
 *   IFC_LITE_AI_BASE_URL  OpenAI-compatible endpoint, default https://openrouter.ai/api/v1
 *
 * Without both required variables the host does not list the `ai` feature,
 * so a graph with AI nodes fails availability before anything runs. Every
 * request goes through the shared `@ifc-lite/ai` core against ONE root budget
 * for the whole run, restored from the checkpoint on resume so a pause never
 * resets what was spent.
 */

import { createRootBudget, runModelRequest, type RootBudget } from '@ifc-lite/ai';
import { chatCompletionsTransport, type FlowAiConfig } from '@ifc-lite/ai/chat-completions';
import { FLOW_AI_BUDGET, type FlowAiService } from '@ifc-lite/flow-nodes/ai';

const ROUTE_CEILING = 8_192;
const TIMEOUT_MS = 120_000;

export function createCliAiService(config: FlowAiConfig, budget: RootBudget = createRootBudget(FLOW_AI_BUDGET), transport = chatCompletionsTransport(config)): FlowAiService {
  return {
    model: config.model,
    request: (call) => runModelRequest({
      model: config.model, route: 'cli', transport, budget, routeCeiling: ROUTE_CEILING, timeoutMs: TIMEOUT_MS,
      messages: [call.prompt], system: call.system, promptVersion: call.promptVersion, maxOutputTokens: call.maxOutputTokens, signal: call.signal,
      outputSchema: call.outputSchema,
    }),
  };
}
