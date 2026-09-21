/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapabilities, CapabilityDeniedError } from '@ifc-lite/extensions';
import { NodeRegistry, runFlow, type FlowDocument, type FlowNode, type FlowEdge, type Table } from '@ifc-lite/flow';
import { createFakeBim } from './__tests__/fake-backend.js';
import { BROWSER_FEATURES, createStandardRegistry, headlessFeatures, type FlowHost, type FlowNodeDef } from './index.js';

const registry = createStandardRegistry();

function doc(nodes: FlowNode[], edges: FlowEdge[], outputs: FlowDocument['outputs'] = []): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs, nodes, edges };
}

function grants(...raw: string[]) {
  const r = parseCapabilities(raw);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.value;
}

const edge = (from: string, fp: string, to: string, tp: string): FlowEdge => ({ from: [from, fp], to: [to, tp] });

describe('model read nodes', () => {
  it('select → property lifts per wall and returns nulls for missing properties', async () => {
    const fake = createFakeBim();
    const d = doc(
      [
        { id: 'walls', type: 'model.select', params: { selector: 'IfcWall' } },
        { id: 'fr', type: 'model.property', params: { pset: 'Pset_WallCommon', property: 'FireRating' } },
      ],
      [edge('walls', 'entities', 'fr', 'entity')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim } satisfies FlowHost, registry });
    expect(r.ok).toBe(true);
    expect(r.outputs.get('fr')?.get('value')).toEqual({ kind: 'list', items: ['REI60', null, 'REI90'] });
    // Lanes are keyed by the driving wall's GlobalId, not its index.
    expect(r.reports.find((x) => x.nodeId === 'fr')?.warnings).toEqual([]);
  });

  it('openings per wall: related() over walls yields a group keyed by wall, count runs per branch', async () => {
    const fake = createFakeBim();
    const d = doc(
      [
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 'voids', type: 'model.related', params: { relationship: 'IfcRelVoidsElement', direction: 'forward' } },
        { id: 'n', type: 'core.count' },
      ],
      [edge('walls', 'entities', 'voids', 'entity'), edge('voids', 'related', 'n', 'items')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry });
    const voids = r.outputs.get('voids')?.get('related');
    if (voids?.kind !== 'group') throw new Error('expected a group');
    expect([...voids.branches.entries()].map(([k, v]) => [k, v.length])).toEqual([
      ['W1', 2],
      ['W2', 0],
      ['W3', 1],
    ]);
    expect(r.outputs.get('n')?.get('count')).toEqual({ kind: 'group', branches: new Map([['W1', [2]], ['W2', [0]], ['W3', [1]]]) });
  });

  it('group by storey then per-storey sums stay keyed by storey GlobalId', async () => {
    const fake = createFakeBim();
    const d = doc(
      [
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 'byStorey', type: 'model.groupByStorey' },
        { id: 'n', type: 'core.count' },
        { id: 'keys', type: 'core.keys' },
      ],
      [edge('walls', 'entities', 'byStorey', 'entities'), edge('byStorey', 'group', 'n', 'items'), edge('byStorey', 'group', 'keys', 'group')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry });
    expect(r.outputs.get('n')?.get('count')).toEqual({ kind: 'group', branches: new Map([['S1', [2]], ['S2', [1]]]) });
    expect(r.outputs.get('keys')?.get('keys')).toEqual({ kind: 'list', items: ['S1', 'S2'] });
  });

  it('a GlobalId-only handle is resolved through the index', async () => {
    const fake = createFakeBim();
    // A node that emits a handle carrying only a GlobalId (as a sidecar or a table would).
    const handle: FlowNodeDef = {
      type: 'test.handle',
      title: 'Handle',
      category: 'test',
      inputs: [],
      outputs: [{ name: 'entity', type: { kind: 'entity', access: 'item' } }],
      params: [],
      capabilities: [],
      run: () => ({ entity: { globalId: 'W3' } }),
    };
    const reg = new NodeRegistry<FlowHost>().registerAll([...registry.list(), handle]);
    const d = doc(
      [
        { id: 'h', type: 'test.handle' },
        { id: 'name', type: 'model.attribute', params: { attribute: 'Name' } },
      ],
      [edge('h', 'entity', 'name', 'entity')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry: reg });
    expect(r.outputs.get('name')?.get('value')).toEqual({ kind: 'item', value: 'Wall 3' });
  });
});

