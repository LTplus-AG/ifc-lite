/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowCommand } from './flow.js';
import { createHeadlessContext } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = resolve(here, '../../../../apps/viewer/public/samples/building-architecture.ifc');
const AUDIT_FLOW = resolve(here, '../__fixtures__/flows/fire-rating-audit.flow.json');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true; });
  return { out, err, json: () => JSON.parse(out.join('')) as Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe('ifc-lite flow', () => {
  it('describe prints the Player schema: inputs with defaults, outputs with kind/access', async () => {
    const c = capture();
    await flowCommand(['describe', AUDIT_FLOW, '--json']);
    const info = c.json();
    expect(info.id).toBe('fire-rating-audit');
    expect(info.inputs).toEqual([{ key: 'rating.value', label: 'Default fire rating', kind: 'scalar', options: undefined, default: '', paramKind: 'string' }]);
    expect(info.outputs).toEqual([
      { key: 'missingCount.count', label: 'Walls without FireRating', kind: 'scalar', access: 'item' },
      { key: 'table.table', label: 'Wall table', kind: 'table', access: 'item' },
    ]);
  });

  it('validate reports viewer nodes as noop headlessly and the rest as ok', async () => {
    const c = capture();
    await flowCommand(['validate', AUDIT_FLOW, '--json']);
    const report = c.json() as { ok: boolean; nodes: Array<{ nodeId: string; status: string }> };
    expect(report.ok).toBe(true);
    expect(report.nodes.find((n) => n.nodeId === 'color')?.status).toBe('noop');
    expect(report.nodes.filter((n) => n.status === 'ok')).toHaveLength(8);
  });

  it('run audits the sample, writes the default rating, and the written IFC carries it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const out = join(dir, 'out.ifc');
    const c = capture();
    await flowCommand(['run', AUDIT_FLOW, SAMPLE_IFC, '--input', 'rating.value=REI90', '--out', out, '--json']);
    const summary = c.json() as { ok: boolean; nodes: Record<string, number>; outputs: Array<{ key: string; data: { value: unknown } }> };
    expect(summary.ok).toBe(true);
    expect(summary.nodes).toEqual({ ok: 8, noop: 1 });
    expect(summary.outputs.find((o) => o.key === 'missingCount.count')?.data.value).toBe(4);

    // Independent read-back through a fresh headless context, not the run's own table.
    const { bim } = await createHeadlessContext(out);
    const rated = bim.query().byType('IfcWall').where('Pset_WallCommon', 'FireRating', '=', 'REI90').count();
    expect(rated).toBe(4);
    const { bim: original } = await createHeadlessContext(SAMPLE_IFC);
    expect(original.query().byType('IfcWall').where('Pset_WallCommon', 'FireRating', '=', 'REI90').count()).toBe(0);
  });

  it('run executes a Script node in the QuickJS sandbox headlessly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const graph = join(dir, 'script.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's', capabilities: ['model.read'], inputs: [],
      outputs: [{ nodeId: 'sc', port: 'result', label: 'n' }],
      nodes: [
        { id: 'n', type: 'core.number', params: { value: 2 } },
        { id: 'sc', type: 'script.run', params: { code: "bim.query.byType('IfcWall').length * inputs.a" } },
      ],
      edges: [{ from: ['n', 'value'], to: ['sc', 'a'] }],
    }));
    const c = capture();
    await flowCommand(['run', graph, SAMPLE_IFC, '--json']);
    const summary = c.json() as { ok: boolean; outputs: Array<{ data: { value: unknown } }> };
    expect(summary.ok).toBe(true);
    expect(summary.outputs[0].data.value).toBe(8);
  });

  it('rejects an invalid document with every problem listed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const graph = join(dir, 'bad.flow.json');
    await writeFile(graph, JSON.stringify({ flowVersion: 1, id: 'x', name: 'x', nodes: [{ id: 'a', type: 'core.number', lacing: 'sideways' }], edges: [{ from: ['ghost', 'v'], to: ['a', 'x'] }], inputs: [], outputs: [], capabilities: [] }));
    const c = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(flowCommand(['validate', graph])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(c.err.join('')).toMatch(/nodes\[0\]\.lacing: must be one of shortest, longest, cross/);
    expect(c.err.join('')).toMatch(/unknown node "ghost"/);
  });
});
