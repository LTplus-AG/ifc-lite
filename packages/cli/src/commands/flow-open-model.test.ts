/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.openFromSource` on the CLI's flow host (#5634): a model downloaded
 * mid-run (from a fake OpenCDE server injected as the network transport)
 * is parsed by the CLI's own loader and becomes the model the following
 * nodes — and the `--out` export — work on.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { createHeadlessContext } from '../loader.js';
import { createCliFlowSession } from './flow-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = resolve(here, '../../../../apps/viewer/public/samples/building-architecture.ifc');
const HELLO_WALL = resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc');
const DOWNLOAD = 'https://files.cde.example/dv/7/hello-wall.ifc';

function grants(...raw: string[]) {
  const r = parseCapabilities(raw);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.value;
}

const graph: FlowDocument = {
  flowVersion: 1, id: 'cde', name: 'cde', capabilities: ['network.fetch:files.cde.example', 'model.create', 'model.read'], inputs: [], outputs: [],
  nodes: [
    { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
    { id: 'dl', type: 'documents.download', params: { url: DOWNLOAD } },
    { id: 'open', type: 'model.openFromSource' },
  ],
  edges: [
    { from: ['dl', 'data'], to: ['open', 'data'] },
    { from: ['dl', 'name'], to: ['open', 'name'] },
    { from: ['open', 'modelId'], to: ['walls', 'modelId'] },
  ],
};

async function session(payload: Uint8Array) {
  const s = createCliFlowSession(await createHeadlessContext(SAMPLE_IFC), grants(...graph.capabilities));
  const served: string[] = [];
  // The CLI host plus a fake CDE; the prototype keeps the session's live getters.
  const host: FlowHost = Object.assign(Object.create(s.host) as FlowHost, {
    networkTransport: async (url: URL) => {
      served.push(url.href);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/x-step' } });
    },
  });
  return { s, host, served };
}

describe('flow run: model.openFromSource on the CLI host', () => {
  it('opens a downloaded IFC, and a model read wired to it sees that model, not the command-line one', async () => {
    const bytes = new Uint8Array(await readFile(HELLO_WALL));
    const { s, host, served } = await session(bytes);
    const before = s.active().bim.query().byType('IfcWall').count();
    expect(before).toBeGreaterThan(1);

    const r = await runFlow(graph, { host, registry: createStandardRegistry(), features: headlessFeatures() });
    expect(r.log.filter((l) => l.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(served).toEqual([DOWNLOAD]);
    const walls = r.outputs.get('walls')?.get('entities');
    expect(walls?.kind === 'list' ? walls.items.map((e) => (e as { globalId: string }).globalId) : null).toEqual(['2JUHrTM_j3UxZiBnyBfByx']);
    // The export `--out` writes comes from the opened model too.
    expect(s.active().store.fileSize).toBe(bytes.byteLength);
    expect(host.bim.query().byType('IfcWall').count()).toBe(1);
  });

  it('fails the node, not the process, when the downloaded file is not IFC', async () => {
    const { s, host } = await session(new TextEncoder().encode('<html>login required</html>'));
    const r = await runFlow(graph, { host, registry: createStandardRegistry(), features: headlessFeatures() });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.nodeId === 'open' && l.level === 'error')?.message).toBe('hello-wall.ifc is not a valid IFC/STEP file');
    expect(s.active().bim.query().byType('IfcWall').count()).toBeGreaterThan(1);
  });
});
