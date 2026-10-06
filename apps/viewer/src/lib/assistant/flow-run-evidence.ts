/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native diagnostics of the last Flow run (#6919), shared by the `flowRun`
 * evidence adapter (what the Assistant sees) and debug-proposal review (what
 * a diagnosis may cite). Everything here is read from `flowLastRun` /
 * `flowLastError` / `flowLastRunWindow` / `flowRunWarnings` /
 * `flowArtifacts`; nothing is re-executed or inferred.
 *
 * Parameter policy: parameters are included only for nodes that failed
 * (`error` or lane errors; a `skipped` node only follows an upstream failure)
 * and the nodes feeding them, so a debug proposal can correct them. Even
 * there, `code` parameters (script source) are withheld, credential-like
 * text (bearer tokens, URL user info, token query values, API keys) is
 * redacted, and credential-named keys are withheld by `evidenceJson`. Without
 * a loaded node registry the kinds are unknown and every value is withheld.
 */

import { countItems, type FlowDocument, type NodeReport, type NodeStatus, type RunResult } from '@ifc-lite/flow';
import type { WorkflowArtifact } from '../flow/artifact';
import type { FlowRunWindow } from '@/store/slices/flowSlice';
import { withUpstream } from '../flow/upstream';
import { flowParamDefs } from '../flow/param-kinds';

type FlowRunState = {
  flowDoc: FlowDocument | null;
  flowLastRun: RunResult | null;
  flowLastError: string | null;
  flowLastRunWindow: FlowRunWindow | null;
  flowRunWarnings: readonly string[];
  flowArtifacts: readonly WorkflowArtifact[];
};

/** The native run a `flowRun` snapshot describes (its adapter identity). */
export interface FlowRunPin {
  readonly run: RunResult | null;
  readonly error: string | null;
  readonly window: FlowRunWindow | null;
}

/**
 * `failed`: the native run reported `ok: false` or refused to start;
 * `lane-errors`: the run finished `ok` but some lanes threw, so their outputs are missing.
 */
export type FlowRunVerdict = 'not-run' | 'refused' | 'failed' | 'lane-errors' | 'warnings' | 'passed';

export interface FlowNodeDiagnostic {
  readonly nodeId: string;
  readonly type: string | null;
  readonly status: NodeStatus;
  readonly durationMs: number;
  readonly lanes: number;
  readonly laneErrors: number;
  readonly missing: Readonly<Record<string, readonly string[]>>;
  readonly warnings: readonly string[];
  readonly error?: string;
  readonly errorMessages: readonly string[];
  readonly tracking?: { readonly created: number; readonly updated: number; readonly kept: number; readonly removed: number };
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface FlowRunDiagnostics {
  readonly graphId: string | null;
  readonly verdict: FlowRunVerdict;
  readonly refusal: string | null;
  readonly durationMs: number | null;
  readonly writes: number | null;
  readonly nodes: readonly FlowNodeDiagnostic[];
  /** Log lines that belong to no graph node: orphan cleanup and the tracking store. */
  readonly hostMessages: readonly string[];
  readonly outputs: ReadonlyArray<{ label: string; nodeId: string; port: string; kind: string | null; count: number }>;
  readonly runWarnings: readonly string[];
  readonly artifacts: ReadonlyArray<{ name: string; pages: number; warnings: readonly string[] }>;
}

const MAX_NODES = 100;
const MAX_MESSAGES = 5;
const text = (value: string) => value.slice(0, 600);

/** A node whose own evaluation failed. `skipped` only means an upstream node failed, so it is not a cause. */
export function isFailingNode(node: Pick<FlowNodeDiagnostic, 'status' | 'laneErrors'>): boolean {
  return node.status === 'error' || node.laneErrors > 0;
}

const CREDENTIAL_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@'],
  [/([?&;]|\b)((?:access_|refresh_|id_)?token|api[_-]?key|key|secret|client_secret|password|passwd|pwd|auth|sig|signature)=([^&\s"'#]+)/gi, '$1$2=[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test)[-_][A-Za-z0-9]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
];

/** Redacts credential-like substrings; `{{secret:NAME}}` references carry no secret and stay. */
export function redactCredentialText(text: string): string {
  return CREDENTIAL_TEXT.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactCredentialText(value);
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)]));
}

