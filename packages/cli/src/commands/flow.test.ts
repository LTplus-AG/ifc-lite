/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowCommand } from './flow.js';
import { createHeadlessContext } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = resolve(here, '../../../../apps/viewer/public/samples/building-architecture.ifc');
// The audit graph is the viewer's shipped example, not a private copy of it:
// an example the panel offers as "this is how it works" has to keep working,
// and this is the run that proves it. (The sample models next to it are read
// from the viewer's `public/` for the same reason.)
const EXAMPLES = resolve(here, '../../../../apps/viewer/src/lib/flow/examples');
const AUDIT_FLOW = join(EXAMPLES, '05-fire-rating-audit.flow.json');
const COLUMNS_FLOW = resolve(here, '../__fixtures__/flows/columns-along-x.flow.json');
const HELLO_WALL = resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc');

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
    expect(info.id).toBe('example-fire-rating-audit');
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

  it('validate --json still exits 2 when a node cannot run, and a bad --input key is refused before the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const graph = join(dir, 'secret.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's', capabilities: [], inputs: [], outputs: [],
      nodes: [{ id: 'n', type: 'core.number', params: { value: 1 } }, { id: 'ghost', type: 'no.such.node' }],
      edges: [],
    }));
    let c = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    // A JSON run printed `ok: false` and returned 0, so CI read an unrunnable graph as valid.
    await expect(flowCommand(['validate', graph, '--json'])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2);
    expect((c.json() as { ok: boolean }).ok).toBe(false);
    vi.restoreAllMocks();

    c = capture();
    const exit2 = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    // `rating=REI90` (no node id) used to be dropped silently, running the graph on its defaults.
    await expect(flowCommand(['run', AUDIT_FLOW, SAMPLE_IFC, '--input', 'rating=REI90', '--json'])).rejects.toThrow('exit');
    expect(exit2).toHaveBeenCalledWith(1);
    expect(c.err.join('')).toMatch(/--input "rating" names no parameter; this graph declares rating[.]value/);
  });

  it('a failed run writes no model, and --out with a missing operand is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const out = join(dir, 'never.ifc');
    const graph = join(dir, 'broken.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 'b', name: 'b', capabilities: [], inputs: [], outputs: [],
      nodes: [
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 'v', type: 'core.string', params: { value: 'REI60' } },
        { id: 'set', type: 'model.setProperty', params: { pset: 'Pset_WallCommon', property: 'FireRating' } },
        { id: 'boom', type: 'core.math', params: { op: 'divide' } },
        { id: 'zero', type: 'core.number', params: { value: 0 } },
      ],
      edges: [
        { from: ['walls', 'entities'], to: ['set', 'entity'] },
        { from: ['v', 'value'], to: ['set', 'value'] },
        { from: ['zero', 'value'], to: ['boom', 'a'] },
        { from: ['zero', 'value'], to: ['boom', 'b'] },
      ],
    }));
    const c = capture();
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(flowCommand(['run', graph, SAMPLE_IFC, '--out', out, '--json'])).rejects.toThrow('exit');
    // The write node ran before the division failed; exporting that would
    // leave a half-applied model behind a green-looking file.
    await expect(readFile(out, 'utf-8')).rejects.toThrow();
    expect((c.json() as { out: string | null; ok: boolean }).out).toBeNull();
    vi.restoreAllMocks();

    const c2 = capture();
    const exit2 = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(flowCommand(['run', AUDIT_FLOW, SAMPLE_IFC, '--out'])).rejects.toThrow('exit');
    expect(exit2).toHaveBeenCalledWith(1);
    expect(c2.err.join('')).toMatch(/--out needs a value/);
  });

  // Every shipped example, run for real against a real model. Validation
  // only proves a graph is wired; this proves it computes something. An
  // example that throws on a live model is worse than no example.
  it('every built-in example runs headlessly against the sample model and produces its declared outputs', async () => {
    const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith('.flow.json')).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const c = capture();
      // `--no-tracking`: the default sidecar path is beside the graph, which
      // here is the repo's own source tree.
      await flowCommand(['run', join(EXAMPLES, file), SAMPLE_IFC, '--no-tracking', '--json']);
      const summary = c.json() as {
        ok: boolean;
        nodes: Record<string, number>;
        outputs: Array<{ key: string; label: string; data: unknown }>;
        log: Array<{ level: string; nodeId: string; message: string }>;
      };
      vi.restoreAllMocks();
      const errors = summary.log.filter((l) => l.level === 'error').map((l) => `${l.nodeId}: ${l.message}`);
      expect({ file, ok: summary.ok, errors }).toEqual({ file, ok: true, errors: [] });
      expect({ file, failed: summary.nodes.error ?? 0, skipped: summary.nodes.skipped ?? 0 }).toEqual({ file, failed: 0, skipped: 0 });
      // A declared output with no data is a graph that ran and said nothing.
      for (const o of summary.outputs) expect({ file, key: o.key, data: o.data }).not.toEqual({ file, key: o.key, data: undefined });
    }
  });

  it('a tracked creation graph re-run updates its elements in place: same GlobalIds, no adds or removes, vanished lanes removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-'));
    const graph = join(dir, 'columns.flow.json');
    await copyFile(COLUMNS_FLOW, graph);
    const out1 = join(dir, 'cols1.ifc');
    const out2 = join(dir, 'cols2.ifc');
    const out3 = join(dir, 'cols3.ifc');
    const columnsOf = async (path: string) => {
      const { bim } = await createHeadlessContext(path);
      return bim.query().byType('IfcColumn').toArray().map((c) => c.globalId).sort();
    };
    const actions = (c: ReturnType<typeof capture>) =>
      (c.json() as { log: Array<{ nodeId: string; level: string; message: string }> }).log
        .filter((l) => l.nodeId === 'add' && l.level === 'info')
        .map((l) => l.message.split(' ')[0]);

    let c = capture();
    await flowCommand(['run', graph, HELLO_WALL, '--out', out1, '--json']);
    expect(actions(c)).toEqual(['create', 'create', 'create']);
    const first = await columnsOf(out1);
    expect(first).toHaveLength(3);
    expect(JSON.parse(await readFile(join(dir, 'columns.tracking.json'), 'utf-8')).sets['columns-along-x/columns'].entries).toHaveProperty('0');
    vi.restoreAllMocks();

    c = capture();
    await flowCommand(['run', graph, out1, '--input', 'column.height=4', '--out', out2, '--json']);
    expect(actions(c)).toEqual(['update', 'update', 'update']);
    expect(await columnsOf(out2)).toEqual(first);
    // The extrusion depth carries the new height. (The replaced bodies stay in
    // the file as orphaned, unreferenced solids: `store.removeEntity` tombstones
    // the product only — a store-level cleanup tracked separately.)
    const step2 = await readFile(out2, 'utf-8');
    expect(step2.match(/IFCEXTRUDEDAREASOLID\([^)]*,4\.\)/g)).toHaveLength(3);
    vi.restoreAllMocks();

    c = capture();
    await flowCommand(['run', graph, out2, '--input', 'xs.items=[0,4]', '--input', 'column.height=4', '--out', out3, '--json']);
    expect(actions(c)).toEqual(['keep', 'keep']);
    const third = await columnsOf(out3);
    expect(third).toHaveLength(2);
    expect(first.filter((g) => !third.includes(g))).toHaveLength(1);
    vi.restoreAllMocks();

    // Same inputs, but against the model the columns were never added to: the
    // plan says `keep`, the elements are gone, and the run re-creates them
    // under their GlobalIds instead of handing downstream a handle to nothing.
    const out4 = join(dir, 'cols4.ifc');
    c = capture();
    await flowCommand(['run', graph, HELLO_WALL, '--input', 'xs.items=[0,4]', '--input', 'column.height=4', '--out', out4, '--json']);
    expect(actions(c)).toEqual(['keep', 'keep']);
    expect((c.json() as { warnings: Array<{ message: string }> }).warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/no longer in the model; re-creating/));
    expect(await columnsOf(out4)).toEqual(third);
    vi.restoreAllMocks();

    // Deleting the tracked node from the graph removes its set on the next run.
    const withoutAdd = JSON.parse(await readFile(graph, 'utf-8')) as { nodes: Array<{ id: string }>; edges: Array<{ from: [string, string]; to: [string, string] }>; outputs: unknown[] };
    withoutAdd.nodes = withoutAdd.nodes.filter((n) => n.id !== 'add');
    withoutAdd.edges = withoutAdd.edges.filter((e) => e.from[0] !== 'add' && e.to[0] !== 'add');
    withoutAdd.outputs = [];
    await writeFile(graph, JSON.stringify(withoutAdd));
    const out5 = join(dir, 'cols5.ifc');
    c = capture();
    await flowCommand(['run', graph, out4, '--out', out5, '--json']);
    expect(await columnsOf(out5)).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'columns.tracking.json'), 'utf-8')).sets).toEqual({});
  });
});

