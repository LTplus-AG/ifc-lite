/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { describeFlowIO } from './introspect.js';
import { NodeRegistry } from './registry.js';
import { FLOW_VERSION, parseFlowDocument, migrateFlowDocument, validateFlowDocument } from './document.js';
const legacy = () => ({ flowVersion: 1, id: 'legacy', name: 'Legacy workflow', capabilities: [],
  inputs: [{ nodeId: 'input', param: 'text', label: 'Original text file', kind: 'file' }], outputs: [],
  nodes: [{ id: 'input', type: 'core.string', params: { text: 'unchanged' } }], edges: [] });
const slots = () => ({ ...legacy(), flowVersion: FLOW_VERSION,
  inputs: [{ nodeId: 'input', param: 'files', label: 'Local models', kind: 'files', fileSlots: [
    { id: 'models', label: 'IFC models', accept: '.ifc', multiple: true, required: true },
  ] }] });
describe('Flow v2 file slots (#6612)', () => {
  it('migrates v1 without changing existing text-file inputs or authored parameters', () => {
    const original = legacy();
    const migrated = parseFlowDocument(JSON.stringify(original));
    expect(migrated.flowVersion).toBe(FLOW_VERSION);
    expect(migrated.inputs).toEqual(original.inputs);
    expect(migrated.nodes).toEqual(original.nodes);
    expect(original.flowVersion).toBe(1);
    expect(validateFlowDocument(migrateFlowDocument(original))).toEqual([]);
  });
  it('round-trips portable slot metadata independently of transient file selections', () => {
    const graph = slots();
    const parsed = parseFlowDocument(JSON.stringify(graph));
    expect(parsed.inputs[0].fileSlots).toEqual(graph.inputs[0].fileSlots);
    expect(parsed.nodes[0].params).toEqual({ text: 'unchanged' });
    expect(describeFlowIO(parsed, new NodeRegistry()).inputs[0].fileSlots).toEqual(graph.inputs[0].fileSlots);
  });
  it('rejects missing, duplicated or non-boolean slot metadata and misplaced slots', () => {
    const graph = slots(); const input = graph.inputs[0]; const slot = input.fileSlots[0];
    for (const broken of [ { ...input, fileSlots: [] }, { ...input, fileSlots: [slot, slot] },
      { ...input, fileSlots: [{ ...slot, required: 'yes' }] }, { ...input, kind: 'file' } ]) {
      expect(validateFlowDocument({ ...graph, inputs: [broken] }).length).toBeGreaterThan(0);
    }
    expect(() => parseFlowDocument(JSON.stringify({ ...graph, flowVersion: 999 }))).toThrow(/invalid flow document/);
  });
});
