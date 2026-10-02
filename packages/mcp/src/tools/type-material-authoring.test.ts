/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: real source-local MCP routing, saved IFC and public Undo.
 * The CLI suite separately proves native layers and built sibling parity. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { createModellingStoreBackend, resolveLiveOwnerHistoryId, type EntityRef } from '@ifc-lite/sdk';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport, loadIfcModel,
  type CallToolResult, type LoadedModel } from '../index.js';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const AVAILABLE = existsSync(SAMPLE);
if (!AVAILABLE) console.warn('skip: restore the public Bonsai hello-wall.ifc fixture');
interface Seed { type: number; material: number; set: number; usage: number }
type Bim = LoadedModel['bim'];
const ROUTES: Array<{ name: string; type: string; add: (bim: Bim, modelId: string, seed: Seed) => EntityRef }> = [
  { name: 'addElementType', type: 'IFCWALLTYPE', add: (b, m) => b.store.addElementType(m, { Type: 'IfcWallType', Name: 'Direct MCP wall type', PredefinedType: 'STANDARD' }) },
  { name: 'assignType', type: 'IFCRELDEFINESBYTYPE', add: (b, m, s) => b.store.assignType(m, s.type, [1222]) },
  { name: 'addMaterial', type: 'IFCMATERIAL', add: (b, m) => b.store.addMaterial(m, { Name: 'Direct MCP concrete' }) },
  { name: 'addMaterialLayerSet', type: 'IFCMATERIALLAYERSET', add: (b, m, s) => b.store.addMaterialLayerSet(m, { LayerSetName: 'Direct MCP set', MaterialLayers: [{ Material: s.material, LayerThickness: .2 }] }) },
  { name: 'addMaterialLayerSetUsage', type: 'IFCMATERIALLAYERSETUSAGE', add: (b, m, s) => b.store.addMaterialLayerSetUsage(m, { ForLayerSet: s.set, OffsetFromReferenceLine: -.1 }) },
  { name: 'assignMaterial', type: 'IFCRELASSOCIATESMATERIAL', add: (b, m, s) => b.store.assignMaterial(m, s.usage, [1222]) },
];
async function records(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const).sort((a, b) => a[0] - b[0]);
}
function prepare(model: LoadedModel): Seed {
  // Prepare valid prerequisites through the existing factory, independent of
  // the MCP adapter under test; these prior overlay records must survive Undo.
  const methods = createModellingStoreBackend(() => {
    const editor = model.backend.ensureEditor(), mutationView = editor.getMutationView();
    return { modelId: model.id, store: model.store, editor, mutationView,
      ownerHistoryId: resolveLiveOwnerHistoryId(model.store, editor, mutationView) };
  });
  const type = methods.addElementType(model.id, { Type: 'IfcWallType', Name: 'Prior overlay wall type', PredefinedType: 'STANDARD' }).expressId;
  const material = methods.addMaterial(model.id, { Name: 'Prior overlay concrete' }).expressId;
  const set = methods.addMaterialLayerSet(model.id, { LayerSetName: 'Prior overlay set', MaterialLayers: [{ Material: material, LayerThickness: .2 }] }).expressId;
  const usage = methods.addMaterialLayerSetUsage(model.id, { ForLayerSet: set, OffsetFromReferenceLine: -.1 }).expressId;
  return { type, material, set, usage };
}

describe.skipIf(!AVAILABLE)('#6232 direct MCP type/material routing', () => {
  for (const count of [1, 2]) for (const route of ROUTES) {
    it(`${route.name}: saved IFC and public Undo preserve earlier records with ${count} model(s)`, async () => {
      const registry = new InMemoryModelRegistry();
      for (const modelId of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId }));
      const target = registry.get(count === 2 ? 'beta' : 'alpha')!, seed = prepare(target);
      const peer = count === 2 ? await records(registry.get('alpha')!.bim.export.ifc()) : null;
      const transport = new InProcessTransport();
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      let id = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        const response = await transport.send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
        if (!response || !('result' in response)) throw new Error('Public MCP response missing');
        return response.result as CallToolResult;
      };
      try {
        await transport.send({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Direct D5 route test', version: 'test' } } });
        expect((await call('entity_create', { model_id: target.id, type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] })).isError).not.toBe(true);
        const before = await records(target.bim.export.ifc()), view = target.backend.getMutationView()!;
        const journal = view.getMutations(), overlay = structuredClone(view.getNewEntities());
        const ref = route.add(target.bim, target.id, seed);
        expect(ref.modelId).toBe(target.id);
        const saved = new Map(await records(target.bim.export.ifc()));
        expect(saved.get(ref.expressId)?.type).toBe(route.type);
        if (route.name === 'assignType' || route.name === 'assignMaterial') {
          expect(saved.get(ref.expressId)?.attributes.slice(4)).toEqual([[1222], route.name === 'assignType' ? seed.type : seed.usage]);
          expect([...saved.values()].filter(entity => entity?.type === route.type && Array.isArray(entity.attributes[4]) && entity.attributes[4].includes(1222))).toHaveLength(1);
        }
        expect((await call('mutation_undo', { model_id: target.id })).isError).not.toBe(true);
        expect(await records(target.bim.export.ifc())).toEqual(before);
        expect(view.getMutations()).toEqual(journal);
        expect(view.getNewEntities()).toEqual(overlay);
        if (count === 2) expect(await records(registry.get('alpha')!.bim.export.ifc())).toEqual(peer);
      } finally { transport.close(); }
    });
  }
});
