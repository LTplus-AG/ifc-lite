/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: storey authoring over JSON-RPC, real Bonsai source, refusals and one Undo per write. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readStoreyInventory } from '@ifc-lite/create';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { InMemoryModelRegistry } from '../context.js';
import { loadIfcModel } from '../loader.js';
import { MCPServer } from '../server.js';
import { ResourceRegistry } from '../resources/index.js';
import { PromptRegistry } from '../prompts/index.js';
import { InProcessTransport } from '../transport/in-process.js';
import { buildDefaultToolRegistry } from './index.js';
import type { CallToolResult } from '../protocol/index.js';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

async function session(readOnly = false) {
  const registry = new InMemoryModelRegistry();
  registry.add(await loadIfcModel(SAMPLE, { modelId: 'alpha' }));
  const server = new MCPServer({ version: 'test', registry, tools: buildDefaultToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: readOnly ? readOnlyScope() : fullScope() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Storey test', version: 'test' } } });
  return { registry, async call(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: input } }) as { result?: CallToolResult };
    if (!response.result) throw new Error('Expected tool result');
    return response.result;
  } };
}

describe('#9013 storey tools', () => {
  it('adds a storey from its neighbour, re-levels it, exports it and undoes each step', async () => {
    const { registry, call } = await session();
    const added = await call('storey_add', { reference_storey_express_id: 42, side: 'above' });
    expect(added.isError).not.toBe(true);
    const id = added.structuredContent?.expressId as number;
    expect(added.structuredContent).toMatchObject({ Name: 'Level 2', Elevation: 3 });

    const plan = await call('storey_plan_edit', { storey_express_id: 42, kind: 'floor_height', value: 3.4 });
    expect(plan.structuredContent?.refusals).toEqual([]);
    expect((plan.structuredContent!.storeys as Array<{ expressId: number; to: number }>).map((s) => [s.expressId, s.to])).toEqual([[id, 3.4]]);

    expect((await call('storey_edit', { storey_express_id: 42, kind: 'floor_height', value: 3.4 })).isError).not.toBe(true);
    const listed = await call('storey_list');
    expect((listed.structuredContent!.storeys as Array<{ Name: string; elevation: number }>).map((s) => [s.Name, s.elevation]))
      .toEqual([['Level 2', 3.4], ['My Storey', 0]]);

    const saved = registry.get('alpha')!.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const reloaded = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(readStoreyInventory(reloaded, new MutablePropertyView(null, 'r')).storeys.map((s) => [s.Name, s.elevation])).toEqual([['My Storey', 0], ['Level 2', 3.4]]);

    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect(((await call('storey_list')).structuredContent!.storeys as Array<{ elevation: number }>)[0].elevation).toBe(3);
  });

  it('reports a refusal with its reason and writes nothing', async () => {
    const { registry, call } = await session();
    await call('storey_add', { Name: 'Upper', Elevation: 3 });
    const view = registry.get('alpha')!.backend.getMutationView()!;
    const before = structuredClone(view.getMutations());
    const refused = await call('storey_edit', { storey_express_id: 42, kind: 'elevation', value: 5 });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('would pass Upper');
    expect(view.getMutations()).toEqual(before);
    const deleted = await call('storey_delete', { storey_express_id: 42, mode: 'empty' });
    expect(deleted.isError).toBe(true);
    expect(JSON.stringify(deleted.content)).toContain('holds');
  });

  it('keeps writes out of a read-only session but allows the dry runs', async () => {
    const { call } = await session(true);
    expect((await call('storey_list')).isError).not.toBe(true);
    expect((await call('storey_plan_edit', { storey_express_id: 42, kind: 'elevation', value: 1 })).isError).not.toBe(true);
    expect((await call('storey_add', { Name: 'Nope', Elevation: 3 })).isError).toBe(true);
  });
});
