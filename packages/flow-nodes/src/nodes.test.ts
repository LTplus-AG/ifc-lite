/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapabilities, CapabilityDeniedError } from '@ifc-lite/extensions';
import { NodeRegistry, runFlow, type FlowDocument, type FlowNode, type FlowEdge, type Table } from '@ifc-lite/flow';
import { createFakeBim } from './__tests__/fake-backend.js';
import { BROWSER_FEATURES, createStandardRegistry, headlessFeatures, readXlsxTable, writeXlsxTable, type FlowHost, type FlowNodeDef } from './index.js';

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

// #5167 phase 3.2: the pilot workflow's spreadsheet connector nodes. One
// assertion per type here is deliberately load-bearing under the revert
// oracle: reverting the production hunks restores `index.ts` to NOT register
// these types, so `registry.get(...)` fails the `toBeDefined()` assertion
// rather than the whole file failing to import (a brand-new module plus a
// brand-new test importing it would otherwise only ever load-fail).
describe('table connector nodes are registered', () => {
  it('table.readCsv, table.writeCsv, table.readXlsx, table.writeXlsx, table.joinByKey, model.applyTable all exist', () => {
    for (const type of ['table.readCsv', 'table.writeCsv', 'table.readXlsx', 'table.writeXlsx', 'table.joinByKey', 'model.applyTable']) {
      expect(registry.get(type), type).toBeDefined();
    }
  });
});

function testCtx() {
  return { host: { bim: createFakeBim().bim }, laneKey: null, log: () => undefined };
}

describe('table.readCsv / table.writeCsv', () => {
  it('round-trips typed columns and reports a malformed row instead of dropping it', async () => {
    // Row 2 has an unparseable Real cell ("abc"); row 3 has one extra field.
    // Both must still appear in the table, not vanish.
    const text = 'GlobalId,FireRating,IsExternal\nW1,60,true\nW2,abc,false\nW3,90,true,extra\n';
    const readReg = registry.get('table.readCsv')!;
    const readOut = (await readReg.run(testCtx(), { text }, {
      columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'FireRating', type: 'real' }, { name: 'IsExternal', type: 'boolean' }],
      delimiter: ',',
    })) as { table: Table; problems: string[] };
    const table = readOut.table;
    expect(table.rows).toEqual([
      { GlobalId: 'W1', FireRating: 60, IsExternal: true },
      { GlobalId: 'W2', FireRating: null, IsExternal: false },
      { GlobalId: 'W3', FireRating: 90, IsExternal: true },
    ]);
    expect(readOut.problems).toEqual([
      'row 3: column "FireRating": cannot parse "abc" as real',
      'row 4: expected 3 field(s), got 4',
    ]);

    const writeReg = registry.get('table.writeCsv')!;
    const out = (await writeReg.run(testCtx(), { table }, { delimiter: ',' })) as { text: string };
    expect(out.text).toBe('GlobalId,FireRating,IsExternal\nW1,60,true\nW2,,false\nW3,90,true\n');
  });

  it('escapes CWE-1236 formula-injection triggers (=, +, -, @) in the actual output bytes', () => {
    const reg = registry.get('table.writeCsv')!;
    const table: Table = {
      columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'Note', type: 'string' }],
      rows: [
        { GlobalId: 'W1', Note: '=cmd|/c calc' },
        { GlobalId: 'W2', Note: '+1+1' },
        { GlobalId: 'W3', Note: '-2+3' },
        { GlobalId: 'W4', Note: '@SUM(A1)' },
        { GlobalId: 'W5', Note: 'a,b' },
      ],
      key: 'GlobalId',
    };
    const out = reg.run({ host: { bim: createFakeBim().bim }, laneKey: null, log: () => undefined }, { table }, { delimiter: ',' }) as { text: string };
    expect(out.text).toBe(
      'GlobalId,Note\n' +
        "W1,'=cmd|/c calc\n" +
        "W2,'+1+1\n" +
        "W3,'-2+3\n" +
        "W4,'@SUM(A1)\n" +
        'W5,"a,b"\n',
    );
  });
});

