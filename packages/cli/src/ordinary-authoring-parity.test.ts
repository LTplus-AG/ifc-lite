/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: public loaded SDK / MCP flow parity, with the real Bonsai file.
 * No fake backend: the SDK control uses this CLI's production HeadlessBackend.
 * IFC export/reparse and native mesh bounds are independent physical witnesses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import {
  createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult,
} from '@ifc-lite/mcp';
import type { FlowDocument } from '@ifc-lite/flow';
import { HeadlessBackend } from './headless-backend.js';

// Committed public sample: FILE_NAME identifies Bonsai 0.8.0 / IfcOpenShell 0.8.0.
const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && existsSync(WASM);
if (!AVAILABLE) console.warn('skip: public Bonsai fixture / WASM unavailable; restore hello-wall.ifc and run pnpm build:wasm');
const STOREY = 42;
const PARAMS = { Start: [0, 5, 0] as [number, number, number], End: [4, 5, 0] as [number, number, number], Thickness: 0.2, Height: 3, Name: 'D5 ordinary wall' };
let api: IfcAPI | undefined;

beforeAll(() => {
  if (!AVAILABLE) return;
  initSync({ module: new Uint8Array(readFileSync(WASM)) });
  api = new IfcAPI();
});
afterAll(() => api?.free());

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

async function savedIndex(content: string | Uint8Array) {
  const buffer = bytes(content);
  const parsed = await new IfcParser().parseColumnar(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  return parsed.entityIndex;
}

async function assertSavedWall(content: string | Uint8Array, expressId: number): Promise<void> {
  const buffer = bytes(content);
  const parsed = await new IfcParser().parseColumnar(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  expect(parsed.entityIndex.byType.get('IFCWALL')).toContain(expressId);
  expect(parsed.spatialHierarchy?.elementToStorey.get(expressId)).toBe(STOREY);
  if (!api) throw new Error('Native API was not initialized');
  const pre = api.buildPrePassOnce(buffer);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  try {
    const offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(buffer, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          if (mesh.expressId !== expressId) continue;
          const positions = mesh.positions, origin = mesh.origin;
          for (let j = 0; j < positions.length; j += 3) {
            // Native mesh is Y-up; the public IFC authoring params are Z-up.
            const point = [origin[0] + positions[j], -(origin[2] + positions[j + 2]), origin[1] + positions[j + 1]];
            for (let axis = 0; axis < 3; axis++) {
              const value = point[axis] + (pre.needsShift ? offset[axis] : 0);
              minimum[axis] = Math.min(minimum[axis], value);
              maximum[axis] = Math.max(maximum[axis], value);
            }
            vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); }
  expect(vertices).toBeGreaterThan(0);
  // Source site/building/storey placements are identity. These expected values
  // come from the supplied four-metre wall, not another placement resolver.
  const centre = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const size = minimum.map((value, axis) => maximum[axis] - value);
  for (let axis = 0; axis < 3; axis++) {
    expect(centre[axis]).toBeCloseTo([2, 5, 1.5][axis], 4);
    expect(size[axis]).toBeCloseTo([4, 0.2, 3][axis], 4);
  }
}

function wallFlow(): FlowDocument {
  return {
    flowVersion: 2, id: 'd5-ordinary-wall', name: 'D5 ordinary wall',
    capabilities: ['model.read', 'model.create'], inputs: [],
    outputs: [{ nodeId: 'create', port: 'entity', label: 'Wall' }],
    nodes: [
      { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } },
      { id: 'storey', type: 'core.first' },
      { id: 'zero', type: 'core.number', params: { value: 0 } },
      { id: 'four', type: 'core.number', params: { value: 4 } },
      { id: 'five', type: 'core.number', params: { value: 5 } },
      { id: 'start', type: 'geometry.point' }, { id: 'end', type: 'geometry.point' },
      { id: 'spec', type: 'element.wall', params: { thickness: PARAMS.Thickness, height: PARAMS.Height, name: PARAMS.Name } },
      { id: 'create', type: 'model.addElement', trackingKey: 'd5-wall' },
    ],
    edges: [
      { from: ['storeys', 'entities'], to: ['storey', 'items'] },
      { from: ['storey', 'item'], to: ['spec', 'storey'] },
      { from: ['zero', 'value'], to: ['start', 'x'] }, { from: ['five', 'value'], to: ['start', 'y'] },
      { from: ['four', 'value'], to: ['end', 'x'] }, { from: ['five', 'value'], to: ['end', 'y'] },
      { from: ['start', 'point'], to: ['spec', 'start'] }, { from: ['end', 'point'], to: ['spec', 'end'] },
      { from: ['spec', 'spec'], to: ['create', 'spec'] },
    ],
  };
}

async function session(count: number) {
  const registry = new InMemoryModelRegistry();
  for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
  const transport = new InProcessTransport();
  await transport.connect(createMCPServer({ registry, scope: fullScope() }));
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 ordinary parity', version: 'test' } } });
  return { registry, transport, async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } });
    if (!response || !('result' in response)) throw new Error(`No MCP result: ${JSON.stringify(response)}`);
    return response.result as CallToolResult;
  } };
}

