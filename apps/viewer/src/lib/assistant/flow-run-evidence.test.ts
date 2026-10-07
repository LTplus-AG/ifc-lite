/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlowDocument, NodeReport, RunLogEntry, RunResult } from '@ifc-lite/flow';
import { newFlowDocument } from '../flow/persistence';
import type { ViewerState } from '@/store';
import { flowRunDiagnostics, flowRunVerdict, isFailingNode } from './flow-run-evidence';
import { flowRunAdapter, pinnedFlowRun } from './adapters/flow-run';
import { sameIdentity } from './adapters/types';
import { flowRegistry } from '../flow/runner';

// Invariants (#6919): the verdict is read from the native run only; parameters reach
// the prompt only for failing nodes and the nodes feeding them; messages are bounded.
const doc: FlowDocument = {
  ...newFlowDocument('Graph'), outputs: [{ nodeId: 'sum', port: 'result', label: 'Total' }],
  nodes: [
    { id: 'a', type: 'core.number', params: { value: 'secret-ish' } },
    { id: 'b', type: 'core.number', params: { value: 2 } },
    { id: 'sum', type: 'core.math', params: { op: 'add' } },
    { id: 'other', type: 'core.number', params: { value: 99 } },
  ],
  edges: [{ from: ['a', 'value'], to: ['sum', 'a'] }, { from: ['b', 'value'], to: ['sum', 'b'] }],
};
const report = (nodeId: string, extra: Partial<NodeReport> = {}): NodeReport =>
  ({ nodeId, status: 'ok', durationMs: 1, lanes: 1, laneErrors: 0, missing: {}, warnings: [], ...extra });
const run = (reports: NodeReport[], log: RunLogEntry[] = [], ok = true): RunResult =>
  ({ ok, writes: 0, outputs: new Map(), graphOutputs: [], reports, log });
const state = (flowLastRun: RunResult | null, flowLastError: string | null = null) => ({
  flowDoc: doc, flowLastRun, flowLastError, flowLastRunWindow: null, flowRunWarnings: [], flowArtifacts: [],
});
const healthy = [report('a'), report('b'), report('sum'), report('other')];

// Runs first, before any registry exists in this process: unknown parameter kinds are never sent.
test('#6919 without a loaded node registry every failing-branch parameter is withheld', () => {
  const failing = run([report('a'), report('b'), report('sum', { status: 'error', error: 'boom' })], [], false);
  const params = flowRunDiagnostics(state(failing))!.nodes.find(node => node.nodeId === 'a')!.params;
  assert.deepEqual(params, { value: '[withheld: node registry not loaded]' });
  flowRegistry();
  assert.deepEqual(flowRunDiagnostics(state(failing))!.nodes.find(node => node.nodeId === 'a')!.params, { value: 'secret-ish' });
});

test('#6919 run verdicts come from the native run record', () => {
  assert.equal(flowRunDiagnostics({ ...state(null), flowDoc: null }), null, 'no graph, no diagnostics');
  assert.equal(flowRunDiagnostics(state(null))!.verdict, 'not-run');
  const refused = flowRunDiagnostics(state(null, 'capability denied: model.read'))!;
  assert.deepEqual([refused.verdict, refused.refusal], ['refused', 'capability denied: model.read']);
  // `useFlowRunner` records a run window once the run started: a throw after that is a failed run, not a refusal.
  const window = { start: 1, end: 2, doc, mutationIds: new Set<string>() };
  assert.equal(flowRunDiagnostics({ ...state(null, 'sandbox crashed'), flowLastRunWindow: window })!.verdict, 'failed');
  assert.equal(flowRunDiagnostics(state(run(healthy)))!.verdict, 'passed');
  assert.equal(flowRunDiagnostics(state(run(healthy, [{ nodeId: 'b', laneKey: null, level: 'warn', message: 'rounded' }])))!.verdict, 'warnings');
  assert.equal(flowRunDiagnostics(state(run([report('a', { warnings: ['coerced'] }), ...healthy.slice(1)])))!.verdict, 'warnings');
  assert.equal(flowRunDiagnostics(state(run([...healthy.slice(0, 2), report('sum', { laneErrors: 1 }), healthy[3]])))!.verdict, 'lane-errors');
  assert.equal(flowRunDiagnostics(state(run([...healthy.slice(0, 2), report('sum', { status: 'error', error: 'boom' }), healthy[3]], [], false)))!.verdict, 'failed');
});

test('#6919 only failing nodes and their inputs expose parameters; messages are bounded', () => {
  const log: RunLogEntry[] = [
    ...Array.from({ length: 9 }, (_, i): RunLogEntry => ({ nodeId: 'sum', laneKey: `${i}`, level: 'error', message: `"a" must be a finite number ${'x'.repeat(900)}` })),
    { nodeId: 'orphans', laneKey: null, level: 'warn', message: 'removed 2 element(s) of deleted node "k"' },
    { nodeId: 'orphans', laneKey: null, level: 'info', message: 'routine' },
  ];
  const diagnostics = flowRunDiagnostics(state(run([...healthy.slice(0, 2), report('sum', { status: 'error', error: 'boom' }), healthy[3]], log, false)))!;
  const params = Object.fromEntries(diagnostics.nodes.map(node => [node.nodeId, node.params]));
  assert.deepEqual(params, { a: { value: 'secret-ish' }, b: { value: 2 }, sum: { op: 'add' }, other: undefined });
  const sum = diagnostics.nodes.find(node => node.nodeId === 'sum')!;
  assert.equal(sum.errorMessages.length, 5);
  assert.ok(sum.errorMessages.every(message => message.length <= 600 && message.startsWith('lane ')));
  assert.deepEqual(diagnostics.hostMessages, ['orphans: removed 2 element(s) of deleted node "k"']);
  assert.ok(isFailingNode(sum) && !isFailingNode(diagnostics.nodes[3]));
  assert.ok(!isFailingNode({ status: 'skipped', laneErrors: 0 }) && isFailingNode({ status: 'ok', laneErrors: 1 }), 'skipped only follows an upstream failure');
});

test('#6919 a flowRun snapshot pins its run; another run or refusal replaces the identity', () => {
  const identity = (value: ReturnType<typeof state>) => flowRunAdapter.identity(value as unknown as ViewerState);
  const first = state(run(healthy));
  const pinned = identity(first);
  assert.equal(pinnedFlowRun({ source: 'flowRun', sourceIdentity: pinned })?.run, first.flowLastRun);
  assert.equal(pinnedFlowRun({ source: 'flow', sourceIdentity: doc }), null, 'graph evidence pins no run');
  assert.equal(sameIdentity(pinned, identity(first)), true);
  assert.equal(sameIdentity(pinned, identity({ ...first, flowLastRun: run(healthy) })), false, 'an identical rerun is a different run');
  assert.equal(sameIdentity(pinned, identity({ ...first, flowLastError: 'refused' })), false);
});

test('#6919 an error with an empty message is still a refusal or a failure, never "not run"', () => {
  assert.equal(flowRunVerdict(null, null, null), 'not-run');
  assert.equal(flowRunVerdict(null, '', null), 'refused');
  assert.equal(flowRunVerdict(null, '', { start: 0, end: 1, doc: newFlowDocument('Run'), mutationIds: new Set() }), 'failed');
});