describe('table.readXlsx / table.writeXlsx', () => {
  it('reads back a sheet WriteXlsx produced, column types preserved', async () => {
    const table: Table = {
      columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'FireRating', type: 'real' }, { name: 'IsExternal', type: 'boolean' }],
      rows: [
        { GlobalId: 'W1', FireRating: 60, IsExternal: true },
        { GlobalId: 'W2', FireRating: null, IsExternal: false },
      ],
      key: 'GlobalId',
    };
    const bytes = await writeXlsxTable(table, 'Data');
    const { table: readBack, problems } = await readXlsxTable(bytes, {
      columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'FireRating', type: 'real' }, { name: 'IsExternal', type: 'boolean' }],
    });
    expect(problems).toEqual([]);
    expect(readBack.rows).toEqual(table.rows);
    expect(readBack.columns.map((c) => c.type)).toEqual(['identifier', 'real', 'boolean']);
  });
});

describe('table.joinByKey', () => {
  function walls(fake: ReturnType<typeof createFakeBim>) {
    return fake.entities.filter((e) => e.type === 'IfcWall').map((e) => ({ globalId: e.globalId, modelId: 'm1', expressId: e.expressId }));
  }

  it('globalId strategy: separates matched, unmatched and ambiguous (two rows claiming one entity)', async () => {
    const fake = createFakeBim();
    const table: Table = {
      columns: [{ name: 'Key', type: 'string' }, { name: 'Rating', type: 'string' }],
      rows: [
        { Key: 'W1', Rating: 'REI60' }, // matched
        { Key: 'W1', Rating: 'REI61' }, // same entity, second row: entity-side ambiguity
        { Key: 'W2', Rating: 'REI90' }, // matched
        { Key: 'ZZZ', Rating: 'X' }, // unmatched: no such entity
      ],
      key: 'Key',
    };
    const handle: FlowNodeDef = {
      type: 'test.entities', title: 't', category: 'test', inputs: [], outputs: [{ name: 'entities', type: { kind: 'entity', access: 'list' } }], params: [], capabilities: [],
      run: () => ({ entities: walls(fake) }),
    };
    const handle2: FlowNodeDef = {
      type: 'test.table', title: 't', category: 'test', inputs: [], outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], params: [], capabilities: [],
      run: () => ({ table }),
    };
    const reg = new NodeRegistry<FlowHost>().registerAll([...registry.list(), handle, handle2]);
    const d = doc(
      [
        { id: 'e', type: 'test.entities' },
        { id: 't', type: 'test.table' },
        { id: 'j', type: 'table.joinByKey', params: { strategy: 'globalId', column: 'Key' } },
      ],
      [edge('e', 'entities', 'j', 'entities'), edge('t', 'table', 'j', 'table')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry: reg });
    expect(r.ok).toBe(true);
    const matched = (r.outputs.get('j')!.get('matched') as { value: Table }).value;
    const unmatched = (r.outputs.get('j')!.get('unmatched') as { value: Table }).value;
    const ambiguous = (r.outputs.get('j')!.get('ambiguous') as { value: Table }).value;
    expect(matched.rows).toEqual([{ Key: 'W2', Rating: 'REI90', GlobalId: 'W2' }]);
    expect(unmatched.rows).toEqual([{ Key: 'ZZZ', Rating: 'X' }]);
    expect(ambiguous.rows).toEqual([
      { Key: 'W1', Rating: 'REI60', MatchedGlobalIds: 'W1' },
      { Key: 'W1', Rating: 'REI61', MatchedGlobalIds: 'W1' },
    ]);
  });

  it('name strategy matches case-insensitively', async () => {
    const fake = createFakeBim();
    const table: Table = { columns: [{ name: 'Key', type: 'string' }], rows: [{ Key: 'WALL 1' }], key: 'Key' };
    const handle: FlowNodeDef = { type: 'test.e2', title: 't', category: 'test', inputs: [], outputs: [{ name: 'entities', type: { kind: 'entity', access: 'list' } }], params: [], capabilities: [], run: () => ({ entities: walls(fake) }) };
    const handle2: FlowNodeDef = { type: 'test.t2', title: 't', category: 'test', inputs: [], outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], params: [], capabilities: [], run: () => ({ table }) };
    const reg = new NodeRegistry<FlowHost>().registerAll([...registry.list(), handle, handle2]);
    const d = doc(
      [{ id: 'e', type: 'test.e2' }, { id: 't', type: 'test.t2' }, { id: 'j', type: 'table.joinByKey', params: { strategy: 'name', column: 'Key' } }],
      [edge('e', 'entities', 'j', 'entities'), edge('t', 'table', 'j', 'table')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry: reg });
    const matched = (r.outputs.get('j')!.get('matched') as { value: Table }).value;
    expect(matched.rows).toEqual([{ Key: 'WALL 1', GlobalId: 'W1' }]);
  });

  it('tag/property strategies report plainly when the host provides no bulk table access', async () => {
    const fake = createFakeBim();
    const table: Table = { columns: [{ name: 'Key', type: 'string' }], rows: [{ Key: 'X' }], key: 'Key' };
    const handle: FlowNodeDef = { type: 'test.e3', title: 't', category: 'test', inputs: [], outputs: [{ name: 'entities', type: { kind: 'entity', access: 'list' } }], params: [], capabilities: [], run: () => ({ entities: walls(fake) }) };
    const handle2: FlowNodeDef = { type: 'test.t3', title: 't', category: 'test', inputs: [], outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], params: [], capabilities: [], run: () => ({ table }) };
    const reg = new NodeRegistry<FlowHost>().registerAll([...registry.list(), handle, handle2]);
    const d = doc(
      [{ id: 'e', type: 'test.e3' }, { id: 't', type: 'test.t3' }, { id: 'j', type: 'table.joinByKey', params: { strategy: 'tag', column: 'Key' } }],
      [edge('e', 'entities', 'j', 'entities'), edge('t', 'table', 'j', 'table')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry: reg });
    expect(r.ok).toBe(false);
    expect(r.reports.find((x) => x.nodeId === 'j')?.error).toMatch(/needs a host that provides bulk entity access/);
  });
});

