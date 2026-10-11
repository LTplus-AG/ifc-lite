/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modes (`06-ai-agent.md` §7): effort, task budget, root budget, the tools a
 * mode may use and the op kinds it may write. Effort and budgets are the
 * cost levers; they are tuned against the P-08 eval, not by intuition.
 */

import type { RootBudgetLimits, ToolTurnEffort } from '@ifc-lite/ai';
import type { AgentMode } from './prompts/system-v1.js';
import type { ToolGroup } from './tools/registry.js';

export interface ModeConfig {
  readonly mode: AgentMode;
  readonly effort: ToolTurnEffort;
  /** Advisory total for the task, sent where the provider supports task budgets (minimum 20k). */
  readonly taskBudget: number;
  /** Hard ceiling enforced by the root budget. */
  readonly budget: RootBudgetLimits;
  /** Per-request output ceiling. */
  readonly maxOutputTokens: number;
  readonly toolGroups: readonly ToolGroup[];
  /** Tools of those groups this mode may not use. */
  readonly excludeTools?: readonly string[];
  /** When set, the only op kinds (and fields) the mode may write. */
  readonly opGuard?: (op: { kind: string; payload?: unknown }) => string | null;
  /** The mode cannot run without a model bridge. */
  readonly needsModel?: boolean;
}

const ALL: readonly ToolGroup[] = ['schema', 'ids', 'model', 'bsdd'];
const ACT_TOOLS = ['ids_apply_ops', 'ids_undo', 'ids_apply_fix', 'ids_mark_unresolved', 'ids_ask_user'];

const TEXT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'doc.setInfo': new Set(['title', 'description', 'purpose', 'milestone']),
  'spec.set': new Set(['name', 'description', 'instructions']),
  'requirement.set': new Set(['description', 'instructions']),
};

/** Translate writes human-readable text only: never values, names or identifiers. */
function textOnly(op: { kind: string; payload?: unknown }): string | null {
  const payload = typeof op.payload === 'object' && op.payload !== null ? (op.payload as Record<string, unknown>) : {};
  const fields = TEXT_FIELDS[op.kind];
  if (!fields) return `${op.kind} is not allowed in Translate mode; only text fields may change`;
  return fields.has(String(payload.field)) ? null : `${op.kind} field "${String(payload.field)}" is not translatable text`;
}

export const MODES: Readonly<Record<AgentMode, ModeConfig>> = {
  draft: { mode: 'draft', effort: 'high', taskBudget: 120_000, budget: { maxRequests: 40, maxOutputTokens: 200_000 }, maxOutputTokens: 32_000, toolGroups: ALL },
  edit: { mode: 'edit', effort: 'medium', taskBudget: 40_000, budget: { maxRequests: 16, maxOutputTokens: 64_000 }, maxOutputTokens: 16_000, toolGroups: ALL },
  explain: {
    mode: 'explain', effort: 'low', taskBudget: 20_000, budget: { maxRequests: 6, maxOutputTokens: 24_000 }, maxOutputTokens: 8_000,
    toolGroups: ALL, excludeTools: ACT_TOOLS,
  },
  repair: { mode: 'repair', effort: 'medium', taskBudget: 40_000, budget: { maxRequests: 20, maxOutputTokens: 64_000 }, maxOutputTokens: 16_000, toolGroups: ALL },
  review: { mode: 'review', effort: 'high', taskBudget: 80_000, budget: { maxRequests: 24, maxOutputTokens: 120_000 }, maxOutputTokens: 24_000, toolGroups: ALL, excludeTools: ['ids_ask_user'] },
  infer: { mode: 'infer', effort: 'medium', taskBudget: 60_000, budget: { maxRequests: 20, maxOutputTokens: 80_000 }, maxOutputTokens: 16_000, toolGroups: ALL, needsModel: true },
  translate: {
    mode: 'translate', effort: 'medium', taskBudget: 40_000, budget: { maxRequests: 16, maxOutputTokens: 80_000 }, maxOutputTokens: 24_000,
    toolGroups: ['ids'], excludeTools: ['ids_ask_user', 'ids_apply_fix'], opGuard: textOnly,
  },
};
