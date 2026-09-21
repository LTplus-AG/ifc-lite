/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { checkAvailability, type HostFeatures } from './availability.js';
import { parseFlowDocument, validateFlowDocument, type FlowDocument } from './document.js';
import { NodeRegistry, type NodeDef } from './registry.js';
import { FlowCycleError, MemoCache, runFlow, topologicalOrder } from './scheduler.js';
import { group, list, type EntityRef } from './values.js';

/** A tiny fake host: a "model" of walls with areas, and a colorize call log. */
interface Host {
  walls: EntityRef[];
  area: Record<string, number>;
  colorized: string[];
}

const registry = new NodeRegistry<Host>().registerAll([
  {
    type: 'test.walls',
    title: 'Walls',
    category: 'test',
    inputs: [],
    outputs: [{ name: 'walls', type: { kind: 'entity', access: 'list' } }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx) => ({ walls: ctx.host.walls }),
  },
  {
    type: 'test.area',
    title: 'Area',
    category: 'test',
    inputs: [{ name: 'wall', type: { kind: 'entity', access: 'item' } }],
    outputs: [{ name: 'area', type: { kind: 'scalar', access: 'item' } }],
    params: [{ name: 'factor', kind: 'number', default: 1 }],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, inputs, params) => {
      const wall = inputs.wall as EntityRef;
      const a = ctx.host.area[wall.globalId];
      if (a === undefined) throw new Error(`no area for ${wall.globalId}`);
      return { area: a * (params.factor as number) };
    },
  },
  {
    type: 'test.sum',
    title: 'Sum',
    category: 'test',
    inputs: [{ name: 'values', type: { kind: 'scalar', access: 'list' } }],
    outputs: [{ name: 'total', type: { kind: 'scalar', access: 'item' } }],
    params: [],
    capabilities: [],
    run: (_ctx, inputs) => ({ total: (inputs.values as (number | null)[]).reduce<number>((s, v) => s + (v ?? 0), 0) }),
  },
  {
    type: 'test.colorize',
    title: 'Colorize',
    category: 'test',
    inputs: [{ name: 'walls', type: { kind: 'entity', access: 'list' } }],
    outputs: [{ name: 'walls', type: { kind: 'entity', access: 'list' } }],
    params: [],
    capabilities: ['viewer.colorize'],
    requires: { backend: ['viewer'] },
    headless: 'noop',
    run: (ctx, inputs) => {
      const walls = inputs.walls as EntityRef[];
      ctx.host.colorized.push(...walls.map((w) => w.globalId));
      return { walls };
    },
  },
] satisfies NodeDef<Host>[]);

const doc: FlowDocument = {
  flowVersion: 1,
  id: 'g1',
  name: 'areas',
  capabilities: ['model.read', 'viewer.colorize'],
  inputs: [{ nodeId: 'area', param: 'factor', label: 'Factor', kind: 'scalar' }],
  outputs: [{ nodeId: 'sum', port: 'total', label: 'Total area' }],
  nodes: [
    { id: 'walls', type: 'test.walls' },
    { id: 'area', type: 'test.area' },
    { id: 'sum', type: 'test.sum' },
    { id: 'color', type: 'test.colorize' },
  ],
  edges: [
    { from: ['walls', 'walls'], to: ['area', 'wall'] },
    { from: ['area', 'area'], to: ['sum', 'values'] },
    { from: ['walls', 'walls'], to: ['color', 'walls'] },
  ],
};

const host = (): Host => ({ walls: [{ globalId: 'W1' }, { globalId: 'W2' }], area: { W1: 10, W2: 5 }, colorized: [] });
const browser: HostFeatures = { backend: new Set(['viewer']), network: false, secrets: new Set() };
const headless: HostFeatures = { backend: new Set(), network: false, secrets: new Set() };

