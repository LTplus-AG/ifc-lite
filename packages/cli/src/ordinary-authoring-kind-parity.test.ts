/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: all eight existing ordinary SDK methods use real CLI and
 * MCP backends. Flow element-spec nodes expose four of these kinds. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { createBimContext, type EntityRef } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import { HeadlessBackend } from './headless-backend.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && existsSync(WASM);
if (!AVAILABLE) console.warn('skip: restore public Bonsai hello-wall.ifc and run pnpm build:wasm');
type Bim = ReturnType<typeof createBimContext>;
interface Kind {
  type: string; add: (bim: Bim, modelId: string) => EntityRef;
  centre: readonly number[]; size: readonly number[];
}
const KINDS: Kind[] = [
  { type: 'IFCWALL', add: (b, m) => b.store.addWall(m, 42, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 }), centre: [2, 5, 1.5], size: [4, .2, 3] },
  { type: 'IFCCOLUMN', add: (b, m) => b.store.addColumn(m, 42, { Position: [1, 2, 0], Width: .3, Depth: .4, Height: 3 }), centre: [1, 2, 1.5], size: [.3, .4, 3] },
  { type: 'IFCSLAB', add: (b, m) => b.store.addSlab(m, 42, { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: .2 }), centre: [3, 3.5, .1], size: [4, 3, .2] },
  { type: 'IFCBEAM', add: (b, m) => b.store.addBeam(m, 42, { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 }), centre: [2, 0, 3], size: [4, .2, .4] },
  { type: 'IFCSPACE', add: (b, m) => b.store.addSpace(m, 42, { Position: [1, 2, 0], Width: 4, Depth: 3, Height: 3 }), centre: [3, 3.5, 1.5], size: [4, 3, 3] },
  { type: 'IFCROOF', add: (b, m) => b.store.addRoof(m, 42, { Position: [1, 2, 3], Width: 4, Depth: 3, Thickness: .2 }), centre: [3, 3.5, 3.1], size: [4, 3, .2] },
  { type: 'IFCPLATE', add: (b, m) => b.store.addPlate(m, 42, { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: .02 }), centre: [3, 3.5, .01], size: [4, 3, .02] },
  { type: 'IFCMEMBER', add: (b, m) => b.store.addMember(m, 42, { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 }), centre: [2, 0, 3], size: [4, .2, .4] },
];
let api: IfcAPI | undefined;
beforeAll(() => { if (AVAILABLE) { initSync({ module: readFileSync(WASM) }); api = new IfcAPI(); } });
afterAll(() => api?.free());
function bytes(content: string | Uint8Array) { return typeof content === 'string' ? new TextEncoder().encode(content) : content; }
async function parsed(content: string | Uint8Array) {
  const data = bytes(content);
  return new IfcParser().parseColumnar(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}
async function records(content: string | Uint8Array) {
  const store = await parsed(content), extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, ref]) => [id, extractor.extractEntity(ref)] as const).sort((a, b) => a[0] - b[0]);
}
async function assertProducts(content: string | Uint8Array, refs: readonly EntityRef[]) {
  const data = bytes(content), store = await parsed(data), extractor = new EntityExtractor(store.source);
  refs.forEach((ref, i) => {
    expect(store.entityIndex.byType.get(KINDS[i].type)).toContain(ref.expressId);
    const product = extractor.extractEntity(store.entityIndex.byId.get(ref.expressId)!);
    const representation = product?.attributes[6];
    if (typeof representation !== 'number') throw new Error('An ordinary product has no Representation reference');
    expect(extractor.extractEntity(store.entityIndex.byId.get(representation)!)?.type).toBe('IFCPRODUCTDEFINITIONSHAPE');
  });
  if (!api) throw new Error('Native geometry API not initialized');
  const pre = api.buildPrePassOnce(data);
  const boxes = new Map(refs.map(ref => [ref.expressId, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: 0 }]));
  try {
    const offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const meshes = api.processGeometryBatch(data, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes.get(i);
        if (!mesh) continue;
        try {
          const box = boxes.get(mesh.expressId);
          if (!box) continue;
          const positions = mesh.positions, origin = mesh.origin;
          for (let j = 0; j < positions.length; j += 3) {
            const point = [origin[0] + positions[j], -(origin[2] + positions[j + 2]), origin[1] + positions[j + 1]];
            for (let axis = 0; axis < 3; axis++) {
              const value = point[axis] + (pre.needsShift ? offset[axis] : 0);
              box.min[axis] = Math.min(box.min[axis], value); box.max[axis] = Math.max(box.max[axis], value);
            }
            box.vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { meshes.free(); }
  } finally { api.clearPrePassCache(); }
  refs.forEach((ref, i) => {
    const box = boxes.get(ref.expressId)!;
    expect(box.vertices, KINDS[i].type).toBeGreaterThan(0);
    for (let axis = 0; axis < 3; axis++) {
      expect((box.min[axis] + box.max[axis]) / 2, KINDS[i].type).toBeCloseTo(KINDS[i].centre[axis], 4);
      expect(box.max[axis] - box.min[axis], KINDS[i].type).toBeCloseTo(KINDS[i].size[axis], 4);
    }
  });
}

describe.skipIf(!AVAILABLE)('#6232 D5 all ordinary methods on actual loaded backends', () => {
  for (const count of [1, 2]) {
    it(`all eight CLI SDK methods save native physical products with ${count} model(s)`, async () => {
      const contexts = [];
      for (const id of ['alpha', 'beta'].slice(0, count)) {
        const model = await loadIfcModel(SAMPLE, { modelId: id });
        contexts.push({ id, bim: createBimContext({ backend: new HeadlessBackend(model.store, id) }) });
      }
      const target = contexts.at(-1)!, peer = count === 2 ? contexts[0].bim.export.ifc() : null;
      const refs = KINDS.map(kind => kind.add(target.bim, target.id));
      expect(refs.every(ref => ref.modelId === target.id)).toBe(true);
      await assertProducts(target.bim.export.ifc(), refs);
      if (count === 2) expect(contexts[0].bim.export.ifc()).toEqual(peer);
    });
    it(`all eight recorded MCP SDK methods have complete public undo with ${count} model(s)`, async () => {
      const registry = new InMemoryModelRegistry();
      for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
      const target = registry.get(count === 2 ? 'beta' : 'alpha')!, peer = count === 2 ? registry.get('alpha')!.bim.export.ifc() : null;
      const transport = new InProcessTransport();
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      let id = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        const response = await transport.send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
        if (!response || !('result' in response)) throw new Error('Public MCP response missing');
        return response.result as CallToolResult;
      };
      try {
        await transport.send({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 eight-kind parity', version: 'test' } } });
        const prior = await call('entity_create', { model_id: target.id, type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
        expect(prior.isError).not.toBe(true);
        const before = await records(target.bim.export.ifc()), journal = target.backend.getMutationView()!.getMutations();
        const refs: EntityRef[] = [], snapshots = [before];
        for (const kind of KINDS) {
          refs.push(kind.add(target.bim, target.id));
          snapshots.push(await records(target.bim.export.ifc()));
        }
        await assertProducts(target.bim.export.ifc(), refs);
        // Diagnostic before narrowing any Undo comparison: identical source
        // and authored overlay must survive two consecutive read-only exports.
        const view = target.backend.getMutationView()!;
        const known = new Set([...before.map(([expressId]) => expressId), ...view.getNewEntities().map(entity => entity.expressId)]);
        const overlay = structuredClone(view.getNewEntities()), history = structuredClone(view.getMutations());
        const first = await records(target.bim.export.ifc()), second = await records(target.bim.export.ifc());
        expect(second.filter(([expressId]) => known.has(expressId))).toEqual(first.filter(([expressId]) => known.has(expressId)));
        expect(view.getNewEntities()).toEqual(overlay);
        expect(view.getMutations()).toEqual(history);
        const generated = (saved: typeof first) => saved.filter(([expressId]) => !known.has(expressId));
        console.info('D5 identical-state repeated-export diagnostic', JSON.stringify({ models: count,
          recordCounts: [first.length, second.length], knownRecordCount: first.filter(([expressId]) => known.has(expressId)).length,
          rawEqual: JSON.stringify(first) === JSON.stringify(second),
          generated: [generated(first), generated(second)] }));
        // Compound history retains raw records; its public contract is one
        // Undo operation per builder, restoring every helper and relationship.
        for (let i = 7; i >= 0; i--) {
          expect((await call('mutation_undo', { model_id: target.id })).isError).not.toBe(true);
          expect(await records(target.bim.export.ifc())).toEqual(snapshots[i]);
        }
        expect(await records(target.bim.export.ifc())).toEqual(before);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(journal);
        if (count === 2) expect(registry.get('alpha')!.bim.export.ifc()).toEqual(peer);
      } finally { transport.close(); }
    });
  }
});