describe('tables', () => {
  it('table.fromEntities types its columns and binds property columns; pivot of long format round-trips', async () => {
    const fake = createFakeBim();
    const d = doc(
      [
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 't', type: 'table.fromEntities', params: { columns: ['Name', 'Pset_WallCommon.FireRating', 'Pset_WallCommon.IsExternal'] } },
        { id: 'long', type: 'table.longFormat' },
        { id: 'wide', type: 'table.pivot', params: { rowKey: 'GlobalId', columnKey: 'Prop', value: 'Value' } },
      ],
      [edge('walls', 'entities', 't', 'entities'), edge('walls', 'entities', 'long', 'entities'), edge('long', 'table', 'wide', 'table')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry });
    expect(r.ok).toBe(true);
    const t = (r.outputs.get('t')!.get('table') as { value: Table }).value;
    expect(t.key).toBe('GlobalId');
    expect(t.columns).toEqual([
      { name: 'GlobalId', type: 'identifier' },
      { name: 'Name', type: 'label', binding: undefined },
      { name: 'Pset_WallCommon.FireRating', type: 'string', binding: { pset: 'Pset_WallCommon', prop: 'FireRating' } },
      { name: 'Pset_WallCommon.IsExternal', type: 'boolean', binding: { pset: 'Pset_WallCommon', prop: 'IsExternal' } },
    ]);
    expect(t.rows[1]).toEqual({ GlobalId: 'W2', Name: 'Wall 2', 'Pset_WallCommon.FireRating': null, 'Pset_WallCommon.IsExternal': false });

    const wide = (r.outputs.get('wide')!.get('table') as { value: Table }).value;
    expect(wide.rows).toEqual([
      { GlobalId: 'W1', FireRating: 'REI60', IsExternal: true },
      { GlobalId: 'W2', IsExternal: false },
      { GlobalId: 'W3', FireRating: 'REI90', IsExternal: true },
    ]);
  });
});

describe('viewer and write nodes', () => {
  const graph = () =>
    doc(
      [
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 'color', type: 'viewer.colorize', params: { color: '#00ff00' } },
        { id: 'v', type: 'core.string', params: { value: 'REI120' } },
        { id: 'set', type: 'model.setProperty', params: { pset: 'Pset_WallCommon', property: 'FireRating' } },
      ],
      [edge('walls', 'entities', 'color', 'entities'), edge('walls', 'entities', 'set', 'entity'), edge('v', 'value', 'set', 'value')],
    );

  it('colorizes in the browser and is a no-op headlessly; writes go through mutate', async () => {
    const browser = createFakeBim();
    const r = await runFlow(graph(), { host: { bim: browser.bim }, registry, features: BROWSER_FEATURES });
    expect(r.ok).toBe(true);
    expect(browser.colorized).toHaveLength(1);
    expect(browser.colorized[0].refs.map((x) => x.expressId)).toEqual([10, 11, 12]);
    expect(browser.mutations.map((m) => [m.ref.expressId, m.value])).toEqual([[10, 'REI120'], [11, 'REI120'], [12, 'REI120']]);

    const headless = createFakeBim();
    const h = await runFlow(graph(), { host: { bim: headless.bim }, registry, features: headlessFeatures() });
    expect(h.ok).toBe(true);
    expect(headless.colorized).toHaveLength(0);
    expect(h.reports.find((x) => x.nodeId === 'color')?.status).toBe('noop');
    expect(headless.mutations).toHaveLength(3);
  });

  it('a write is denied unless the grants cover the actual pset', async () => {
    const fake = createFakeBim();
    const denied = await runFlow(graph(), { host: { bim: fake.bim, grants: grants('model.read', 'viewer.colorize', 'model.mutate:Pset_DoorCommon') }, registry, features: BROWSER_FEATURES });
    expect(fake.mutations).toHaveLength(0);
    const setReport = denied.reports.find((x) => x.nodeId === 'set');
    expect(setReport?.laneErrors).toBe(3);
    expect(denied.log.find((l) => l.nodeId === 'set' && l.level === 'error')?.message).toMatch(/Capability denied/);

    const ok = await runFlow(graph(), { host: { bim: fake.bim, grants: grants('model.read', 'viewer.colorize', 'model.mutate:Pset_WallCommon') }, registry, features: BROWSER_FEATURES });
    expect(ok.ok).toBe(true);
    expect(fake.mutations).toHaveLength(3);
    expect(CapabilityDeniedError).toBeDefined();
  });

  it('the Script node is denied when the graph was not granted model.read', async () => {
    const fake = createFakeBim();
    const d = doc(
      [{ id: 'sc', type: 'script.run', params: { code: '1' } }],
      [],
      [{ nodeId: 'sc', port: 'result', label: 'r' }],
    );
    // Empty grants: the node declares `model.read`, and without the check the
    // sandbox was still built with query+model on.
    const denied = await runFlow(d, { host: { bim: fake.bim, grants: grants('viewer.read') }, registry });
    expect(denied.ok).toBe(false);
    expect(denied.reports[0].error).toMatch(/Capability denied/);
  });

  it('the same graph produces the same outputs in the browser and headless', async () => {
    const d = doc(
      [
        { id: 'walls', type: 'model.select', params: { selector: 'IfcWall' } },
        { id: 'color', type: 'viewer.colorize' },
        { id: 'fr', type: 'model.property', params: { pset: 'Pset_WallCommon', property: 'FireRating' } },
      ],
      [edge('walls', 'entities', 'color', 'entities'), edge('color', 'entities', 'fr', 'entity')],
      [{ nodeId: 'fr', port: 'value', label: 'Fire ratings' }],
    );
    const a = await runFlow(d, { host: { bim: createFakeBim().bim }, registry, features: BROWSER_FEATURES });
    const b = await runFlow(d, { host: { bim: createFakeBim().bim }, registry, features: headlessFeatures() });
    expect(JSON.stringify(a.graphOutputs)).toBe(JSON.stringify(b.graphOutputs));
    expect(a.graphOutputs[0].data).toEqual({ kind: 'list', items: ['REI60', null, 'REI90'] });
  });
});
