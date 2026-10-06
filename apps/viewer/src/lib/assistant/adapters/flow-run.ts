/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Flow panel's last run (#6833), beside the graph-structure `flow`
 * source. Native owner: `flowLastRun` (`RunResult`), `flowLastError`,
 * `flowLastRunWindow` (the document AS RUN, stamped by `useFlowRunner`),
 * `flowRunWarnings` and `flowArtifacts`. Editing or switching the graph
 * clears all of them (`setFlowDoc`, `openFlow`, …), so a present run always
 * belongs to the graph it names. Artifact bytes are never evidence.
 */

import { countItems, type FlowData, type FlowDocument, type GraphOutputValue, type NodeReport, type RunLogEntry } from '@ifc-lite/flow';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import type { ViewerState } from '@/store';
import type { WorkflowArtifact } from '@/lib/flow/artifact';
import { evidenceRow, take, unavailableCapture, type EvidenceAdapter } from './types';

const TEXT = 500;
const PREVIEW_ITEMS = 5;
const NODE_STATUSES = ['ok', 'memo', 'noop', 'skipped', 'error'] as const;

const bounded = (text: string, limit = TEXT): string => text.length > limit ? `${text.slice(0, limit)}…` : text;

function previewItems(data: FlowData): unknown[] {
  if (data.kind === 'item') return [data.value];
  if (data.kind === 'list') return data.items.slice(0, PREVIEW_ITEMS);
  const out: unknown[] = [];
  for (const items of data.branches.values()) {
    for (const value of items) {
      if (out.length >= PREVIEW_ITEMS) return out;
      out.push(value);
    }
  }
  return out;
}

function nodeRow(report: NodeReport, doc: FlowDocument | null) {
  const node = doc?.nodes.find(candidate => candidate.id === report.nodeId);
  return evidenceRow({ kind: 'nodeResult', status: report.status, unit: 'ms' }, {
    nodeId: report.nodeId, nodeType: node?.type ?? null, nodeLabel: node?.label ?? null,
    durationMs: report.durationMs, lanes: report.lanes, laneErrors: report.laneErrors,
    missingInputs: Object.keys(report.missing),
    warningCount: report.warnings.length, warnings: report.warnings.slice(0, 5).map(warning => bounded(warning)),
    error: report.error === undefined ? null : bounded(report.error),
    tracking: report.tracking ?? null,
  });
}

function artifactRow(artifact: WorkflowArtifact) {
  return evidenceRow({ kind: 'artifact' }, {
    artifactId: artifact.id, name: artifact.name, mediaType: artifact.blob.type || null, sizeBytes: artifact.blob.size,
    pages: artifact.pages, documentId: artifact.documentId,
    warningCount: artifact.warnings.length, warnings: artifact.warnings.slice(0, 5).map(warning => bounded(warning)),
  });
}

function outputRow(output: GraphOutputValue) {
  return evidenceRow({ kind: 'graphOutput' }, {
    label: output.label, nodeId: output.nodeId, port: output.port,
    dataKind: output.data?.kind ?? null, itemCount: output.data ? countItems(output.data) : null,
    // A bounded value preview; the row projection bounds strings and nested objects further.
    preview: output.data ? previewItems(output.data) : null,
  });
}

function logRow(entry: RunLogEntry) {
  return evidenceRow({ kind: 'log', status: entry.level }, { nodeId: entry.nodeId, laneKey: entry.laneKey, message: bounded(entry.message) });
}

function* runRows(s: ViewerState, doc: FlowDocument | null) {
  const run = s.flowLastRun;
  for (const report of run?.reports ?? []) yield nodeRow(report, doc);
  for (const message of s.flowRunWarnings) yield evidenceRow({ kind: 'warning', status: 'warning' }, { source: 'run', message: bounded(message) });
  for (const artifact of s.flowArtifacts) yield artifactRow(artifact);
  for (const output of run?.graphOutputs ?? []) yield outputRow(output);
  for (const entry of run?.log ?? []) yield logRow(entry);
}

const iso = (time: number | undefined): string | null => time === undefined ? null : new Date(time).toISOString();

