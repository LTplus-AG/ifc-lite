/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for the LLM chat integration.
 */

import type { RepairScope, ScriptDiagnostic } from './script-diagnostics.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Timestamp in ms */
  createdAt: number;
  /** Parsed code blocks from assistant messages */
  codeBlocks?: CodeBlock[];
  /** Execution results for code blocks in this message */
  execResults?: Map<number, CodeExecResult>;
  /** Attached files (user messages only) */
  attachments?: FileAttachment[];
}

export interface CodeBlock {
  /** Index within the message */
  index: number;
  /** Language hint from the code fence (e.g. 'js', 'typescript') */
  language: string;
  /** The code content */
  code: string;
}

export interface CodeExecResult {
  status: 'running' | 'success' | 'error';
  logs?: Array<{ level: string; args: unknown[] }>;
  value?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ScriptEditorSelection {
  from: number;
  to: number;
}

export interface ScriptEditorTextChange {
  from: number;
  to: number;
  insert: string;
}

interface ScriptEditBase {
  opId: string;
  baseRevision: number;
  groupId?: string;
  scope?: RepairScope;
  atomic?: boolean;
  targetRootCause?: string;
}

export interface ScriptEditInsertOp extends ScriptEditBase {
  type: 'insert';
  at: number;
  text: string;
}

export interface ScriptEditReplaceRangeOp extends ScriptEditBase {
  type: 'replaceRange';
  from: number;
  to: number;
  text: string;
  expectedText?: string;
}

export interface ScriptEditReplaceSelectionOp extends ScriptEditBase {
  type: 'replaceSelection';
  text: string;
}

export interface ScriptEditAppendOp extends ScriptEditBase {
  type: 'append';
  text: string;
}

export interface ScriptEditReplaceAllOp extends ScriptEditBase {
  type: 'replaceAll';
  text: string;
}

export type ScriptEditOperation =
  | ScriptEditInsertOp
  | ScriptEditReplaceRangeOp
  | ScriptEditReplaceSelectionOp
  | ScriptEditAppendOp
  | ScriptEditReplaceAllOp;

export type ChatRepairReason = 'runtime' | 'preflight' | 'patch-conflict' | 'patch-apply';

export interface ChatRepairRequest {
  error: string;
  reason: ChatRepairReason;
  diagnostics?: ScriptDiagnostic[];
  staleCodeBlock?: string;
  includeSelection?: boolean;
  requestedRepairScope?: RepairScope;
  rootCauseKey?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Parsed CSV rows (if CSV file) */
  csvData?: Record<string, string>[];
  /** Column names (if CSV file) */
  csvColumns?: string[];
  /** Raw text content */
  textContent?: string;
  /** Base64-encoded image data (for image attachments) */
  imageBase64?: string;
  /** Whether this is an image attachment */
  isImage?: boolean;
}

export type ModelTier = 'free' | 'byok';

/**
 * Where requests for this model are routed.
 * - 'proxy': through the server-side proxy (free models)
 * - 'anthropic': direct browser-to-Anthropic API (user's own key)
 * - 'openai': direct browser-to-OpenAI API (user's own key)
 */
export type ModelSource = 'proxy' | 'anthropic' | 'openai';

/** Relative cost indicator for paid models */
export type ModelCost = '$' | '$$' | '$$$';

export interface LLMModel {
  id: string;
  name: string;
  provider: string;
  tier: ModelTier;
  /** Where requests are routed — proxy (free) or direct to provider (BYOK) */
  source: ModelSource;
  contextWindow: number;
  /** Whether this model accepts image inputs in chat content */
  supportsImages: boolean;
  /** Whether this model should receive uploaded file context */
  supportsFileAttachments: boolean;
  /** Notes shown in model selector */
  notes?: string;
  /** Relative cost indicator (BYOK models only) */
  cost?: ModelCost;
  /** OpenAI API variant: 'chat' (default) or 'responses' (Codex-style models) */
  openaiApi?: 'chat' | 'responses';
}

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'error';
