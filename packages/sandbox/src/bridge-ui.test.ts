/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BimContext, EntityData } from '@ifc-lite/sdk';
import { validateIfcMessages } from '@ifc-lite/a2ui/agent';
import { createSandbox, type Sandbox } from './sandbox.js';

const wall: EntityData = {
  ref: { modelId: 'federation:west', expressId: 42 },
  name: 'West wall',
  type: 'IfcWall',
  globalId: 'wall',
  description: '',
  objectType: '',
};
const sdk = {
  query: () => ({ byType() {}, toArray: () => [wall] }),
} as unknown as BimContext;

describe('bim.ui in QuickJS', () => {
  let sandbox: Sandbox;
  beforeEach(async () => { sandbox = await createSandbox(sdk); });
  afterEach(() => sandbox.dispose());

  async function run(code: string) {
    const result = await sandbox.eval(code, { typescript: false });
    for (const messages of result.surfaces ?? []) {
      expect(validateIfcMessages(messages)).toEqual([]);
    }
    return result;
  }

  it.each([
    ['table', 'bim.ui.table({ columns: [{ path: "Name" }], rows: bim.query.byType("IfcWall") })', 'EntityTable',
      { rows: [{ ref: 'federation:west:42', Name: 'West wall' }] }],
    ['stats', 'bim.ui.stats({ items: [{ label: "Walls", value: 12 }] })', 'StatGroup', { v0: 12 }],
    ['chart', 'bim.ui.chart({ groupBy: "type", chart: "pie", data: [{ label: "Wall", value: 1, refs: [{ modelId: "m", expressId: 1 }] }] })',
      'GroupChart', { data: [{ label: 'Wall', value: 1, refs: ['m:1'] }] }],
    ['legend', 'bim.ui.legend({ by: "storey", apply: "manual", query: { types: ["IfcWall"] } })', 'ColorLegend', undefined],
    ['actions', 'bim.ui.actions({ actions: ["isolate"], refs: ["m:001", { modelId: "m", expressId: 2 }] })',
      'ActionBar', { refs: ['m:1', 'm:2'] }],
    ['callout', 'bim.ui.callout({ text: "Check walls", tone: "warn" })', 'Callout', undefined],
    ['entity', 'bim.ui.entity({ modelId: "federation:west", expressId: 42 })', 'EntityCard', undefined],
    ['list', 'bim.ui.list({ refs: ["m:001", { modelId: "m", expressId: 2 }] })', 'EntityList', { refs: ['m:1', 'm:2'] }],
  ] as const)('builds valid %s surfaces through the catalog', async (_name, code, component, data) => {
    const result = await run(code);
    expect(result.surfaces).toHaveLength(1);
    const model = result.surfaces?.[0][0].createSurface;
    expect(result.value).toMatch(/^script-\d+(?:_\d+){3}-1$/);
    expect(model?.surfaceId).toBe(result.value);
    expect(model?.components).toContainEqual(expect.objectContaining({
      id: 's0', component, ...(component === 'EntityCard' && { entity: 'federation:west:42' }),
    }));
    if (data) expect(model?.dataModel.s0).toMatchObject(data);
  });

  it('show keeps host IDs and catalog components even with injected keys', async () => {
    const result = await run(`
      bim.ui.show({
        title: 'Wall report',
        card: false,
        surfaceId: 'forged',
        catalogId: 'forged',
        components: [{ id: 'root', component: 'Arbitrary' }],
        sections: [
          { kind: 'text', text: 'Report', component: 'Arbitrary' },
          { kind: 'entity', entity: 'federation:west:042' },
          { kind: 'table', columns: [{ path: 'Name' }], rows: [{ ref: 'm:001', Name: 'Wall' }] },
        ],
      })
    `);
    const model = result.surfaces?.[0][0].createSurface;
    expect(model?.surfaceId).toMatch(/^script-\d+(?:_\d+){3}-1$/);
    expect(model?.components).toContainEqual({ id: 'root', component: 'Column', children: ['body'] });
    expect(model?.components.filter(({ id }) => id.startsWith('s'))).toMatchObject([
      { component: 'Text', text: 'Report' },
      { component: 'EntityCard', entity: 'federation:west:42' },
      { component: 'EntityTable' },
    ]);
    expect(model?.dataModel.s2).toEqual({ rows: [{ ref: 'm:1', Name: 'Wall' }] });
  });

  it.each([
    ['bim.ui.show({ sections: [{ kind: "Arbitrary", component: "Button" }] })', /bim\.ui\.show: Invalid surface sections\.0\.kind/],
    ['bim.ui.show({ sections: [{ kind: "text", text: { call: "hide" } }] })', /Invalid surface sections\.0\.text/],
    ['bim.ui.entity("42")', /bim\.ui\.entity: Invalid surface/],
    ['bim.ui.table({ columns: [], rows: Array(2001).fill({}) })', /at most 2000 rows/],
    ['bim.ui.show({ sections: [{ kind: "table", columns: [], query: { limit: 2001 } }] })', /at most 2000 rows/],
  ] as const)('rejects invalid input or oversized table %s', async (code, error) => {
    await expect(run(code)).rejects.toThrow(error);
  });

  it('retains eight ordered surfaces and rejects the ninth without changing the result', async () => {
    const result = await run(`
      const ids = Array.from({ length: 8 }, (_, i) => bim.ui.stats({ items: [{ label: "Index", value: i }] }));
      let error;
      try { bim.ui.callout({ text: "Ninth" }); } catch (e) { error = e.message; }
      ({ ids, error });
    `);
    expect(result.surfaces).toHaveLength(8);
    expect(result.value).toEqual({
      ids: result.surfaces?.map(([message]) => message.createSurface.surfaceId),
      error: expect.stringMatching(/at most 8 surfaces/i),
    });
    expect(result.surfaces?.map(([message]) => message.createSurface.dataModel.s0))
      .toEqual(Array.from({ length: 8 }, (_, v0) => ({ v0 })));
  });

  it('accepts 2000 rows and enforces the cumulative UTF-8 JSON budget', async () => {
    const result = await run(`
      bim.ui.table({ columns: [], rows: Array(2000).fill({}) });
      bim.ui.callout({ text: "界".repeat(45000) });
      let error;
      try { bim.ui.callout({ text: "界".repeat(45000) }); } catch (e) { error = e.message; }
      bim.ui.callout({ text: 'Within budget' });
      error;
    `);
    expect(result.value).toMatch(/256 KiB serialized limit per run/);
    expect(result.surfaces).toHaveLength(3);
    expect(result.surfaces?.[0][0].createSurface.dataModel.s0)
      .toMatchObject({ rows: Array(2000).fill({}) });
  });

  it('isolates queued runs, drops failed captures and omits empty surfaces', async () => {
    const [first, second] = await Promise.all([
      run('Promise.resolve().then(() => bim.ui.callout({ text: "First" }))'),
      run('bim.ui.callout({ text: "Second" })'),
    ]);
    expect(first.surfaces).toHaveLength(1);
    expect(second.surfaces).toHaveLength(1);
    expect(first.surfaces?.[0][0].createSurface.surfaceId).not.toBe(second.value);
    await expect(run('bim.ui.callout({ text: "Discard" }); throw Error("Failed")')).rejects.toThrow('Failed');
    expect(await run('42')).not.toHaveProperty('surfaces');
  });

  it('allows hosts to disable the namespace', async () => {
    const blocked = await createSandbox(sdk, { permissions: { ui: false } });
    try {
      expect((await blocked.eval('typeof bim.ui', { typescript: false })).value).toBe('undefined');
    } finally {
      blocked.dispose();
    }
  });
});
