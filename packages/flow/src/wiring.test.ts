/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FlowDocument } from './document.js';
import { NodeRegistry, type NodeDef } from './registry.js';
import { validateFlowWiring } from './wiring.js';

const registry = new NodeRegistry<unknown>().registerAll([
  {
    type: 'test.source',
    title: 'Source',
    category: 't',
    inputs: [],
    outputs: [{ name: 'entities', type: { kind: 'entity', access: 'list' } }],
    params: [{ name: 'selector', kind: 'string', default: '' }],
    capabilities: [],
    run: () => ({ entities: [] }),
  },
  {
    type: 'test.sink',
    title: 'Sink',
    category: 't',
    inputs: [
      { name: 'entity', type: { kind: 'entity', access: 'item' } },
      { name: 'extra', type: { kind: 'scalar', access: 'item' }, optional: true },
    ],
    outputs: [{ name: 'value', type: { kind: 'scalar', access: 'item' } }],
    params: [],
    capabilities: [],
    run: () => ({ value: 1 }),
  },
] satisfies NodeDef<unknown>[]);

const base: FlowDocument = {
  flowVersion: 1,
  id: 'g',
  name: 'g',
  capabilities: [],
  inputs: [{ nodeId: 'src', param: 'selector', label: 'Selector', kind: 'scalar' }],
  outputs: [{ nodeId: 'sink', port: 'value', label: 'Value' }],
  nodes: [
    { id: 'src', type: 'test.source' },
    { id: 'sink', type: 'test.sink' },
  ],
  edges: [{ from: ['src', 'entities'], to: ['sink', 'entity'] }],
};

describe('validateFlowWiring', () => {
  it('accepts a correctly wired document', () => {
    expect(validateFlowWiring(base, registry)).toEqual([]);
  });

  it('catches a declared output naming a port no node has — the case that validated clean and produced nothing', () => {
    const bad: FlowDocument = { ...base, outputs: [{ nodeId: 'sink', port: 'missing', label: 'X' }] };
    expect(validateFlowWiring(bad, registry)).toEqual([{ path: 'outputs[0]', message: 'node "sink" has no output "missing"' }]);
  });

  it('catches a Player input naming a parameter the node does not declare', () => {
    const bad: FlowDocument = { ...base, inputs: [{ nodeId: 'sink', param: 'nope', label: 'X', kind: 'scalar' }] };
    expect(validateFlowWiring(bad, registry)).toEqual([{ path: 'inputs[0]', message: 'node "sink" has no parameter "nope"' }]);
  });

  it('catches unknown node types, missing ports, type-incompatible edges and unconnected required inputs', () => {
    const bad: FlowDocument = {
      ...base,
      nodes: [...base.nodes, { id: 'ghost', type: 'no.such.node' }],
      edges: [{ from: ['src', 'nope'], to: ['sink', 'entity'] }],
    };
    const problems = validateFlowWiring(bad, registry).map((p) => p.message);
    expect(problems).toContain('unknown node type "no.such.node" (ghost)');
    expect(problems).toContain('node "src" has no output "nope"');

    const mistyped: FlowDocument = { ...base, edges: [{ from: ['sink', 'value'], to: ['sink', 'entity'] }] };
    expect(validateFlowWiring(mistyped, registry).map((p) => p.message)).toContain('sink.value (scalar) cannot feed sink.entity (entity)');

    const unconnected: FlowDocument = { ...base, edges: [] };
    expect(validateFlowWiring(unconnected, registry).map((p) => p.message)).toEqual(['required input "entity" of "sink" is not connected']);
  });
});
