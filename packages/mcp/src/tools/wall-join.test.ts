/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: actual Bonsai model + real builders -> MCP/SDK shared join. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addWallToStore, resolveSpatialAnchor, readWallJoinRels, readWallJoinTarget } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
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
async function session(count = 1, readOnly = false) {
  const registry = new InMemoryModelRegistry();
  const ids = new Map<string, [number, number]>();
  for (const id of ['alpha', 'beta'].slice(0, count)) {
    const model = await loadIfcModel(SAMPLE, { modelId: id });
    registry.add(model);
    const editor = model.backend.ensureEditor();
    const anchor = resolveSpatialAnchor(model.store, 42, editor.getMutationView());
    const a = addWallToStore(editor, anchor, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
    const b = addWallToStore(editor, anchor, { Start: [4, 5, 0], End: [5, 6, 0], Thickness: 0.4, Height: 3, Axis: true }).wallId;
    ids.set(id, [a, b]);
  }
  const server = new MCPServer({ version: 'test', registry, tools: buildDefaultToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: readOnly ? readOnlyScope() : fullScope() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Join test', version: 'test' } } });
  return { registry, ids, transport, async call(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: input } }) as { result?: CallToolResult };
    if (!response.result) throw new Error('Expected MCP tool result');
    return response.result;
  } };
}

describe('#6232 D5 MCP wall joins', () => {
  it('writes exact relationship attributes, replaces a join, exports and restores both complete graphs', async () => {
    const { registry, ids, call } = await session();
    const model = registry.get('alpha')!;
    const view = model.backend.getMutationView()!;
    const [a, b] = ids.get('alpha')!;
    const original = readWallJoinTarget(model.store, view, a, 1)!;
    const before = view.getMutations();
    const input = { a_express_id: a, b_express_id: b, options: { Name: 'Corner', priority: 'b', priorities: { a: [10], b: [20] } } };
    const first = await call('join_walls', input);
    expect(first.isError).not.toBe(true);
    const firstId = first.structuredContent?.expressId as number;
    const rel = view.getNewEntity(firstId)!;
    expect(rel.type).toBe('IfcRelConnectsPathElements');
    expect(rel.attributes[2]).toBe('Corner');
    expect(rel.attributes.slice(5, 9)).toEqual([`#${b}`, `#${a}`, [20], [10]]);
    expect((await call('join_walls', { a_express_id: b, b_express_id: a })).isError).not.toBe(true);
    expect(readWallJoinRels(model.store, view)).toHaveLength(1);
    const saved = model.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const parsed = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    expect(parsed.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS')).toHaveLength(1);
    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect(view.getNewEntity(firstId)?.type).toBe('IfcRelConnectsPathElements');
    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect(readWallJoinRels(model.store, view)).toEqual([]);
    expect(readWallJoinTarget(model.store, view, a, 1)?.profileId).toBe(original.profileId);
    expect(view.getMutations()).toEqual(before);
  });

  it('SDK and MCP both refuse an opening lost at the oblique near face atomically', async () => {
    const { registry, ids, call } = await session();
    const model = registry.get('alpha')!, [a, b] = ids.get('alpha')!;
    expect((await call('place_window', { host_express_id: a, params: { Offset: 3.9, Sill: 1, Width: 0.1, Height: 1 } })).isError).not.toBe(true);
    const before = model.backend.getMutationView()!.getMutations();
    expect(() => model.bim.store.joinWalls('alpha', a, b, { priority: 'b' })).toThrow(/would not fit between the joined end faces/);
    const result = await call('join_walls', { a_express_id: a, b_express_id: b, options: { priority: 'b' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toMatch(/would not fit between the joined end faces/);
    expect(model.backend.getMutationView()!.getMutations()).toEqual(before);
  });

  it('SDK and MCP both refuse missing opening references through the same core', async () => {
    const { registry, ids, call } = await session();
    const model = registry.get('alpha')!, [a, b] = ids.get('alpha')!;
    const editor = model.backend.ensureEditor(), view = editor.getMutationView();
    editor.addEntity('IfcRelVoidsElement', ['broken', null, null, null, `#${a}`, '#999999']);
    const before = view.getMutations();
    expect(() => model.bim.store.joinWalls('alpha', a, b)).toThrow(/unreadable opening geometry/);
    expect((await call('join_walls', { a_express_id: a, b_express_id: b })).isError).toBe(true);
    expect(view.getMutations()).toEqual(before);
    expect(readWallJoinRels(model.store, view)).toEqual([]);
  });

  it('requires the chosen federated model and resolves its overlay-local walls alone', async () => {
    const { registry, ids, call } = await session(2);
    expect(ids.get('alpha')).toEqual(ids.get('beta'));
    const [a, b] = ids.get('beta')!;
    expect((await call('join_walls', { a_express_id: a, b_express_id: b })).structuredContent?.code).toBe('MODEL_REQUIRED');
    expect((await call('join_walls', { model_id: 'beta', a_express_id: a, b_express_id: b })).isError).not.toBe(true);
    expect(readWallJoinRels(registry.get('alpha')!.store, registry.get('alpha')!.backend.getMutationView())).toEqual([]);
    expect(readWallJoinRels(registry.get('beta')!.store, registry.get('beta')!.backend.getMutationView())).toHaveLength(1);
    expect(() => registry.get('beta')!.bim.store.joinWalls('alpha', a, b)).toThrow(/Unknown modelId/);
  });

  it('refuses unsupported bodies and malformed inputs and does not expose joins read-only', async () => {
    const { ids, call } = await session();
    const [a] = ids.get('alpha')!;
    expect((await call('join_walls', { a_express_id: a, b_express_id: 42 })).isError).toBe(true);
    expect((await call('join_walls', { a_express_id: a, b_express_id: a, options: { name: 'alias' } })).isError).toBe(true);
    const readonly = await session(1, true);
    const listed = await readonly.transport.send({ jsonrpc: '2.0', id: 100, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.some(t => t.name === 'join_walls')).toBe(false);
    expect((await readonly.call('join_walls', { a_express_id: a, b_express_id: a })).isError).toBe(true);
  });
});
