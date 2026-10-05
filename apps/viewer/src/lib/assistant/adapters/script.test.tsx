/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Script evidence adapter (#6833): a real sandbox run from the Script
 * panel is stamped when published and offered from the panel header; the
 * evidence carries the bounded value, diagnostics and logs with native
 * totals, and never the script source.
 */

import '@/test/setup-dom.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import type { ExtensionHostService } from '@/services/extensions/host.js';
import { useViewerStore } from '@/store';
import type { LogEntry, ScriptResult } from '@/store/slices/scriptSlice';
import type { ScriptDiagnostic } from '@/lib/llm/script-diagnostics';
import { cleanup, click, render, waitFor } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
});
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
  globalThis.fetch = originalFetch;
});

const payloadOf = (snapshot: ReturnType<typeof captureEvidence>) => JSON.parse(snapshot.payload) as {
  totalRows: number; includedRows: number; sampled: boolean; sourceAvailability: string;
  evidence: { summary: Record<string, unknown> & { logCounts: Record<string, number>; script: Record<string, unknown> };
    rows: Array<{ citation: string; data: Record<string, unknown> }> };
};

test('#6833 a real script run is stamped when published, offered from the Script header, and never ships the source', async () => {
  const source = 'const token = "sk-test-DO-NOT-SHARE"; console.log("hello", token.length); console.warn("careful"); 6 * 7';
  useViewerStore.setState({ scriptEditorContent: source, chatPanelVisible: false });
  const root = render(
    <BimReactContext.Provider value={{} as BimContext}>
      <ExtensionHostContext.Provider value={{ emitAction: () => undefined } as unknown as ExtensionHostService}>
        {renderPanelBody('script', () => undefined)}
      </ExtensionHostContext.Provider>
    </BimReactContext.Provider>,
  );
  const run = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Run');
  assert.ok(run, 'Script panel mounted');
  await act(async () => { click(run); });
  await waitFor(() => useViewerStore.getState().scriptLastResult !== null, 'script run published');
  const result = useViewerStore.getState().scriptLastResult;

  const discuss = root.querySelector<HTMLButtonElement>('button[aria-label="Discuss with AI"]');
  assert.ok(discuss, 'the Script header offers Discuss with AI');
  click(discuss);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'script');
  assert.ok(snapshot && result);
  assert.equal(snapshot.reportStamp?.mutationVersion, useViewerStore.getState().mutationVersion, 'the published result is stamped');
  assert.doesNotMatch(snapshot.payload, /sk-test-DO-NOT-SHARE/, 'the script source is not evidence');
  const payload = payloadOf(snapshot);
  assert.equal(payload.evidence.summary.durationMs, result.durationMs);
  assert.equal((payload.evidence.summary.script as { editorSourceLength: number }).editorSourceLength, source.length);
  assert.deepEqual(payload.evidence.rows[0].data, { kind: 'returnValue', valueType: 'number', value: 42, valueTruncated: false });
  assert.deepEqual(payload.evidence.rows.filter(row => row.data.kind === 'log').map(row => [row.data.status, row.data.message]),
    [['log', 'hello 20'], ['warn', 'careful']]);
  assert.equal(payload.evidence.summary.logCounts.warn, 1);
  assert.equal(evidenceIsCurrent(snapshot), true);
  act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
  assert.equal(evidenceIsCurrent(snapshot), false, 'a later model edit makes the run evidence stale');
});

const log = (i: number): LogEntry => ({ level: (['log', 'info', 'warn', 'error'] as const)[i % 4], args: [`line ${i}`, { i }], timestamp: 1_700_000_000_000 + i });
const diagnostic: ScriptDiagnostic = { source: 'runtime', code: 'generic_placement_contract', severity: 'error', message: 'Placement must be a 3D point',
  rootCauseKey: 'placement', repairScope: 'local', evidence: [{ line: 3, column: 7, snippet: 'const apiKey = "sk-snippet-secret"' }] };

test('#6833 script evidence keeps native log totals over a sample, bounds the value and omits diagnostic snippets', () => {
  const result: ScriptResult = stampAnalysisReport({ value: { rows: Array.from({ length: 500 }, (_, i) => ({ i, name: 'x'.repeat(50) })) },
    logs: Array.from({ length: 150 }, (_, i) => log(i)), durationMs: 12 }, captureAnalysisStamp());
  useViewerStore.setState({ scriptLastResult: result, scriptLastDiagnostics: [diagnostic], scriptRunSeq: 3 });
  const snapshot = captureEvidence('script');
  const payload = payloadOf(snapshot);
  assert.equal(payload.totalRows, 1 + 1 + 150);
  assert.ok(payload.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.deepEqual(payload.evidence.summary.logCounts, { log: 38, info: 38, warn: 37, error: 37 });
  assert.equal(payload.evidence.summary.successfulRunCount, 3);
  assert.equal(payload.evidence.rows[0].data.valueTruncated, true, 'a large return value is a bounded projection');
  assert.deepEqual(payload.evidence.rows[1].data, { kind: 'diagnostic', status: 'error', source: 'runtime', code: 'generic_placement_contract',
    message: 'Placement must be a 3D point', repairScope: 'local', line: 3, column: 7 });
  assert.doesNotMatch(snapshot.payload, /sk-snippet-secret/);
  assert.equal(payload.evidence.rows[2].data.message, 'line 0 {"i":0}');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.setState({ scriptLastResult: { ...result } });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a replaced result makes the earlier evidence stale');
});

test('#6833 script evidence is unavailable without a run, available for a failed run, and stale when produced before an edit', () => {
  assert.equal(payloadOf(captureEvidence('script')).sourceAvailability, 'unavailable');

  useViewerStore.setState({ scriptLastError: 'ReferenceError: foo is not defined', scriptLastDiagnostics: [diagnostic] });
  const failed = payloadOf(captureEvidence('script'));
  assert.equal(failed.sourceAvailability, 'available');
  assert.equal(failed.evidence.summary.error, 'ReferenceError: foo is not defined');
  assert.equal(failed.evidence.summary.resultAvailable, false);
  assert.deepEqual(failed.evidence.rows.map(row => row.data.kind), ['diagnostic']);

  useViewerStore.setState({ scriptLastError: null, scriptLastDiagnostics: [],
    scriptLastResult: stampAnalysisReport({ value: null, logs: [], durationMs: 1 }, captureAnalysisStamp()) });
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(captureEvidence('script')), false);
});
