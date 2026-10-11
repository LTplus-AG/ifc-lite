/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework-free view model of a proposal review (IDS-082): what the review
 * UI renders and how a selection changes. Any surface (the Studio panel of
 * P-03, the assistant panel, a CLI summary) renders the same rows and
 * passes the same selection to `acceptProposal`.
 *
 * Rows are grouped by specification. A batch that touches several
 * specifications appears under each and is selected as one unit, because
 * its ops were gated together.
 */

import type { Uuid } from '@ifc-lite/ids-authoring';
import type { FunnelCounts } from '../bridges.js';
import type { BatchSource, DiagnosticBrief, ProposalBatch } from '../sandbox/sandbox.js';
import type { AgentRunStatus, Proposal } from './proposal.js';

export type Selection = ReadonlySet<string>;

export interface BatchRow {
  id: string;
  label: string;
  origin: ProposalBatch['origin'];
  opCount: number;
  /** Distinct op kinds, in first-use order. */
  opKinds: string[];
  sources: BatchSource[];
  selected: boolean;
}

export interface SpecRow {
  specId: Uuid;
  name: string;
  change: 'added' | 'changed' | 'removed';
  batches: BatchRow[];
  selected: 'all' | 'some' | 'none';
  diagnostics: DiagnosticBrief[];
  /** Live counts of the draft specification, when a model was loaded. */
  preview?: FunnelCounts;
}

export interface ProposalView {
  status: AgentRunStatus;
  /** Why the run stopped early, in words; absent for a completed run. */
  stoppedBecause?: string;
  summary: string;
  model: string;
  specs: SpecRow[];
  /** Batches that touch no specification (document info, custom declarations). */
  documentBatches: BatchRow[];
  unresolved: Proposal['unresolved'];
  questions: Proposal['questions'];
  counts: { batches: number; selected: number; ops: number; selectedOps: number; errors: number };
  tokens: { input: number; output: number; complete: boolean };
  costUsd?: number;
}

const STOPPED: Partial<Record<AgentRunStatus, string>> = {
  'budget-exhausted': 'The run used its whole budget before it finished.',
  'no-progress': 'The run stopped because the same problems came back twice in a row.',
  cancelled: 'The run was cancelled.',
  timeout: 'A request timed out.',
  'wall-clock': 'The run reached its time limit.',
  refused: 'The model declined the request.',
  truncated: 'The model was cut off at its output limit.',
  error: 'The provider returned an error.',
};

export function initialSelection(proposal: Pick<Proposal, 'batches'>): Set<string> {
  return new Set(proposal.batches.map((b) => b.id));
}

export function toggleBatch(selection: Selection, batchId: string): Set<string> {
  const next = new Set(selection);
  if (next.has(batchId)) next.delete(batchId);
  else next.add(batchId);
  return next;
}

/** Select or clear every batch that touches a specification. */
export function setSpecSelected(proposal: Pick<Proposal, 'batches'>, selection: Selection, specId: Uuid, on: boolean): Set<string> {
  const next = new Set(selection);
  for (const b of proposal.batches) {
    if (!b.specIds.includes(specId)) continue;
    if (on) next.add(b.id);
    else next.delete(b.id);
  }
  return next;
}

function label(batch: ProposalBatch): string {
  if (batch.rationale) return batch.rationale;
  if (batch.fix) return `Fix ${batch.fix.code}`;
  return `${batch.ops.length} change${batch.ops.length === 1 ? '' : 's'}`;
}

function row(batch: ProposalBatch, selection: Selection): BatchRow {
  return {
    id: batch.id, label: label(batch), origin: batch.origin, opCount: batch.ops.length,
    opKinds: [...new Set(batch.ops.map((o) => o.kind))], sources: batch.sources, selected: selection.has(batch.id),
  };
}

function specName(doc: Proposal['draft'], specId: Uuid): string | undefined {
  const index = doc.nodes.specs.findIndex((s) => s.id === specId);
  return index >= 0 ? doc.ids.specifications[index].name : undefined;
}

export function proposalView(proposal: Proposal, selection: Selection): ProposalView {
  const baseNames = new Map(proposal.base.specs.map((s) => [s.specId, s.name]));
  const draftIds = new Set(proposal.draft.nodes.specs.map((s) => s.id));
  const order: Uuid[] = [];
  for (const b of proposal.batches) for (const id of b.specIds) if (!order.includes(id)) order.push(id);
  const specs: SpecRow[] = order.map((specId) => {
    const batches = proposal.batches.filter((b) => b.specIds.includes(specId)).map((b) => row(b, selection));
    const on = batches.filter((b) => b.selected).length;
    const change = !draftIds.has(specId) ? 'removed' : baseNames.has(specId) ? 'changed' : 'added';
    return {
      specId, name: specName(proposal.draft, specId) ?? baseNames.get(specId) ?? 'Removed specification', change, batches,
      selected: on === 0 ? 'none' : on === batches.length ? 'all' : 'some',
      diagnostics: proposal.diagnostics.filter((d) => d.specId === specId),
      ...(proposal.previews[specId] ? { preview: proposal.previews[specId] } : {}),
    };
  });
  const ops = proposal.batches.reduce((n, b) => n + b.ops.length, 0);
  const selectedOps = proposal.batches.filter((b) => selection.has(b.id)).reduce((n, b) => n + b.ops.length, 0);
  const { totals } = proposal.receipt;
  return {
    status: proposal.status,
    ...(STOPPED[proposal.status] ? { stoppedBecause: STOPPED[proposal.status] } : {}),
    summary: proposal.summary,
    model: proposal.model,
    specs,
    documentBatches: proposal.batches.filter((b) => b.specIds.length === 0).map((b) => row(b, selection)),
    unresolved: proposal.unresolved,
    questions: proposal.questions,
    counts: {
      batches: proposal.batches.length, selected: proposal.batches.filter((b) => selection.has(b.id)).length, ops, selectedOps,
      errors: proposal.diagnostics.filter((d) => d.severity === 'error').length,
    },
    tokens: { input: totals.inputTokens, output: totals.outputTokens, complete: totals.usageComplete },
    ...(proposal.receipt.costUsd !== undefined ? { costUsd: proposal.receipt.costUsd } : {}),
  };
}
