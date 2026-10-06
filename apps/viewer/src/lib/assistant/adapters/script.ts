/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Script panel's last run (#6833). Native owner: `scriptLastResult`
 * (value, logs, duration; stamped by `useSandbox` when it is published),
 * `scriptLastError` and `scriptLastDiagnostics`. The script source text is
 * never evidence: it may hold keys or tokens, so only its name and length
 * travel.
 */

import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import type { ViewerState } from '@/store';
import type { LogEntry, ScriptResult } from '@/store/slices/scriptSlice';
import type { ScriptDiagnostic } from '@/lib/llm/script-diagnostics';
import { evidenceJson } from '../projection';
import { evidenceRow, take, unavailableCapture, type EvidenceAdapter } from './types';

const TEXT = 500;
const LOG_LEVELS = ['log', 'info', 'warn', 'error'] as const;

const bounded = (text: string, limit = TEXT): string => text.length > limit ? `${text.slice(0, limit)}…` : text;

function argText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg === undefined) return 'undefined';
  return evidenceJson(arg).text;
}

function valueRow(result: ScriptResult) {
  const { value } = result;
  const projection = value === undefined ? null : evidenceJson(value);
  return evidenceRow({ kind: 'returnValue' }, {
    valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    value: projection ? JSON.parse(projection.text) as unknown : null,
    valueTruncated: projection?.truncated ?? false,
  });
}

function diagnosticRow(diagnostic: ScriptDiagnostic) {
  const located = diagnostic.evidence?.find(item => item.line !== undefined);
  // `evidence[].snippet` quotes the source text; only positions travel.
  return evidenceRow({ kind: 'diagnostic', status: diagnostic.severity }, {
    source: diagnostic.source, code: diagnostic.code, message: bounded(diagnostic.message),
    repairScope: diagnostic.repairScope, line: located?.line ?? null, column: located?.column ?? null,
  });
}

function logRow(entry: LogEntry, index: number) {
  return evidenceRow({ kind: 'log', status: entry.level }, {
    index, timestamp: new Date(entry.timestamp).toISOString(),
    message: bounded(entry.args.slice(0, 8).map(argText).join(' ')),
  });
}

function* scriptRows(s: ViewerState) {
  const result = s.scriptLastResult;
  if (result) yield valueRow(result);
  for (const diagnostic of s.scriptLastDiagnostics) yield diagnosticRow(diagnostic);
  let index = 0;
  for (const entry of result?.logs ?? []) yield logRow(entry, index++);
}

const hasRun = (s: ViewerState): boolean =>
  s.scriptLastResult !== null || s.scriptLastError !== null || s.scriptLastDiagnostics.length > 0;

export const scriptAdapter: EvidenceAdapter = {
  id: 'script', group: 'automation', panelIds: ['script'],
  titleKey: 'scriptPanel.header.defaultTitle', descriptionKey: 'assistantSources.script.description',
  rowMeaningKey: 'assistantSources.script.rows', unavailableKey: 'assistantSources.script.unavailable',
  suggestionKeys: ['assistantSources.script.suggestExplain', 'assistantSources.script.suggestFix'],
  readiness: s => {
    if (s.scriptExecutionState === 'running') return { status: { labelKey: 'assistantSources.script.statusRunning' }, ready: false, running: true };
    if (s.scriptLastError !== null) return { status: { labelKey: 'assistantSources.script.statusError' }, ready: true };
    if (s.scriptLastResult) {
      return { status: { labelKey: 'assistantSources.script.statusResult', params: { count: s.scriptLastResult.logs.length } }, ready: true };
    }
    if (s.scriptLastDiagnostics.length > 0) {
      return { status: { labelKey: 'assistantSources.script.statusDiagnostics', params: { count: s.scriptLastDiagnostics.length } }, ready: true };
    }
    return { status: { labelKey: 'assistantSources.script.statusNone' }, ready: false };
  },
  identity: s => [s.scriptLastResult, s.scriptLastError, s.scriptLastDiagnostics],
  reportStamp: s => analysisStampOf(s.scriptLastResult),
  capture: (s, limit) => {
    if (!hasRun(s)) return unavailableCapture();
    const result = s.scriptLastResult;
    const logCounts = Object.fromEntries(LOG_LEVELS.map(level => [level, 0])) as Record<LogEntry['level'], number>;
    for (const entry of result?.logs ?? []) logCounts[entry.level] += 1;
    const diagnostics = s.scriptLastDiagnostics;
    const saved = s.activeScriptId ? s.savedScripts.find(script => script.id === s.activeScriptId) : undefined;
    return {
      summary: {
        kind: 'script-run',
        script: { id: s.activeScriptId, name: saved?.name ?? null, saved: saved !== undefined,
          editorSourceLength: s.scriptEditorContent.length, editorUnsavedChanges: s.scriptEditorDirty },
        state: s.scriptExecutionState,
        successfulRunCount: s.scriptRunSeq,
        durationMs: result?.durationMs ?? null,
        units: { durationMs: 'ms', editorSourceLength: 'characters' },
        resultAvailable: result !== null,
        error: s.scriptLastError === null ? null : bounded(s.scriptLastError, 2000),
        diagnosticCount: diagnostics.length,
        diagnosticSeverityCounts: { error: diagnostics.filter(d => d.severity === 'error').length,
          warning: diagnostics.filter(d => d.severity === 'warning').length },
        logCount: result?.logs.length ?? 0,
        logCounts,
        rowOrder: 'returnValue, diagnostic, log',
        limitations: 'The script source text is excluded (it may contain keys); only its name and editor length are given, and the code that ran may '
          + 'differ from the editor (it can have been edited since, or run from a chat code block). The return value and log messages are bounded '
          + 'projections; non-plain objects are omitted. Diagnostic source snippets are excluded. '
          + (result ? '' : 'No run result was recorded, so missing log or value rows do not mean the script produced none. ')
          + 'A run says nothing about model edits made after it finished.',
      },
      rows: take(scriptRows(s), limit),
      totalRows: (result ? 1 : 0) + diagnostics.length + (result?.logs.length ?? 0),
      availability: 'available',
    };
  },
};