export const flowRunAdapter: EvidenceAdapter = {
  id: 'flowRun', group: 'automation', panelIds: ['flow'],
  // The graph structure (`flow`) stays the panel's default subject; the run bar offers this one explicitly.
  panelSubject: () => false,
  titleKey: 'assistantSources.flowRun.title', descriptionKey: 'assistantSources.flowRun.description',
  rowMeaningKey: 'assistantSources.flowRun.rows', unavailableKey: 'assistantSources.flowRun.unavailable',
  suggestionKeys: ['assistantSources.flowRun.suggestExplain', 'assistantSources.flowRun.suggestFix'],
  readiness: s => {
    if (s.flowRunning) return { status: { labelKey: 'assistantSources.flowRun.statusRunning' }, ready: false, running: true };
    if (s.flowLastRun) {
      return { status: { labelKey: s.flowLastRun.ok ? 'assistantSources.flowRun.statusOk' : 'assistantSources.flowRun.statusFailed',
        params: { count: s.flowLastRun.reports.length } }, ready: true };
    }
    if (s.flowLastError !== null) return { status: { labelKey: 'assistantSources.flowRun.statusError' }, ready: true };
    return { status: { labelKey: 'assistantSources.flowRun.statusNone' }, ready: false };
  },
  identity: s => [s.flowLastRun, s.flowLastError, s.flowLastRunWindow, s.flowRunWarnings, s.flowArtifacts, s.flowDoc],
  reportStamp: s => analysisStampOf(s.flowLastRunWindow),
  capture: (s, limit) => {
    const run = s.flowLastRun;
    if (!run && s.flowLastError === null) return unavailableCapture();
    const runWindow = s.flowLastRunWindow;
    const doc = runWindow?.doc ?? s.flowDoc;
    const reports = run?.reports ?? [];
    const statusCounts = Object.fromEntries(NODE_STATUSES.map(status => [status, 0])) as Record<NodeReport['status'], number>;
    for (const report of reports) statusCounts[report.status] += 1;
    const logCounts = { info: 0, warn: 0, error: 0 };
    for (const entry of run?.log ?? []) logCounts[entry.level] += 1;
    const totalRows = reports.length + s.flowRunWarnings.length + s.flowArtifacts.length
      + (run?.graphOutputs.length ?? 0) + (run?.log.length ?? 0);
    return {
      summary: {
        kind: 'flow-run',
        graph: doc ? { id: doc.id, name: doc.name, nodeCount: doc.nodes.length, edgeCount: doc.edges.length,
          identity: runWindow ? 'document as run' : 'open working copy (the run window was not recorded)' } : null,
        status: run ? (run.ok ? 'ok' : 'failed') : 'error',
        error: s.flowLastError === null ? null : bounded(s.flowLastError, 2000),
        startedAt: iso(runWindow?.start), finishedAt: iso(runWindow?.end),
        durationMs: runWindow ? runWindow.end - runWindow.start : null,
        units: { durationMs: 'ms', sizeBytes: 'bytes' },
        nodeReports: reports.length,
        executedNodes: reports.length - statusCounts.skipped,
        nodeStatusCounts: statusCounts,
        nodeWarnings: reports.reduce((sum, report) => sum + report.warnings.length, 0),
        writes: run?.writes ?? null,
        pendingMutationsFromRun: runWindow ? runWindow.mutationIds.size : null,
        runWarningCount: s.flowRunWarnings.length,
        artifactCount: s.flowArtifacts.length,
        graphOutputCount: run?.graphOutputs.length ?? 0,
        logCounts,
        rowOrder: 'nodeResult, warning, artifact, graphOutput, log',
        limitations: 'Describes the last run of the open graph only. Editing or switching the graph clears the run, so it belongs to the graph named here. '
          + 'executedNodes counts every node report that was not skipped; memo means cached outputs were reused. '
          + 'Node parameters, full output values and artifact contents (PDF bytes) are excluded; graph outputs carry at most a short preview. '
          + (run ? '' : 'The run failed before a result existed, so no node reports are available; absence of node rows is not success. ')
          + 'A run says nothing about model edits made after it finished.',
      },
      rows: take(runRows(s, doc), limit),
      totalRows,
      availability: 'available',
    };
  },
};
