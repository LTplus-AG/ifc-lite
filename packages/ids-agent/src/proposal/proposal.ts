/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The proposal (`06-ai-agent.md` §1, §4): what an agent run hands the user.
 * It is the sandbox's record of applied batches, plus what the run could
 * not express, the questions it asked, the final diagnostics, previews and
 * the cost receipt. It is plain JSON: a host can persist it and review it
 * later.
 *
 * `acceptProposal` is the only bridge to the user's live document. It replays
 * the chosen batches, in order, through the grounding gate AGAINST THE LIVE
 * DOCUMENT (which may have changed since the run) and commits the accepted
 * ones as ONE history entry attributed to the run (`{ by: 'ai', runId }`),
 * so a single undo reverts the whole acceptance.
 */

import {
  apply,
  checkOps,
  commit,
  type GateContext,
  type StudioDocument,
  type StudioOp,
  type StudioState,
  type Uuid,
} from '@ifc-lite/ids-authoring';
import type { FunnelCounts } from '../bridges.js';
import type { AgentMode } from '../prompts/system-v1.js';
import type { RunReceipt } from '../runner/receipt.js';
import type { DiagnosticBrief, ProposalBatch, Refusal, UnresolvedStatement } from '../sandbox/sandbox.js';

export type AgentRunStatus =
  | 'completed'
  | 'budget-exhausted'
  | 'no-progress'
  | 'cancelled'
  | 'timeout'
  | 'wall-clock'
  | 'refused'
  | 'truncated'
  | 'error';

export interface AskedQuestion {
  id: string;
  question: string;
  choices: string[];
  /** Index of the chosen answer; null when dismissed. */
  picked: number | null;
}

export interface Proposal {
  runId: Uuid;
  mode: AgentMode;
  model: string;
  promptVersion: string;
  status: AgentRunStatus;
  /** The model's final message. */
  summary: string;
  /** The document the run started from: its id and specifications, to tell added from changed. */
  base: { docId: Uuid; specs: { specId: Uuid; name: string }[] };
  batches: ProposalBatch[];
  unresolved: UnresolvedStatement[];
  questions: AskedQuestion[];
  /** Diagnostics of the draft (errors and warnings only). */
  diagnostics: DiagnosticBrief[];
  /** The sandbox document with every batch applied: the preview. */
  draft: StudioDocument;
  /** Live counts per changed specification, when a model is loaded. */
  previews: Record<Uuid, FunnelCounts>;
  receipt: RunReceipt;
}

export interface AcceptResult {
  state: StudioState;
  accepted: string[];
  rejected: { batchId: string; refusals: Refusal[] }[];
}

/**
 * Commit the chosen batches (default: all) to the live state, each re-checked
 * by the gate against the live document. Rejected batches are reported, not
 * applied; nothing is committed when none is accepted.
 */
export function acceptProposal(
  live: StudioState,
  proposal: Pick<Proposal, 'runId' | 'model' | 'mode' | 'batches'>,
  options: { gate: GateContext; batchIds?: Iterable<string>; at?: string },
): AcceptResult {
  const wanted = options.batchIds ? new Set(options.batchIds) : null;
  let doc = live.doc;
  const ops: StudioOp[] = [];
  const accepted: string[] = [];
  const rejected: AcceptResult['rejected'] = [];
  for (const batch of proposal.batches) {
    if (wanted && !wanted.has(batch.id)) continue;
    const gate = checkOps(batch.ops, doc, options.gate);
    if (!gate.ok) {
      rejected.push({ batchId: batch.id, refusals: gate.issues.map((i) => ({
        code: i.code, path: i.path, message: i.message, candidates: i.candidates.slice(0, 5).map((c) => c.value),
        ...(i.value !== undefined ? { value: i.value } : {}),
      })) });
      continue;
    }
    try {
      doc = apply(doc, batch.ops).doc;
    } catch (error) {
      rejected.push({ batchId: batch.id, refusals: [{ code: 'AGENT-APPLY-001', path: 'ops', candidates: [],
        message: error instanceof Error ? error.message : String(error) }] });
      continue;
    }
    ops.push(...batch.ops);
    accepted.push(batch.id);
  }
  if (ops.length === 0) return { state: live, accepted, rejected };
  const { state } = commit(live, ops, {
    source: { by: 'ai', runId: proposal.runId, model: proposal.model },
    label: `AI ${proposal.mode}: ${accepted.length} of ${proposal.batches.length} changes`,
    ...(options.at ? { at: options.at } : {}),
  });
  return { state, accepted, rejected };
}