describe.skipIf(!AVAILABLE)('#6232 D5 ordinary loaded SDK / public MCP parity', () => {
  for (const count of [1, 2]) {
    it(`the existing SDK creates the canonical physical wall with ${count} model(s)`, async () => {
      const contexts = [];
      for (const id of ['alpha', 'beta'].slice(0, count)) {
        const model = await loadIfcModel(SAMPLE, { modelId: id });
        contexts.push({ id, bim: createBimContext({ backend: new HeadlessBackend(model.store, id) }) });
      }
      const target = contexts.at(-1)!;
      const peerBefore = count === 2 ? contexts[0].bim.export.ifc() : null;
      const ref = target.bim.store.addWall(target.id, STOREY, { ...PARAMS, GlobalId: '0'.repeat(22) });
      expect(ref.modelId).toBe(target.id);
      await assertSavedWall(target.bim.export.ifc(), ref.expressId);
      if (count === 2) expect(contexts[0].bim.export.ifc()).toEqual(peerBefore);
    });

    it(`a late invalid SDK GlobalId leaves no authored helpers with ${count} model(s)`, async () => {
      const models = [];
      for (const id of ['alpha', 'beta'].slice(0, count)) {
        const model = await loadIfcModel(SAMPLE, { modelId: id });
        models.push({ id, bim: createBimContext({ backend: new HeadlessBackend(model.store, id) }) });
      }
      const target = models.at(-1)!;
      const before = await savedIndex(target.bim.export.ifc());
      const peerBefore = count === 2 ? models[0].bim.export.ifc() : null;
      // productGuid is validated after placement/profile/body emission in the
      // current builder: this exercises an actual late refusal, not a mock.
      expect(() => target.bim.store.addWall(target.id, STOREY, { ...PARAMS, GlobalId: 'invalid' })).toThrow(/valid 22-character IFC GUID/);
      const after = await savedIndex(target.bim.export.ifc());
      expect(after.byId.size).toBe(before.byId.size);
      expect(after.byType.get('IFCLOCALPLACEMENT')).toEqual(before.byType.get('IFCLOCALPLACEMENT'));
      if (count === 2) expect(models[0].bim.export.ifc()).toEqual(peerBefore);
    });

    it(`public run_flow creates the same physical wall and one complete undo with ${count} model(s)`, async () => {
      const { registry, transport, call } = await session(count);
      try {
        const modelId = count === 2 ? 'beta' : 'alpha';
        const target = registry.get(modelId)!;
        const peerBefore = count === 2 ? registry.get('alpha')!.bim.export.ifc() : null;
        const prior = await call('entity_create', { model_id: modelId, type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
        expect(prior.isError).not.toBe(true);
        const before = target.backend.getMutationView()!.getMutations();
        const description = await call('describe_flow', { flow: wallFlow() });
        expect(description.structuredContent?.ok).toBe(true);
        const result = await call('run_flow', { model_id: modelId, flow: wallFlow() });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent?.ok, JSON.stringify(result.structuredContent?.errors)).toBe(true);
        const walls = target.backend.getMutationView()!.getNewEntities().filter(entity => entity.type === 'IfcWall');
        expect(walls).toHaveLength(1);
        await assertSavedWall(target.bim.export.ifc(), walls[0].expressId);
        if (count === 2) expect(registry.get('alpha')!.bim.export.ifc()).toEqual(peerBefore);
        const afterCreation = target.backend.getMutationView()!.getMutations();
        const authoredAfterCreation = structuredClone(target.backend.getMutationView()!.getNewEntities());
        // A different flow id does not create a different tracked occurrence.
        // Preserve the canonical collision guard independently of validation.
        const collision = await call('run_flow', { model_id: modelId, flow: { ...wallFlow(), id: 'd5-collision-wall' } });
        expect(collision.structuredContent?.ok).toBe(false);
        expect(JSON.stringify(collision.structuredContent?.errors)).toMatch(/already exists in the model; change the node's tracking key/);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(afterCreation);
        expect(target.backend.getMutationView()!.getNewEntities()).toEqual(authoredAfterCreation);
        const invalid = wallFlow();
        const invalidResult = await call('run_flow', { model_id: modelId, flow: {
          ...invalid, id: 'd5-invalid-wall',
          nodes: invalid.nodes.map(node => node.id === 'spec' ? { ...node, params: { ...node.params, height: -1 } }
            : node.id === 'create' ? { ...node, trackingKey: 'd5-invalid-wall' } : node),
        } });
        expect(invalidResult.structuredContent?.ok).toBe(false);
        expect(JSON.stringify(invalidResult.structuredContent?.errors)).toMatch(/Thickness and Height must be positive/);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(afterCreation);
        expect(target.backend.getMutationView()!.getNewEntities()).toEqual(authoredAfterCreation);
        expect((await call('mutation_undo', { model_id: modelId })).isError).not.toBe(true);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(before);
        expect(target.backend.getMutationView()!.getNewEntity(prior.structuredContent?.expressId as number)?.type).toBe('IfcCartesianPoint');
      } finally { transport.close(); }
    });
  }
});
