/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's AI service for Flow AI nodes (#6923): the model chosen for
 * the Assistant, through the same request service (hosted proxy or the
 * user's own key), so every request has a usage receipt in the session log.
 *
 * One root budget per run, created here or restored from a review
 * checkpoint, so a resume continues the pool the paused run started instead
 * of granting a fresh one.
 */

import type { RootBudget } from '@ifc-lite/ai';
import { FLOW_AI_BUDGET, type FlowAiService } from '@ifc-lite/flow-nodes/ai';
import { resolveStreamRoute } from '@/lib/llm/byok-guard';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';
import { createRootBudget, LLM_PROXY_URL, restoreRootBudget, runModelRequest } from '@/lib/llm/request-service';
import { getApiKeys } from '@/services/api-keys';
import { useViewerStore } from '@/store';

const FLOW_AI_TIMEOUT_MS = 120_000;

export interface ViewerFlowAi {
  readonly service: FlowAiService;
  /** Spent by every AI request of the run; saved with a review checkpoint. */
  readonly budget: RootBudget;
}

/** The Assistant's model as a Flow AI service, or null when no model or key makes a request possible. */
export function viewerFlowAi(savedBudget?: unknown): ViewerFlowAi | null {
  const model = useViewerStore.getState().chatActiveModel;
  if (!model || model === UNCONFIGURED_MODEL_ID) return null;
  const route = resolveStreamRoute(model, getApiKeys());
  if (route.kind === 'missing-key') return null;
  const budget = restoreRootBudget(savedBudget) ?? createRootBudget(FLOW_AI_BUDGET);
  return {
    budget,
    service: {
      model,
      request: (call) => runModelRequest({
        route, proxyUrl: LLM_PROXY_URL, messages: [{ role: 'user', content: call.prompt }], system: call.system, promptVersion: call.promptVersion,
        maxOutputTokens: call.maxOutputTokens, budget, signal: call.signal, timeoutMs: FLOW_AI_TIMEOUT_MS,
        outputSchema: call.outputSchema,
      }),
    },
  };
}
