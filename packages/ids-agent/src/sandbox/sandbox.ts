/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sandbox fork an agent run works on (ADR-008).
 *
 * It starts from a copy of the user's document and changes ONLY through the
 * op vocabulary: every batch passes the grounding gate (`checkOps`) before
 * the reducer applies it (`commit`), all or nothing. A rejected batch leaves
 * the fork untouched and returns the gate issues, with ranked candidates,
 * for the model to correct. After each applied batch the linter re-runs and
 * the diagnostics delta is reported back.
 *
 * Every applied batch is recorded with its rationale and sources: those
 * records ARE the proposal the user reviews. The live document is never
 * touched here; `acceptProposal` replays chosen batches through the gate
 * again against the live document.
 */

import {
  checkOps,
  commit,
  createLinter,
  createStudioState,
  undo as undoState,
  type Diagnostic,
  type GateContext,
  type GateIssue,
  type LintContext,
  type Linter,
  type StudioDocument,
  type StudioOp,
  type StudioState,
  type Uuid,
} from '@ifc-lite/ids-authoring';
import { createHandleTable, type HandleTable } from './handles.js';
import { diagnosticId, specIdsFor } from './nodes.js';

/** Op kinds the reducer emits as exact inverses; an agent never authors them. */
export const FIDELITY_KINDS: ReadonlySet<string> = new Set(['spec.restore', 'spec.patch', 'facet.restore', 'facet.patch']);

/** Where a batch's content came from in the user's source material. */
export interface BatchSource {
  /** Index of the op in the batch the source supports; absent for the whole batch. */
  opIndex?: number;
  docRef?: string;
  quote: string;
  page?: number;
}

export interface ProposalBatch {
  /** `b1`, `b2`, … in apply order. */
  id: string;
  origin: 'apply_ops' | 'apply_fix' | 'ask_user';
  /** Resolved ops (handles replaced, op ids filled), exactly as committed to the fork. */
  ops: StudioOp[];
  rationale?: string;
  sources: BatchSource[];
  /** Specifications the batch created, changed or removed. */
  specIds: Uuid[];
  /** Set for `apply_fix`: the diagnostic it fixed. */
  fix?: { code: string; diagnosticId: string };
}

export type UnresolvedCategory = 'geometry' | 'relationship' | 'rules-engine' | 'manual' | 'ambiguous' | 'out-of-scope';

export interface UnresolvedStatement {
  id: string;
  statement: string;
  category: UnresolvedCategory;
  reason: string;
  source?: BatchSource;
}

/** One gate (or reducer) refusal, abridged for the model. */
export interface Refusal {
  code: string;
  path: string;
  message: string;
  candidates: string[];
  value?: string;
}

export interface DiagnosticBrief {
  diagnosticId: string;
  code: string;
  severity: Diagnostic['severity'];
  message: string;
  specId?: Uuid;
  fixes: string[];
}

export type ApplyOutcome =
  | { applied: true; batch: ProposalBatch; added: DiagnosticBrief[]; resolved: number; handles: Record<string, Uuid> }
  | { applied: false; refusals: Refusal[] };

export interface SandboxOptions {
  doc: StudioDocument;
  gate: GateContext;
  lint: LintContext;
  runId: string;
  /** Recorded on the fork's history entries. */
  model: string;
  /** Mode restriction on op kinds and fields; returns the reason an op is not allowed. */
  opGuard?: (op: { kind: string; payload?: unknown }) => string | null;
}

export interface Sandbox {
  readonly base: StudioDocument;
  readonly doc: StudioDocument;
  readonly batches: readonly ProposalBatch[];
  readonly unresolved: readonly UnresolvedStatement[];
  readonly handles: HandleTable;
  diagnostics(): Diagnostic[];
  apply(ops: readonly unknown[], meta: { origin: ProposalBatch['origin']; rationale?: string; sources?: BatchSource[]; fix?: ProposalBatch['fix'] }): ApplyOutcome;
  /** Undo the latest `steps` batches; returns how many were undone. */
  undo(steps: number): number;
  markUnresolved(entry: Omit<UnresolvedStatement, 'id'>): UnresolvedStatement;
}