export function flowRunVerdict(run: RunResult | null, error: string | null): FlowRunVerdict {
  if (!run) return error ? 'refused' : 'not-run';
  if (!run.ok) return 'failed';
  if (run.reports.some(report => report.laneErrors > 0)) return 'lane-errors';
  return run.reports.some(report => report.warnings.length > 0) || run.log.some(entry => entry.level === 'warn') ? 'warnings' : 'passed';
}

/** Failing nodes plus every node feeding them: the nodes whose parameters a debug proposal may see. */
export function failingBranch(doc: Pick<FlowDocument, 'edges'>, run: RunResult | null): Set<string> {
  return withUpstream(doc, (run?.reports ?? []).filter(isFailingNode).map(report => report.nodeId));
}

/** The node's native error log lines, lane-tagged and bounded. */
export function nodeErrorMessages(run: RunResult, nodeId: string): string[] {
  return run.log.filter(entry => entry.nodeId === nodeId && entry.level === 'error')
    .slice(0, MAX_MESSAGES).map(entry => text(redactCredentialText(entry.laneKey === null ? entry.message : `lane ${entry.laneKey}: ${entry.message}`)));
}

/** Parameters a node exposes to the prompt: only on the failing branch, under the policy above. */
export function branchParams(node: FlowDocument['nodes'][number] | undefined, branch: ReadonlySet<string>): Readonly<Record<string, unknown>> | undefined {
  if (!node || !branch.has(node.id) || !node.params) return undefined;
  const defs = flowParamDefs(node.type);
  return Object.fromEntries(Object.entries(node.params).map(([name, value]) => [name,
    defs === null ? '[withheld: node registry not loaded]'
      : defs === undefined ? '[withheld: unknown node type]'
        : defs.find(def => def.name === name)?.kind === 'code' ? '[withheld: script source]'
          : redactValue(value)]));
}

function nodeDiagnostic(report: NodeReport, run: RunResult, doc: FlowDocument, branch: ReadonlySet<string>): FlowNodeDiagnostic {
  const node = doc.nodes.find(candidate => candidate.id === report.nodeId);
  const params = branchParams(node, branch);
  return { nodeId: report.nodeId, type: node?.type ?? null, status: report.status, durationMs: report.durationMs,
    lanes: report.lanes, laneErrors: report.laneErrors, missing: report.missing,
    warnings: report.warnings.slice(0, MAX_MESSAGES).map(text), ...(report.error ? { error: text(report.error) } : {}),
    errorMessages: nodeErrorMessages(run, report.nodeId), ...(report.tracking ? { tracking: report.tracking } : {}),
    ...(params ? { params } : {}) };
}

/** Diagnostics for the open graph's last run, or `null` when no graph is open. */
export function flowRunDiagnostics(state: FlowRunState): FlowRunDiagnostics | null {
  const doc = state.flowLastRunWindow?.doc ?? state.flowDoc;
  if (!doc) return null;
  const run = state.flowLastRun;
  const nodes = new Set(doc.nodes.map(node => node.id));
  const branch = failingBranch(doc, run);
  const window = state.flowLastRunWindow;
  return {
    graphId: doc.id,
    verdict: flowRunVerdict(run, state.flowLastError),
    refusal: state.flowLastError ? text(state.flowLastError) : null,
    durationMs: window ? window.end - window.start : null,
    writes: run?.writes ?? null,
    nodes: run ? run.reports.slice(0, MAX_NODES).map(report => nodeDiagnostic(report, run, doc, branch)) : [],
    hostMessages: (run?.log ?? []).filter(entry => !nodes.has(entry.nodeId) && entry.level !== 'info')
      .slice(0, MAX_MESSAGES * 4).map(entry => text(`${entry.nodeId}: ${entry.message}`)),
    outputs: (run?.graphOutputs ?? []).slice(0, 50).map(output => ({ label: output.label, nodeId: output.nodeId, port: output.port,
      kind: output.data?.kind ?? null, count: output.data ? countItems(output.data) : 0 })),
    runWarnings: state.flowRunWarnings.slice(0, 20).map(text),
    artifacts: state.flowArtifacts.slice(0, 20).map(artifact => ({ name: artifact.name, pages: artifact.pages, warnings: artifact.warnings.slice(0, MAX_MESSAGES).map(text) })),
  };
}