describe('runFlow', () => {
  it('evaluates in topological order, lifting per wall, and collects graph outputs', async () => {
    const h = host();
    const result = await runFlow(doc, { host: h, registry, features: browser });
    expect(result.ok).toBe(true);
    expect(result.graphOutputs[0].data).toEqual({ kind: 'item', value: 15 });
    expect(result.outputs.get('area')?.get('area')).toEqual(list([10, 5]));
    expect(h.colorized).toEqual(['W1', 'W2']);
    expect(result.reports.find((r) => r.nodeId === 'area')?.lanes).toBe(2);
  });

  it('Player overrides set node params', async () => {
    const result = await runFlow(doc, { host: host(), registry, inputs: { 'area.factor': 2 } });
    expect(result.graphOutputs[0].data).toEqual({ kind: 'item', value: 30 });
  });

  it('a lane error yields null for that lane and is logged; the node still succeeds', async () => {
    const h = host();
    delete h.area.W2;
    const result = await runFlow(doc, { host: h, registry });
    expect(result.ok).toBe(true);
    expect(result.outputs.get('area')?.get('area')).toEqual(list([10, null]));
    expect(result.graphOutputs[0].data).toEqual({ kind: 'item', value: 10 });
    expect(result.log.find((l) => l.level === 'error')).toMatchObject({ nodeId: 'area', laneKey: 'W2' });
    expect(result.reports.find((r) => r.nodeId === 'area')?.laneErrors).toBe(1);
  });

  it('headless: a viewer node is a no-op that passes its input through', async () => {
    const h = host();
    const result = await runFlow(doc, { host: h, registry, features: headless });
    expect(h.colorized).toEqual([]);
    const color = result.reports.find((r) => r.nodeId === 'color');
    expect(color?.status).toBe('noop');
    expect(result.outputs.get('color')?.get('walls')).toEqual(list(h.walls));
  });

  it('memoises reads until a model revision changes', async () => {
    const cache = new MemoCache();
    const h = host();
    await runFlow(doc, { host: h, registry, cache, modelRevisions: { m: 1 } });
    const second = await runFlow(doc, { host: h, registry, cache, modelRevisions: { m: 1 } });
    expect(second.reports.map((r) => r.status)).toEqual(['memo', 'memo', 'memo', 'memo']);
    const third = await runFlow(doc, { host: h, registry, cache, modelRevisions: { m: 2 } });
    expect(third.reports.find((r) => r.nodeId === 'walls')?.status).toBe('ok');
    // `sum` does not read the model, and its input digest did not change.
    expect(third.reports.find((r) => r.nodeId === 'sum')?.status).toBe('memo');
  });

  it('a read downstream of a write is not served from a memo taken before the write', async () => {
    const reg = new NodeRegistry<Host>().registerAll([
      registry.get('test.walls')!,
      {
        type: 'test.addWall',
        title: 'Add wall',
        category: 'test',
        inputs: [],
        outputs: [],
        params: [],
        capabilities: ['model.create'],
        writes: 'model',
        run: (ctx) => {
          ctx.host.walls.push({ globalId: `W${ctx.host.walls.length + 1}` });
          return {};
        },
      },
      {
        type: 'test.after',
        title: 'After',
        category: 'test',
        inputs: [],
        outputs: [{ name: 'n', type: { kind: 'scalar', access: 'item' } }],
        params: [],
        capabilities: ['model.read'],
        reads: 'model',
        run: (ctx) => ({ n: ctx.host.walls.length }),
      },
    ]);
    const d: FlowDocument = {
      flowVersion: 1,
      id: 'g3',
      name: 'write then read',
      capabilities: [],
      inputs: [],
      outputs: [],
      nodes: [
        { id: 'before', type: 'test.after' },
        { id: 'add', type: 'test.addWall' },
        { id: 'after', type: 'test.after' },
      ],
      // No data edges: document order puts `before` first, `after` last.
      edges: [],
    };
    const cache = new MemoCache();
    const h = host();
    const first = await runFlow(d, { host: h, registry: reg, cache, modelRevisions: { m: 1 } });
    expect(first.writes).toBe(1);
    expect(first.outputs.get('before')?.get('n')).toEqual({ kind: 'item', value: 2 });
    expect(first.outputs.get('after')?.get('n')).toEqual({ kind: 'item', value: 3 });
    // Same revision from the caller's point of view, but the model changed: every read recomputes.
    const second = await runFlow(d, { host: h, registry: reg, cache, modelRevisions: { m: 1 } });
    expect(second.reports.find((r) => r.nodeId === 'before')?.status).toBe('ok');
    expect(second.outputs.get('before')?.get('n')).toEqual({ kind: 'item', value: 3 });
    expect(second.outputs.get('after')?.get('n')).toEqual({ kind: 'item', value: 4 });
    expect(cache.writeGeneration).toBe(2);
  });

  it('an unknown node type fails that node and skips its dependants', async () => {
    const broken: FlowDocument = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'walls' ? { ...n, type: 'nope' } : n)) };
    const result = await runFlow(broken, { host: host(), registry });
    expect(result.ok).toBe(false);
    expect(Object.fromEntries(result.reports.map((r) => [r.nodeId, r.status]))).toEqual({ walls: 'error', area: 'skipped', sum: 'skipped', color: 'skipped' });
  });

  it('a type mismatch on an edge is an error at the consuming node', async () => {
    const bad: FlowDocument = { ...doc, edges: [{ from: ['area', 'area'], to: ['color', 'walls'] }, ...doc.edges.slice(0, 2)] };
    const result = await runFlow(bad, { host: host(), registry, features: browser });
    expect(result.reports.find((r) => r.nodeId === 'color')?.error).toMatch(/\(scalar\) cannot feed "walls" \(entity\)/);
  });

  it('groups flow through: a list node lifted over a group runs per branch', async () => {
    const reg = new NodeRegistry<Host>().registerAll([
      {
        type: 'test.byStorey',
        title: 'By storey',
        category: 'test',
        inputs: [],
        outputs: [{ name: 'walls', type: { kind: 'entity', access: 'group' } }],
        params: [],
        capabilities: [],
        run: () => ({ walls: new Map([['EG', [{ globalId: 'W1' }]], ['OG', [{ globalId: 'W2' }, { globalId: 'W3' }]]]) }),
      },
      registry.get('test.sum')!,
      {
        type: 'test.count',
        title: 'Count',
        category: 'test',
        inputs: [{ name: 'xs', type: { kind: 'any', access: 'list' } }],
        outputs: [{ name: 'n', type: { kind: 'scalar', access: 'item' } }],
        params: [],
        capabilities: [],
        run: (_c, i) => ({ n: (i.xs as unknown[]).length }),
      },
    ]);
    const d: FlowDocument = {
      flowVersion: 1,
      id: 'g2',
      name: 'per storey',
      capabilities: [],
      inputs: [],
      outputs: [],
      nodes: [
        { id: 's', type: 'test.byStorey' },
        { id: 'n', type: 'test.count' },
      ],
      edges: [{ from: ['s', 'walls'], to: ['n', 'xs'] }],
    };
    const result = await runFlow(d, { host: host(), registry: reg });
    expect(result.outputs.get('n')?.get('n')).toEqual(group([['EG', [1]], ['OG', [2]]]));
  });
});

