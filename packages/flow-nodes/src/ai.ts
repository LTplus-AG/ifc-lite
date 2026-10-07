/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/flow-nodes/ai`: the Flow AI nodes (#6923), a separate entry so a
 * host that never offers an AI service does not load them. Register them
 * next to the standard registry:
 *
 *   createStandardRegistry().registerAll(aiNodes)
 *
 * Each node needs `FlowHost.ai` and the `ai` backend feature, declares
 * `network.ai`, is volatile, and pauses the run for review of its proposal.
 */

import type { FlowNodeDef } from './host.js';
import { aiClassifyNode } from './ai-classify.js';
import { aiExtractNode } from './ai-extract.js';
import { aiSummarizeNode } from './ai-summarize.js';

export { AI_CAPABILITY, AI_FEATURE, FLOW_AI_BUDGET } from './ai-service.js';
export type { FlowAiCall, FlowAiService } from './ai-service.js';

export const aiNodes: readonly FlowNodeDef[] = [aiClassifyNode, aiSummarizeNode, aiExtractNode];