describe('model.applyTable', () => {
  it('writes typed columns as property mutations; a cell that does not parse as its column type is reported per row and NOT written (never coerced to 0)', async () => {
    const fake = createFakeBim();
    const table: Table = {
      columns: [
        { name: 'GlobalId', type: 'identifier' },
        { name: 'FireRating', type: 'string', binding: { pset: 'Pset_WallCommon', prop: 'FireRating' } },
        { name: 'Width', type: 'real', binding: { pset: 'Pset_WallCommon', prop: 'Width' } },
      ],
      rows: [
        { GlobalId: 'W1', FireRating: 'REI120', Width: 120.5 },
        { GlobalId: 'W2', FireRating: 'REI30', Width: 'wide' },
      ],
      key: 'GlobalId',
    };
    const handle: FlowNodeDef = { type: 'test.t4', title: 't', category: 'test', inputs: [], outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], params: [], capabilities: [], run: () => ({ table }) };
    const reg = new NodeRegistry<FlowHost>().registerAll([...registry.list(), handle]);
    const d = doc(
      [{ id: 't', type: 'test.t4' }, { id: 'a', type: 'model.applyTable' }],
      [edge('t', 'table', 'a', 'table')],
    );
    const r = await runFlow(d, { host: { bim: fake.bim }, registry: reg, features: headlessFeatures() });
    expect(r.ok).toBe(true);
    const problems = (r.outputs.get('a')?.get('problems') as { items: string[] } | undefined)?.items ?? [];
    expect(problems).toEqual(['W2: column "Width": cannot parse "wide" as real']);
    // W1: both columns wrote. W2: FireRating wrote, Width did NOT (bad cell) —
    // and critically, NOT written as 0 (`parseFloat('wide')` is NaN, not 0).
    expect(fake.mutations.map((m) => [m.ref.expressId, m.prop, m.value])).toEqual([
      [10, 'FireRating', 'REI120'],
      [10, 'Width', 120.5],
      [11, 'FireRating', 'REI30'],
    ]);
  });
});
