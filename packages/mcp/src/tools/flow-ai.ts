/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: host opt-in and one persistable pool shared by every node and resume. */
import { runModelRequest, type RootBudget, type UsageReceipt } from '@ifc-lite/ai';
import { flowAiConfig, chatCompletionsTransport } from '@ifc-lite/ai/chat-completions';
import { AI_FEATURE, type FlowAiService } from '@ifc-lite/flow-nodes/ai';
import { headlessFeatures, usableSecretNames } from '@ifc-lite/flow-nodes';

export function mcpFlowFeatures() {
  const features = headlessFeatures(usableSecretNames(process.env));
  return flowAiConfig(process.env) ? { ...features, backend: new Set([...features.backend, AI_FEATURE]) } : features;
}

export function mcpFlowAi(budget: RootBudget, receipts: unknown[], onStart: () => void): FlowAiService | undefined {
  const config = flowAiConfig(process.env);
  if (!config) return undefined;
  const transport = chatCompletionsTransport(config);
  return { model: config.model, request: call => runModelRequest({ model: config.model, route: 'mcp', transport, budget,
    routeCeiling: 8192, timeoutMs: 120_000, prepareInput: () => JSON.stringify({ messages: [call.prompt], system: call.system, outputSchema: call.outputSchema }),
      messages: [call.prompt], system: call.system, promptVersion: call.promptVersion,
    maxOutputTokens: call.maxOutputTokens, signal: call.signal, outputSchema: call.outputSchema }, { onStart, onReceipt: (receipt: UsageReceipt) => { receipts.push(receipt); } }) };
}
