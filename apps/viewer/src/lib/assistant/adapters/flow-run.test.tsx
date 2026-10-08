/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Flow run evidence adapter (#6833): a real run through the Flow panel
 * stamps its record after its own writes, the run bar offers the run as a
 * second source beside the graph, and the captured evidence keeps native
 * totals, excludes artifact bytes and goes stale on replacement or edits.
 */

import '@/test/setup-dom.js';
import test, { afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { NodeReport, RunResult } from '@ifc-lite/flow';
import { newFlowDocument } from '@/lib/flow/persistence';
import { addNode } from '@/lib/flow/editor-ops';
import { flowRegistry } from '@/lib/flow/runner';
import type { WorkflowArtifact } from '@/lib/flow/artifact';
import { blankDocument } from '@/lib/document/presets';
import { BimProvider } from '@/sdk/BimProvider';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { panelSource } from './registry';

const MODEL_ID = 'model-1';
const NODE_TYPE = 'test.flowRunEvidence6833';
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('flow-run-evidence.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('1wall00000000000000000',$,'W1',$,$,#41,$,$,.SOLIDWALL.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
`;

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

before(() => {
  flowRegistry().register({
    type: NODE_TYPE, title: 'Evidence write', category: 'test', inputs: [], outputs: [], params: [],
    capabilities: [], writes: 'model', volatile: true,
    run: (ctx) => {
      ctx.host.bim.mutate.setProperty({ modelId: MODEL_ID, expressId: 50 }, 'Pset_WallCommon', 'FireRating', 'EI60');
      ctx.log('warn', 'fire rating defaulted');
      return {};
    },
  });
});

const payloadOf = (snapshot: ReturnType<typeof captureEvidence>) => JSON.parse(snapshot.payload) as {
  totalRows: number; includedRows: number; sampled: boolean; sourceAvailability: string;
  evidence: { summary: Record<string, unknown> & { nodeStatusCounts: Record<string, number> }; rows: Array<{ citation: string; data: Record<string, unknown> }> };
};

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

test('#6833 a real Flow run is offered from the run bar, stamped after its own writes, and stale after an edit', async () => {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(FIXTURE).buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model), editEnabled: true,
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(dataStore.properties || null, MODEL_ID)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), mutationVersion: 0,
  });
  useViewerStore.getState().importFlow(addNode(newFlowDocument('Evidence graph'), NODE_TYPE, [0, 0]).doc);
  const root = render(<BimProvider>{renderPanelBody('flow', () => undefined)}</BimProvider>);
  await waitFor(() => [...root.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Run'), 'Flow panel mounted');
  assert.equal(buttonByLabel(root, 'Discuss run with AI'), null, 'no run yet, no run action');

  await act(async () => {
    click([...root.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Run')!);
  });
  await waitFor(() => !useViewerStore.getState().flowRunning && useViewerStore.getState().flowLastRun !== null, 'run finished');
  const state = useViewerStore.getState();
  assert.ok(state.mutationVersion > 0, 'the run wrote to the model');

  const discussRun = buttonByLabel(root, 'Discuss run with AI');
  assert.ok(discussRun, 'the run bar offers the run');
  click(discussRun);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'flowRun');
  assert.ok(snapshot);
  assert.equal(snapshot.reportStamp?.mutationVersion, state.mutationVersion, 'stamped after the run\'s own writes');
  assert.equal(evidenceIsCurrent(snapshot), true);
  const payload = payloadOf(snapshot);
  assert.equal(payload.evidence.summary.status, 'ok');
  assert.equal(payload.evidence.summary.writes, 1);
  assert.equal((payload.evidence.summary.graph as { name: string }).name, 'Evidence graph');
  const node = payload.evidence.rows.find(row => row.data.kind === 'nodeResult');
  assert.equal(node?.data.status, 'ok');
  assert.equal(node?.data.nodeType, NODE_TYPE);
  const log = payload.evidence.rows.find(row => row.data.kind === 'log');
  assert.deepEqual([log?.data.status, log?.data.message], ['warn', 'fire rating defaulted']);
  assert.equal(payload.totalRows, payload.includedRows);

  // The graph structure stays the panel's default subject.
  click(buttonByLabel(root, 'Discuss with AI')!);
  assert.equal(useAssistant.getState().snapshot?.source, 'flow');

  act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
  assert.equal(evidenceIsCurrent(snapshot), false, 'a later model edit makes the run evidence stale');
});

function report(i: number): NodeReport {
  return { nodeId: `n${i}`, status: i % 10 === 0 ? 'error' : i % 7 === 0 ? 'skipped' : 'ok', durationMs: i, lanes: 1,
    laneErrors: i % 10 === 0 ? 1 : 0, missing: {}, warnings: i % 3 === 0 ? [`warn ${i}`] : [],
    ...(i % 10 === 0 ? { error: `boom ${i}` } : {}) };
}

function seededRun(count: number): RunResult {
  const reports = Array.from({ length: count }, (_, i) => report(i));
  return { ok: false, writes: 0, outputs: new Map(), reports, review: [],
    graphOutputs: [{ label: 'Count', nodeId: 'n1', port: 'out', data: { kind: 'list', items: Array.from({ length: 40 }, (_, i) => i) } }],
    log: [{ nodeId: 'n0', laneKey: null, level: 'error', message: 'x'.repeat(5000) }] };
}

test('#6833 Flow run evidence keeps native totals over a 100-row sample and never carries artifact bytes', () => {
  const doc = newFlowDocument('Seeded');
  const run = seededRun(130);
  const runWindow = stampAnalysisReport({ start: 1_000, end: 3_500, doc, mutationIds: new Set<string>() }, captureAnalysisStamp());
  // A PDF artifact lives only while the native document revision it printed exists (`artifact-lifetime.ts`).
  const printed = blankDocument();
  const artifact: WorkflowArtifact = { id: 'a1', name: 'report.pdf', blob: new Blob(['%PDF-secret-bytes'], { type: 'application/pdf' }),
    pages: 2, warnings: [], documentId: printed.id, documentSignature: JSON.stringify(printed) };
  useViewerStore.setState({ flowDoc: doc, documents: [printed] });
  useViewerStore.setState({ flowLastRun: run, flowLastRunWindow: runWindow, flowRunWarnings: ['slow input'], flowArtifacts: [artifact] });

  assert.equal(panelSource('flow', useViewerStore.getState()), 'flow', 'flowRun is never the Flow panel\'s default subject');
  const snapshot = captureEvidence('flowRun');
  const payload = payloadOf(snapshot);
  assert.equal(payload.totalRows, 130 + 1 + 1 + 1 + 1);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.nodeReports, 130);
  assert.equal(payload.evidence.summary.status, 'failed');
  assert.equal(payload.evidence.summary.durationMs, 2500);
  assert.equal(payload.evidence.summary.startedAt, new Date(1_000).toISOString());
  assert.equal(payload.evidence.summary.nodeStatusCounts.error, 13);
  assert.equal(payload.evidence.summary.artifactCount, 1);
  // Independent of the adapter: the fixture skips i % 7 === 0 unless i % 10 === 0 over 0..129 (17 nodes).
  assert.equal(payload.evidence.summary.nodeStatusCounts.skipped, 17);
  assert.equal(payload.evidence.summary.executedNodes, 113);
  // #6919: failing node results come first (13 errors), then run-level rows, then the other node results.
  assert.deepEqual(payload.evidence.rows.slice(0, 13).map(row => [row.data.nodeId, row.data.error]),
    Array.from({ length: 13 }, (_, i) => [`n${i * 10}`, `boom ${i * 10}`]));
  assert.deepEqual(payload.evidence.rows.slice(13, 16).map(row => row.data.kind), ['warning', 'artifact', 'graphOutput']);
  assert.ok(payload.evidence.rows.slice(16).every(row => row.data.kind === 'nodeResult'));
  assert.doesNotMatch(snapshot.payload, /PDF-secret-bytes/);
  assert.equal(evidenceIsCurrent(snapshot), true);

  // Fewer node reports: every kind is included, artifacts as metadata only.
  useViewerStore.setState({ flowLastRun: seededRun(3) });
  const small = payloadOf(captureEvidence('flowRun'));
  assert.equal(evidenceIsCurrent(snapshot), false, 'replacing the run makes the earlier evidence stale');
  assert.deepEqual(small.evidence.rows.map(row => [row.data.kind, row.data.nodeId ?? null]),
    [['nodeResult', 'n0'], ['warning', null], ['artifact', null], ['graphOutput', 'n1'], ['nodeResult', 'n1'], ['nodeResult', 'n2'], ['log', 'n0']]);
  const artifactRow = small.evidence.rows[2].data;
  assert.deepEqual([artifactRow.name, artifactRow.mediaType, artifactRow.sizeBytes, artifactRow.pages], ['report.pdf', 'application/pdf', 17, 2]);
  const output = small.evidence.rows[3].data;
  assert.deepEqual([output.itemCount, (output.preview as unknown[]).length], [40, 5]);
  assert.ok((small.evidence.rows[6].data.message as string).length <= 501, 'log text is bounded');
});

test('#6833 Flow run evidence is unavailable without a run, available for a failed run, and stale when produced before an edit', () => {
  assert.equal(payloadOf(captureEvidence('flowRun')).sourceAvailability, 'unavailable');

  useViewerStore.setState({ flowDoc: newFlowDocument('Failing'), flowLastError: 'Preflight: missing input file' });
  const failed = payloadOf(captureEvidence('flowRun'));
  assert.equal(failed.sourceAvailability, 'available');
  assert.equal(failed.totalRows, 0);
  assert.equal(failed.evidence.summary.status, 'error');
  assert.equal(failed.evidence.summary.error, 'Preflight: missing input file');

  // A run recorded before an edit and captured after it is not current.
  const runWindow = stampAnalysisReport({ start: 0, end: 1, doc: newFlowDocument('Old'), mutationIds: new Set<string>() }, captureAnalysisStamp());
  useViewerStore.setState({ flowLastError: null, flowLastRun: seededRun(2), flowLastRunWindow: runWindow });
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(captureEvidence('flowRun')), false);
});
