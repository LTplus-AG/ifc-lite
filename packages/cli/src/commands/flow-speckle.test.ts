/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `speckle.receive` through `ifc-lite flow run` against a real model (#5634):
 * the one thing the flow-nodes tests over a fake backend cannot show — that
 * the mapped elements are real IFC entities in the exported file, with their
 * property sets, read back through a FRESH headless context.
 *
 * The CLI's transport is the global `fetch`, so the hand-authored corpus
 * (`packages/flow-nodes/src/__fixtures__/speckle/`) is served by a spy on it.
 * The grant check still runs first, inside `coreNetworkRequest`.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findPropertyInSets } from '@ifc-lite/query';
import { flowCommand } from './flow.js';
import { createHeadlessContext } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const HELLO_WALL = resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc');
const CORPUS = resolve(here, '../../../flow-nodes/src/__fixtures__/speckle');
const HOST = 'speckle.example.com';
const PROJECT = 'p5634corpus';

afterEach(() => vi.restoreAllMocks());

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { json: () => JSON.parse(out.join('')) as Record<string, unknown> };
}

/** A Speckle server over the corpus, answering the three object-loader requests. */
async function serveCorpus() {
  const objects = JSON.parse(await readFile(join(CORPUS, 'objects.json'), 'utf-8')) as Array<{ id: string }>;
  const byId = new Map(objects.map((o) => [o.id, o]));
  const latest = await readFile(join(CORPUS, 'graphql-latest.json'), 'utf-8');
  const urls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.pathname === '/graphql') return new Response(latest, { status: 200 });
    const single = /^\/objects\/[^/]+\/([0-9a-f]+)\/single$/.exec(url.pathname);
    if (single) return new Response(JSON.stringify(byId.get(single[1])), { status: 200 });
    const ids = JSON.parse((JSON.parse(String(init?.body)) as { objects: string }).objects) as string[];
    return new Response(ids.map((id) => `${id}\t${JSON.stringify(byId.get(id))}`).join('\n'), { status: 200 });
  });
  return { spy, urls };
}

function graph(capabilities: string[]) {
  return {
    flowVersion: 1, id: 'speckle', name: 'speckle', capabilities, inputs: [],
    outputs: [{ nodeId: 'rx', port: 'entities', label: 'Received' }],
    nodes: [
      { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } },
      { id: 'first', type: 'core.first' },
      { id: 'rx', type: 'speckle.receive', params: { url: `https://${HOST}/projects/${PROJECT}/models/m1` } },
    ],
    edges: [
      { from: ['storeys', 'entities'], to: ['first', 'items'] },
      { from: ['first', 'item'], to: ['rx', 'storey'] },
    ],
  };
}

describe('flow run: speckle.receive into a real model (#5634)', () => {
  it('writes the corpus as IFC elements with their Speckle property sets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-speckle-'));
    const graphPath = join(dir, 'speckle.flow.json');
    const outPath = join(dir, 'out.ifc');
    await writeFile(graphPath, JSON.stringify(graph(['model.read', 'model.create', `network.fetch:${HOST}`])));
    const server = await serveCorpus();
    const c = capture();
    await flowCommand(['run', graphPath, HELLO_WALL, '--out', outPath, '--json']);
    expect((c.json() as { ok: boolean }).ok).toBe(true);
    expect(server.urls.every((u) => u.startsWith(`https://${HOST}/`))).toBe(true);
    vi.restoreAllMocks();

    const { bim } = await createHeadlessContext(outPath);
    const byType = (t: string) => bim.query().byType(t).toArray().filter((e) => e.name.includes(':'));
    expect(byType('IfcWall').map((e) => e.name)).toEqual(['Basic Wall: Generic - 200mm', 'Basic Wall: Generic - 200mm']);
    expect(byType('IfcSlab').map((e) => e.name)).toEqual(['Floor: Concrete 250mm']);
    expect(byType('IfcColumn')).toHaveLength(1);
    expect(byType('IfcBeam')).toHaveLength(1);
    expect(byType('IfcRoof')).toHaveLength(1);

    const wall = byType('IfcWall')[0];
    const psets = bim.properties(wall.ref);
    expect(findPropertyInSets(psets, 'Speckle_TypeParameters', 'Width')?.value).toBe(0.2);
    expect(findPropertyInSets(psets, 'Speckle_Source', 'ElementId')?.value).toBe('300101');
    expect(findPropertyInSets(psets, 'Speckle_InstanceParameters', 'Area')?.value).toBe(18);

    // The 6 m wall is extruded 3 m high from a 200 mm thick profile: millimetres became metres.
    const step = await readFile(outPath, 'utf-8');
    expect(step).toMatch(/IFCRECTANGLEPROFILEDEF\(\.AREA\.,\$,#\d+,6\.,0\.2\)/);
  });

  it('refuses the receive when the graph never granted the Speckle host, before any request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-speckle-'));
    const graphPath = join(dir, 'speckle.flow.json');
    await writeFile(graphPath, JSON.stringify(graph(['model.read', 'model.create'])));
    const server = await serveCorpus();
    const c = capture();
    // A failed lane may end the process with a non-zero code; keep the test process alive either way.
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await flowCommand(['run', graphPath, HELLO_WALL, '--json']).catch((err: unknown) => {
      if (!(err instanceof Error && err.message === 'exit')) throw err;
    });
    expect(server.spy).not.toHaveBeenCalled();
    expect(JSON.stringify(c.json())).toMatch(/network\.fetch refused: host \\"speckle\.example\.com\\"/);
  });
});