describe('ifc-lite flow run — secrets (#5167 phase 3.5)', () => {
  it('refuses a {{secret:NAME}} reference the graph does not declare, before the run starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-secret-'));
    const graph = join(dir, 'undeclared.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's', capabilities: [], inputs: [], outputs: [],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.invalid/', headers: { Authorization: 'Bearer {{secret:API_TOKEN}}' } } }],
      edges: [],
    }));
    const c = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(flowCommand(['run', graph, SAMPLE_IFC])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(c.err.join('')).toMatch(/does not declare "secret\.read:API_TOKEN"/);
  });

  it('refuses a declared-but-unset secret reference, before the run starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-secret-'));
    const graph = join(dir, 'unset.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's', capabilities: ['secret.read:DEFINITELY_NOT_SET_5167'], inputs: [], outputs: [],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.invalid/{{secret:DEFINITELY_NOT_SET_5167}}' } }],
      edges: [],
    }));
    expect(process.env.DEFINITELY_NOT_SET_5167).toBeUndefined();
    const c = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(flowCommand(['run', graph, SAMPLE_IFC])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(c.err.join('')).toMatch(/declared but not set/);
  });

  it('a declared+set secret runs, but the request is still refused for reaching an ungranted host — never a silent success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-secret-'));
    const graph = join(dir, 'granted-but-no-host.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's', capabilities: ['secret.read:IFC_LITE_TEST_TOKEN_5167'], inputs: [],
      outputs: [{ nodeId: 'req', port: 'status', label: 'status' }],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.invalid/', headers: { Authorization: 'Bearer {{secret:IFC_LITE_TEST_TOKEN_5167}}' } } }],
      edges: [],
    }));
    process.env.IFC_LITE_TEST_TOKEN_5167 = 'super-secret-token-value-abc123';
    try {
      const c = capture();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
      await expect(flowCommand(['run', graph, SAMPLE_IFC, '--json'])).rejects.toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const summary = c.json() as { ok: boolean; errors: Array<{ message: string }> };
      expect(summary.ok).toBe(false);
      expect(summary.errors[0].message).toMatch(/network\.fetch refused/);
      // The secret value never appears anywhere the run printed, redacted or not.
      expect(c.out.join('')).not.toContain('super-secret-token-value-abc123');
    } finally {
      delete process.env.IFC_LITE_TEST_TOKEN_5167;
    }
  });

  it('redacts a secret a granted server echoes back into the run output (#5446 review)', async () => {
    // A granted host and a response that echoes the Authorization header: the
    // request really runs, so this fails if the output redaction is removed.
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-secret-'));
    const graph = join(dir, 'echo.flow.json');
    await writeFile(graph, JSON.stringify({
      flowVersion: 1, id: 's', name: 's',
      capabilities: ['secret.read:IFC_LITE_TEST_ECHO_5446', 'network.fetch:api.example.com'], inputs: [],
      outputs: [{ nodeId: 'req', port: 'body', label: 'body' }],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.com/echo', headers: { Authorization: 'Bearer {{secret:IFC_LITE_TEST_ECHO_5446}}' } } }],
      edges: [],
    }));
    process.env.IFC_LITE_TEST_ECHO_5446 = 'echoed-secret-value-5446';
      const echo = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        new Response(JSON.stringify({ receivedAuthorization: new Headers(init?.headers).get('authorization') }), { status: 200 }));
    try {
      const c = capture();
      await flowCommand(['run', graph, SAMPLE_IFC, '--json']);
      expect(echo).toHaveBeenCalledOnce();
      const printed = c.out.join('');
      expect(printed).toContain('<secret:IFC_LITE_TEST_ECHO_5446>');
      expect(printed).not.toContain('echoed-secret-value-5446');
    } finally {
      echo.mockRestore();
      delete process.env.IFC_LITE_TEST_ECHO_5446;
    }
  });
});