describe('topologicalOrder / documents', () => {
  it('detects cycles', () => {
    const cyclic: FlowDocument = { ...doc, edges: [...doc.edges, { from: ['sum', 'total'], to: ['area', 'wall'] }] };
    expect(() => topologicalOrder(cyclic)).toThrow(FlowCycleError);
  });

  it('validates documents structurally', () => {
    expect(validateFlowDocument(doc)).toEqual([]);
    const problems = validateFlowDocument({ ...doc, edges: [...doc.edges, { from: ['ghost', 'x'], to: ['area', 'wall'] }], nodes: [...doc.nodes, { id: 'walls', type: 'dup' }] });
    expect(problems.map((p) => p.message)).toEqual(['duplicate node id "walls"', 'unknown node "ghost"', 'input area.wall has more than one incoming edge']);
  });

  it('parseFlowDocument round-trips JSON and lists every problem', () => {
    expect(parseFlowDocument(JSON.stringify(doc))).toEqual(doc);
    expect(() => parseFlowDocument('{"flowVersion":1}')).toThrow(/id: must be a non-empty string[\s\S]*nodes: must be an array/);
    expect(() => parseFlowDocument('nope')).toThrow(/not valid JSON/);
  });

  it('availability report distinguishes noop from unavailable', () => {
    const reg = new NodeRegistry<Host>().registerAll([
      registry.get('test.colorize')!,
      { ...registry.get('test.walls')!, type: 'test.secret', requires: { secrets: ['CDE_TOKEN'] } },
    ]);
    const d: FlowDocument = { ...doc, nodes: [{ id: 'c', type: 'test.colorize' }, { id: 's', type: 'test.secret' }, { id: 'u', type: 'nope' }], edges: [], inputs: [], outputs: [] };
    expect(checkAvailability(d, reg, headless).map((a) => [a.nodeId, a.status])).toEqual([
      ['c', 'noop'],
      ['s', 'unavailable'],
      ['u', 'unknown'],
    ]);
    expect(checkAvailability(d, reg, { ...browser, secrets: new Set(['CDE_TOKEN']) }).map((a) => a.status)).toEqual(['ok', 'ok', 'unknown']);
  });
});
