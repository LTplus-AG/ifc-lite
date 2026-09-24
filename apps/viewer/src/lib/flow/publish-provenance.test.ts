/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowDocument, NodeReport, RunResult } from '@ifc-lite/flow';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { flowPublishEligibility, flowPublishIntent, writingNodes, FLOW_PUBLISH_AUTHOR_KIND, mutationsInRun, countPendingOutsideRun } from './publish-provenance.js';
import { newFlowDocument } from './persistence.js';
import { addNode, setTracking } from './editor-ops.js';

const registry = createStandardRegistry();

function report(nodeId: string, status: NodeReport['status']): NodeReport {
  return { nodeId, status, durationMs: 0, lanes: 1, laneErrors: 0, missing: {}, warnings: [] };
}

function runResult(overrides: Partial<RunResult>): RunResult {
  return { ok: true, writes: 0, outputs: new Map(), graphOutputs: [], reports: [], log: [], ...overrides };
}

describe('flowPublishEligibility', () => {
  it('disabled with a reason before any run', () => {
    const e = flowPublishEligibility(null, null);
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.noRun');
  });

  it('disabled with a reason after a failed run', () => {
    const e = flowPublishEligibility(runResult({ ok: false }), 'boom');
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.failed');
  });

  it('disabled with a reason after a run that wrote nothing', () => {
    const e = flowPublishEligibility(runResult({ ok: true, writes: 0 }), null);
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.noWrites');
  });

  it('enabled after a successful run that wrote', () => {
    const e = flowPublishEligibility(runResult({ ok: true, writes: 2 }), null);
    assert.equal(e.canPublish, true);
    assert.equal(e.reason, undefined);
  });
});

describe('writingNodes', () => {
  function graphWithWriter(): FlowDocument {
    let doc = newFlowDocument('publish-test');
    doc = addNode(doc, 'model.setProperty', [0, 0]).doc; // setProperty-1: writes: 'model'
    doc = addNode(doc, 'core.number', [0, 100]).doc; // number-1: no writes
    doc = setTracking(doc, 'setProperty-1', 'update', 'my-graph/rooms');
    return doc;
  }

  it('names only the write nodes whose report status is ok, by their tracking key', () => {
    const doc = graphWithWriter();
    const result = runResult({
      ok: true,
      writes: 1,
      reports: [report('setProperty-1', 'ok'), report('number-1', 'ok')],
    });
    const nodes = writingNodes(doc, registry, result);
    assert.deepEqual(nodes, [{ nodeId: 'setProperty-1', trackingKey: 'my-graph/rooms' }]);
  });

  it('excludes a write node whose report is missing or errored', () => {
    const doc = graphWithWriter();
    const result = runResult({ ok: false, writes: 0, reports: [report('setProperty-1', 'error')] });
    assert.deepEqual(writingNodes(doc, registry, result), []);
  });

  it('falls back to the node id when no tracking key or label is set', () => {
    let doc = newFlowDocument('untracked');
    doc = addNode(doc, 'model.setProperty', [0, 0]).doc;
    const result = runResult({ ok: true, writes: 1, reports: [report('setProperty-1', 'ok')] });
    assert.deepEqual(writingNodes(doc, registry, result), [{ nodeId: 'setProperty-1', trackingKey: 'setProperty-1' }]);
  });
});

describe('flowPublishIntent', () => {
  it('names the graph and the tracking keys of the nodes that wrote', () => {
    const doc = newFlowDocument('Audit rooms');
    const intent = flowPublishIntent(doc, [{ nodeId: 'a', trackingKey: 'graph/rooms' }, { nodeId: 'b', trackingKey: 'graph/doors' }]);
    assert.match(intent, /Audit rooms/);
    assert.match(intent, /graph\/rooms/);
    assert.match(intent, /graph\/doors/);
  });
});

describe('mutationsInRun — what one run published', () => {
  it('keeps edits made inside the run and drops those made before or after it', () => {
    const before = { timestamp: 99, id: 'before' };
    const during = { timestamp: 150, id: 'during' };
    const atEdges = [{ timestamp: 100, id: 'start' }, { timestamp: 200, id: 'end' }];
    const after = { timestamp: 201, id: 'after' };
    const kept = mutationsInRun([before, during, ...atEdges, after], { start: 100, end: 200 });
    // `after` is the case the bounded window exists for: a manual edit made
    // once the run finished must not ship under the graph's provenance.
    assert.deepEqual(kept.map((m) => m.id), ['during', 'start', 'end']);
  });
});

describe('FLOW_PUBLISH_AUTHOR_KIND', () => {
  it('is hybrid — a human steering a tool, per 03-provenance.md', () => {
    assert.equal(FLOW_PUBLISH_AUTHOR_KIND, 'hybrid');
  });
});

describe('flowPublishEligibility — other pending edits (#5380 review)', () => {
  const run = { ok: true, writes: 2, outputs: new Map(), graphOutputs: [], reports: [], log: [] } as never;

  it('blocks Publish while edits outside the run are pending, so clearing cannot lose them', () => {
    // Publish clears the pending set after moving the run's edits into a
    // layer. With a manual edit also pending, that clear would discard it.
    assert.deepEqual(flowPublishEligibility(run, null, 1), {
      canPublish: false, reason: 'flowPanel.publish.reason.otherEdits',
    });
    assert.deepEqual(flowPublishEligibility(run, null, 0), { canPublish: true });
  });

  it('blocks a second Publish once none of the run\'s edits is pending any more', () => {
    // A successful publish clears the run's edits (as does undoing them); a
    // second click would publish an empty layer (#5380 review).
    assert.deepEqual(flowPublishEligibility(run, null, 0, 0), {
      canPublish: false, reason: 'flowPanel.publish.reason.nothingPending',
    });
    assert.deepEqual(flowPublishEligibility(run, null, 0, 2), { canPublish: true });
  });

  it('counts edits outside the window on any model, plus pending georeferencing', () => {
    const edits = [{ timestamp: 50 }, { timestamp: 150 }, { timestamp: 250 }];
    assert.equal(countPendingOutsideRun(edits, { start: 100, end: 200 }, 0), 2);
    assert.equal(countPendingOutsideRun(edits, { start: 100, end: 200 }, 1), 3, 'a pending georef change counts too');
    assert.equal(countPendingOutsideRun(edits, null, 0), 3, 'no recorded run: nothing belongs to it');
  });
});