export function brief(d: Diagnostic): DiagnosticBrief {
  return {
    diagnosticId: diagnosticId(d), code: d.code, severity: d.severity, message: d.message,
    ...(d.specId ? { specId: d.specId } : {}), fixes: (d.fixes ?? []).map((f) => f.label),
  };
}

function refusalOf(issue: GateIssue): Refusal {
  return {
    code: issue.code, path: issue.path, message: issue.message,
    candidates: issue.candidates.slice(0, 5).map((c) => c.value),
    ...(issue.value !== undefined ? { value: issue.value } : {}),
  };
}

function guardOps(ops: readonly unknown[], guard: SandboxOptions['opGuard']): Refusal | null {
  if (!guard) return null;
  for (const [index, op] of ops.entries()) {
    const record = typeof op === 'object' && op !== null ? (op as { kind?: unknown; payload?: unknown }) : {};
    const reason = guard({ kind: String(record.kind), payload: record.payload });
    if (reason) return { code: 'AGENT-MODE-001', path: `ops[${index}]`, message: reason, candidates: [] };
  }
  return null;
}

export function createSandbox(options: SandboxOptions): Sandbox {
  const { gate, runId, model } = options;
  const base = options.doc;
  let state: StudioState = createStudioState(base);
  const linter: Linter = createLinter(options.lint);
  let current: Diagnostic[] = linter.lint(base).diagnostics;
  const batches: ProposalBatch[] = [];
  const unresolved: UnresolvedStatement[] = [];
  const handles = createHandleTable(runId);
  let batchCounter = 0;
  let unresolvedCounter = 0;

  return {
    base,
    get doc() { return state.doc; },
    get batches() { return batches; },
    get unresolved() { return unresolved; },
    handles,
    diagnostics: () => current,
    apply(rawOps, meta) {
      const fidelity = rawOps.findIndex((op) => typeof op === 'object' && op !== null && FIDELITY_KINDS.has(String((op as { kind?: unknown }).kind)));
      if (fidelity >= 0) {
        return { applied: false, refusals: [{ code: 'AGENT-OP-001', path: `ops[${fidelity}].kind`, candidates: [],
          message: 'restore/patch ops are emitted by undo only; use the authoring ops (spec.add, facet.add, value.set, …).' }] };
      }
      const guarded = guardOps(rawOps, options.opGuard);
      if (guarded) return { applied: false, refusals: [guarded] };
      const ops = handles.resolve(rawOps);
      const gateResult = checkOps(ops, state.doc, gate);
      if (!gateResult.ok) return { applied: false, refusals: gateResult.issues.map(refusalOf) };
      const before = state.doc;
      let touched: Set<Uuid>;
      try {
        // The gate passed `ops`, so they are well-formed `StudioOp`s.
        const committed = commit(state, ops as StudioOp[], { source: { by: 'ai', runId, model } });
        state = committed.state;
        touched = committed.result.touched;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { applied: false, refusals: [{ code: 'AGENT-APPLY-001', path: 'ops', message, candidates: [] }] };
      }
      const previous = new Set(current.map(diagnosticId));
      const next = linter.lint(state.doc, { touched }).diagnostics;
      const nextIds = new Set(next.map(diagnosticId));
      const added = next.filter((d) => !previous.has(diagnosticId(d))).map(brief);
      const resolved = [...previous].filter((id) => !nextIds.has(id)).length;
      current = next;
      const batch: ProposalBatch = {
        id: `b${++batchCounter}`, origin: meta.origin, ops: ops as StudioOp[],
        ...(meta.rationale ? { rationale: meta.rationale } : {}),
        sources: meta.sources ?? [], specIds: specIdsFor(touched, before, state.doc),
        ...(meta.fix ? { fix: meta.fix } : {}),
      };
      batches.push(batch);
      const used = Object.fromEntries([...handles.handles].filter(([handle]) => JSON.stringify(rawOps).includes(`"${handle}"`)));
      return { applied: true, batch, added, resolved, handles: used };
    },
    undo(steps) {
      let undone = 0;
      while (undone < steps && batches.length > 0) {
        state = undoState(state);
        batches.pop();
        undone += 1;
      }
      if (undone > 0) current = linter.lint(state.doc).diagnostics;
      return undone;
    },
    markUnresolved(entry) {
      const item: UnresolvedStatement = { id: `u${++unresolvedCounter}`, ...entry };
      unresolved.push(item);
      return item;
    },
  };
}
