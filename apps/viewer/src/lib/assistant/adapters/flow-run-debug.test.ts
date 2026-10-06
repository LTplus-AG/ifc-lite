/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Debug evidence of the `flowRun` adapter (#6919): the failing nodes of a
 * large run survive the 48k text budget, and parameters reach the prompt only
 * for the failing branch, without script source or credential-like strings.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowDocument, NodeReport, RunLogEntry, RunResult } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { newFlowDocument } from '@/lib/flow/persistence';
import { flowRegistry } from '@/lib/flow/runner';
import { captureEvidence } from '../evidence';
import { isFailingNode } from '../flow-run-evidence';

// Publishes the native parameter declarations, as the Flow panel's Run does.
flowRegistry();
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

type Row = { citation: string; data: Record<string, unknown> & { kind: string; nodeId?: string; params?: Record<string, unknown> } };
const capture = () => {
  const snapshot = captureEvidence('flowRun');
  const payload = JSON.parse(snapshot.payload) as { totalRows: number; includedRows: number;
    evidence: { summary: { failingNodeIds: string[]; nodeStatusCounts: Record<string, number> }; rows: Row[] } };
  return { text: snapshot.payload, ...payload };
};
const report = (nodeId: string, extra: Partial<NodeReport> = {}): NodeReport =>
  ({ nodeId, status: 'ok', durationMs: 1, lanes: 1, laneErrors: 0, missing: {}, warnings: [], ...extra });
const record = (doc: FlowDocument, reports: NodeReport[], log: RunLogEntry[] = []) => {
  const run: RunResult = { ok: !reports.some(r => r.status === 'error' || r.status === 'skipped'), writes: 0, outputs: new Map(), graphOutputs: [], reports, log };
  useViewerStore.setState({ flowDoc: doc, flowLastRun: run, flowLastError: null, flowLastRunWindow: null, flowRunWarnings: [], flowArtifacts: [] });
};

test('#6919 a failing node at the end of a 100-node run is not cut by the evidence budget', () => {
  // A chain n0 → … → n99 in run order: 97 healthy nodes with verbose warnings, n97 fails, n98/n99 are skipped.
  const doc: FlowDocument = { ...newFlowDocument('Long chain'),
    nodes: Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, type: 'core.math', params: { op: 'add', note: `node ${i}` } })),
    edges: Array.from({ length: 99 }, (_, i) => ({ from: [`n${i}`, 'result'], to: [`n${i + 1}`, 'a'] })) };
  const verbose = Array.from({ length: 5 }, (_, w) => `${w} ${'w'.repeat(600)}`);
  const reports = Array.from({ length: 100 }, (_, i) => i < 97 ? report(`n${i}`, { warnings: verbose })
    : i === 97 ? report('n97', { status: 'error', lanes: 0, error: '"a" must be a finite number' })
      : report(`n${i}`, { status: 'skipped', lanes: 0, error: 'an upstream node failed' }));
  const log = Array.from({ length: 9 }, (_, i): RunLogEntry => ({ nodeId: 'n97', laneKey: `${i}`, level: 'error', message: `lane failure ${i} ${'e'.repeat(900)}` }));
  record(doc, reports, log);

  const { evidence, totalRows, includedRows, text } = capture();
  assert.ok(text.length < 60_000, 'the payload stays bounded');
  assert.ok(includedRows < totalRows, 'the budget did cut rows');
  assert.equal(evidence.summary.nodeStatusCounts.ok, 97, 'healthy nodes are still counted natively');
  const failing = evidence.rows.find(row => row.data.nodeId === 'n97');
  assert.ok(failing, 'the failing node survives the budget');
  assert.equal(evidence.rows[0], failing, 'failing nodes come first');
  assert.equal(failing.data.error, '"a" must be a finite number');
  assert.equal((failing.data.errorMessages as string[]).length, 5);
  assert.deepEqual(failing.data.inputs, [{ port: 'a', from: ['n96', 'result'] }]);
  assert.equal(evidence.rows[1].data.nodeId, 'n96', 'its direct input follows it');
  assert.deepEqual(evidence.rows[1].data.params, { op: 'add', note: 'node 96' });
});

test('#6919 parameters reach the prompt only for the failing branch, without script source or credentials', () => {
  const code = 'const apiKey = "sk-live-0123456789abcdefABCDEF";\nJSON.parse(inputs.a).items';
  const doc: FlowDocument = { ...newFlowDocument('Fetch and parse'),
    nodes: [
      { id: 'req', type: 'http.request', params: { method: 'GET',
        url: 'https://deploy:hunter2@api.example.com/v1/items?access_token=SECRET123&page=1',
        headers: { Authorization: 'Bearer abc.def.ghi', 'X-Trace': 'Bearer TOPSECRETVALUE1234', Accept: 'application/json' } } },
      { id: 'parse', type: 'script.run', params: { code, timeoutMs: 1000 } },
      { id: 'other', type: 'core.number', params: { value: 'UNRELATED-PARAM' } },
      { id: 'join', type: 'core.math', params: { op: 'add' } },
    ],
    edges: [{ from: ['req', 'body'], to: ['parse', 'a'] }, { from: ['parse', 'result'], to: ['join', 'a'] }, { from: ['other', 'value'], to: ['join', 'b'] }] };
  record(doc, [report('req'), report('other'), report('parse', { laneErrors: 1 }),
    report('join', { status: 'skipped', lanes: 0, error: 'an upstream node failed' })],
  [{ nodeId: 'parse', laneKey: '0', level: 'error', message: 'Unexpected token < in JSON' }]);

  const { evidence, text } = capture();
  assert.deepEqual(evidence.summary.failingNodeIds, ['parse'], 'a skipped node is a consequence, not a failure');
  assert.equal(isFailingNode({ status: 'skipped', laneErrors: 0 }), false);
  for (const leaked of ['hunter2', 'SECRET123', 'TOPSECRETVALUE1234', 'abc.def.ghi', 'sk-live', 'apiKey', 'UNRELATED-PARAM']) {
    assert.ok(!text.includes(leaked), `${leaked} stays out of the prompt`);
  }
  const params = (id: string) => evidence.rows.find(row => row.data.nodeId === id)?.data.params;
  assert.deepEqual(params('parse'), { code: '[withheld: script source]', timeoutMs: 1000 });
  const request = params('req')!;
  assert.match(request.url as string, /^https:\/\/\[redacted\]@api\.example\.com\/v1\/items\?access_token=\[redacted\]&page=1$/);
  assert.deepEqual(request.headers, { Authorization: '[omitted: credential]', 'X-Trace': 'Bearer [redacted]', Accept: 'application/json' });
  assert.equal(params('other'), undefined, 'a branch feeding only the skipped node stays out');
  assert.equal(params('join'), undefined);

  // A passing run exposes no parameters at all.
  record(doc, doc.nodes.map(node => report(node.id)));
  assert.ok(capture().evidence.rows.every(row => row.data.params === undefined));
});
