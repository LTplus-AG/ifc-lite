/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/ids-agent — the IDS authoring agent (ADR-008).
 *
 * A tool-calling loop over the op vocabulary of `@ifc-lite/ids-authoring`.
 * The agent works on a sandbox fork, changes it only through the grounding
 * gate, and returns a proposal the user reviews. Provider adapters live in
 * `@ifc-lite/ids-agent/anthropic` and `@ifc-lite/ids-agent/openai`; model
 * doubles and recorded transcripts in `@ifc-lite/ids-agent/testing`.
 * See `docs/architecture/ids-studio/03-architecture/06-ai-agent.md`.
 */

export { runAgent, DEFAULT_AGENT_MODEL, type AgentRunOptions, type AgentRun, type AgentEvent } from './runner/loop.js';
export type { Attachment } from './runner/context.js';
export { MODES, type ModeConfig } from './modes.js';
export { SYSTEM_PROMPT_VERSION, systemPrompt, type AgentMode } from './prompts/system-v1.js';

// Proposal and review (IDS-082)
export { acceptProposal, type Proposal, type AcceptResult, type AgentRunStatus, type AskedQuestion } from './proposal/proposal.js';
export {
  proposalView,
  initialSelection,
  toggleBatch,
  setSpecSelected,
  type ProposalView,
  type SpecRow,
  type BatchRow,
  type Selection,
} from './proposal/view-model.js';
export type {
  ProposalBatch,
  BatchSource,
  UnresolvedStatement,
  UnresolvedCategory,
  DiagnosticBrief,
  Refusal,
} from './sandbox/sandbox.js';

// Receipts and privacy (IDS-080, IDS-086)
export type { RunReceipt, ToolCallRecord, ModelPricing } from './runner/receipt.js';
export { privacyView, type PrivacyView, type PrivacyRequestView, type PrivacyEntry, type PrivacySource, type SentRequest, type ContextPart } from './runner/privacy.js';

// Host bridges (IDS-078, IDS-079, IDS-081)
export {
  firstChoice,
  type ModelBridge,
  type ModelSummary,
  type ClassCount,
  type FunnelCounts,
  type FunnelStage,
  type DistinctValues,
  type InferenceResult,
  type InferenceCandidate,
  type BsddClient,
  type BsddClassSummary,
  type BsddClassCard,
  type BsddPropertyCard,
  type BsddResolution,
  type AskUserHandler,
  type AskUserQuestion,
  type AskUserChoice,
} from './bridges.js';
export { createWorkerModelBridge, serveModelBridge, type BridgePort, type BridgeRequest, type BridgeResponse } from './worker-bridge.js';

// Tool registry (IDS-076)
export { ALL_TOOLS } from './tools/index.js';
