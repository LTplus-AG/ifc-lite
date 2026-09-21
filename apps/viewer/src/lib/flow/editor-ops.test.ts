/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { addNode, connect, disconnect, moveNode, removeNode, requiredCapabilities, setParam, setTracking, toggleInput, toggleOutput } from './editor-ops.js';
import { newFlowDocument } from './persistence.js';
import { paramSummary, toCanvas } from './view-model.js';

const registry = createStandardRegistry();

function graph(): FlowDocument {
  let doc = newFlowDocument('g');
  doc = addNode(doc, 'model.byType', [0, 0]).doc;
  doc = addNode(doc, 'model.property', [200, 0]).doc;
  doc = addNode(doc, 'core.number', [0, 100]).doc;
  return doc;
}

describe('flow editor ops', () => {
  it('addNode mints unique ids from the type tail and keeps positions', () => {
    const a = addNode(newFlowDocument('g'), 'model.byType', [10, 20]);
    const b = addNode(a.doc, 'model.byType', [30, 40]);
    assert.equal(a.nodeId, 'byType-1');
    assert.equal(b.nodeId, 'byType-2');
    assert.deepEqual(b.doc.nodes.map((n) => n.pos), [[10, 20], [30, 40]]);
    assert.deepEqual(moveNode(b.doc, 'byType-1', [1, 2]).nodes[0].pos, [1, 2]);
  });

  it('connect checks value kinds, replaces the input\'s previous source, and refuses cycles', () => {
    const doc = graph();
    const ok = connect(doc, registry, { from: ['byType-1', 'entities'], to: ['property-1', 'entity'] });
    assert.equal(ok.error, undefined);
    assert.equal(ok.doc.edges.length, 1);

    const wrongKind = connect(ok.doc, registry, { from: ['number-1', 'value'], to: ['property-1', 'entity'] });
    assert.match(wrongKind.error ?? '', /scalar cannot feed entity/);
    assert.equal(wrongKind.doc, ok.doc);

    // A second source into the same input replaces the first: one source per input.
    const second = addNode(ok.doc, 'model.select', [0, 200]);
    const replaced = connect(second.doc, registry, { from: ['select-1', 'entities'], to: ['property-1', 'entity'] });
    assert.equal(replaced.doc.edges.length, 1);
    assert.equal(replaced.doc.edges[0].from[0], 'select-1');

    const missing = connect(ok.doc, registry, { from: ['byType-1', 'nope'], to: ['property-1', 'entity'] });
    assert.match(missing.error ?? '', /no output "nope"/);

    const self = connect(ok.doc, registry, { from: ['property-1', 'value'], to: ['property-1', 'entity'] });
    assert.match(self.error ?? '', /cannot feed itself/);
  });

  it('a cycle through two compare nodes is refused', () => {
    let doc = newFlowDocument('g');
    doc = addNode(doc, 'core.compare', [0, 0]).doc;
    doc = addNode(doc, 'core.compare', [100, 0]).doc;
    const first = connect(doc, registry, { from: ['compare-1', 'result'], to: ['compare-2', 'a'] });
    assert.equal(first.error, undefined);
    const back = connect(first.doc, registry, { from: ['compare-2', 'result'], to: ['compare-1', 'a'] });
    assert.match(back.error ?? '', /cycle/);
  });

  it('removeNode drops its edges and its Player markers; disconnect drops one edge', () => {
    let doc = connect(graph(), registry, { from: ['byType-1', 'entities'], to: ['property-1', 'entity'] }).doc;
    doc = toggleInput(doc, 'byType-1', 'type', 'Type');
    doc = toggleOutput(doc, 'property-1', 'value', 'Values');
    assert.equal(doc.inputs.length, 1);
    assert.equal(doc.outputs.length, 1);
    const without = removeNode(doc, 'byType-1');
    assert.equal(without.nodes.length, 2);
    assert.equal(without.edges.length, 0);
    assert.equal(without.inputs.length, 0);
    assert.equal(without.outputs.length, 1);
    assert.equal(disconnect(doc, 'property-1', 'entity').edges.length, 0);
    assert.equal(toggleInput(doc, 'byType-1', 'type').inputs.length, 0, 'toggling again removes the marker');
  });

  it('setParam / setTracking write node fields; requiredCapabilities unions the node declarations', () => {
    let doc = graph();
    doc = setParam(doc, 'byType-1', 'type', 'IfcDoor');
    assert.equal(doc.nodes[0].params?.type, 'IfcDoor');
    doc = setParam(doc, 'byType-1', 'type', undefined);
    assert.equal(doc.nodes[0].params?.type, undefined);
    doc = addNode(doc, 'model.addElement', [0, 300]).doc;
    doc = setTracking(doc, 'addElement-1', 'replace', 'my/key');
    assert.deepEqual(doc.nodes[3].tracking, 'replace');
    assert.equal(doc.nodes[3].trackingKey, 'my/key');
    assert.equal(setTracking(doc, 'addElement-1', 'update', '').nodes[3].trackingKey, undefined);
    assert.deepEqual(requiredCapabilities(doc, registry), ['model.create', 'model.read']);
  });

  it('toCanvas maps nodes, edges, run status and the param summary', () => {
    let doc = connect(graph(), registry, { from: ['byType-1', 'entities'], to: ['property-1', 'entity'] }).doc;
    doc = setParam(doc, 'byType-1', 'type', 'IfcDoor');
    const reports = new Map([['byType-1', { nodeId: 'byType-1', status: 'ok' as const, durationMs: 1, lanes: 1, laneErrors: 0, missing: {}, warnings: [] }]]);
    const { nodes, edges } = toCanvas(doc, registry, reports, 'property-1');
    assert.equal(nodes.length, 3);
    assert.equal(nodes[0].data.status, 'ok');
    assert.equal(nodes[0].data.summary, 'type=IfcDoor');
    assert.equal(nodes[1].selected, true);
    assert.equal(nodes[1].data.inputs[0].name, 'entity');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].sourceHandle, 'entities');
    assert.equal(paramSummary(registry.get('core.number'), { value: 0 }), '', 'defaults are not summarised');
  });
});
