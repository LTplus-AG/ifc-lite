/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: actual SDK/public MCP stair and railing geometry in native schema/unit frames. */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { EntityExtractor, getSchemaRegistryForVersion, IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport, loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import type { FlowDocument } from '@ifc-lite/flow';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../create/src/in-store/__test__/stair-mesh.oracle.js';
import { HeadlessBackend } from './headless-backend.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && stairWasmAvailable;
let directory: string | undefined;
beforeAll(async () => { if (AVAILABLE) directory = await mkdtemp(join(tmpdir(), 'ifc-lite-d5-stair-schema-')); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function saved(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  const rows = [...parsed.entityIndex.byId].map(([id, location]) => {
    const entity = extractor.extractEntity(location);
    if (!entity) throw new Error(`Missing saved record #${id}`);
    return [id, entity] as const;
  }).sort((a, b) => a[0] - b[0]);
  return { parsed, rows };
}
function document(kind: 'stair' | 'railing', invalid = false): FlowDocument {
  return { flowVersion: 2, id: 'schema', name: 'D5 schema', capabilities: ['model.read', 'model.create'], inputs: [], outputs: [],
    nodes: [...(kind === 'stair' ? [{ id: 'zero', type: 'core.number', params: { value: 0 } }, { id: 'position', type: 'geometry.point' }] : []), { id: 'all', type: 'model.byType', params: { type: 'IfcBuildingStorey' } }, { id: 'first', type: 'core.first' },
      { id: 'spec', type: `element.${kind}`, params: kind === 'stair'
        ? { NumberOfRisers: invalid ? 0 : 4, RiserHeight: .2, TreadLength: .3, Width: 1, Direction: Math.PI / 2 }
        : { Path: [[0, 2, 0], [2, 2, 0]], Height: 1.1, RailDiameter: .1, PostDiameter: .1, PostSpacing: invalid ? 0 : 1 } },
      { id: 'add', type: 'model.addElement', trackingKey: invalid ? 'invalid' : 'valid' }],
    edges: [...(kind === 'stair' ? [{ from: ['zero', 'value'] as const, to: ['position', 'x'] as const }, { from: ['zero', 'value'] as const, to: ['position', 'y'] as const }, { from: ['position', 'point'] as const, to: ['spec', 'Position'] as const }] : []), { from: ['all', 'entities'], to: ['first', 'items'] }, { from: ['first', 'item'], to: ['spec', 'storey'] },
      { from: ['spec', 'spec'], to: ['add', 'spec'] }] };
}

describe.skipIf(!AVAILABLE)('#6232 schema-aware SDK/public run_flow stair and railing parity', () => {
  for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const mm of [false, true]) {
    for (const kind of ['stair', 'railing'] as const) for (const route of ['SDK', 'MCP'] as const) {
      it(`${Schema}/${mm ? 'mm/N' : 'm/1'}/${route}: ${kind} keeps metre bounds, official slots and refusal/Undo`, async () => {
        if (!directory) throw new Error('Fixture directory not initialized');
        const creator = new IfcCreator({ Schema, LengthUnit: mm ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
        const storey = creator.addIfcBuildingStorey({ Name: 'Level', Elevation: 0 });
        const path = join(directory, `${Schema}-${kind}-${route}-${mm}.ifc`);
        await writeFile(path, creator.toIfc().content);
        const registry = new InMemoryModelRegistry(), target = await loadIfcModel(path, { modelId: 'target' });
        registry.add(target);
        const peer = mm ? await loadIfcModel(SAMPLE, { modelId: 'peer' }) : null;
        if (peer) registry.add(peer);
        const peerData = peer ? (await saved(peer.bim.export.ifc())).rows : null;
        const backend = route === 'SDK' ? new HeadlessBackend(target.store, target.id) : null;
        const bim = backend ? createBimContext({ backend }) : target.bim;
        const add = (type: string, attributes: unknown[]) => bim.store.addEntity(target.id, { type, attributes }).expressId;
        const k = mm ? 1000 : 1;
        const point = add('IfcCartesianPoint', [[10 * k, 20 * k, 2 * k]]), axis = add('IfcDirection', [[0, 0, 1]]), x = add('IfcDirection', [[0, 1, 0]]);
        const frame = add('IfcAxis2Placement3D', [`#${point}`, `#${axis}`, `#${x}`]);
        const placement = add('IfcLocalPlacement', [null, `#${frame}`]);
        bim.store.setPositionalAttribute({ modelId: target.id, expressId: storey }, 5, `#${placement}`);
        add('IfcCartesianPoint', [[7, 8, 9]]);
        const before = (await saved(bim.export.ifc())).rows;
        const transport = new InProcessTransport();
        let request = 0;
        try {
          await transport.connect(createMCPServer({ registry, scope: fullScope() }));
          await transport.send({ jsonrpc: '2.0', id: ++request, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 schema', version: 'test' } } });
          const call = async (name: string, args: Record<string, unknown>) => {
            const response = await transport.send({ jsonrpc: '2.0', id: ++request, method: 'tools/call', params: { name, arguments: args } });
            if (!response || !('result' in response)) throw new Error(`Missing public response ${JSON.stringify(response)}`);
            return response.result as CallToolResult;
          };
          if (route === 'MCP') expect((await call('run_flow', { model_id: target.id, flow: document(kind) })).isError).not.toBe(true);
          else if (kind === 'stair') bim.store.addStair(target.id, storey, { Position: [0, 0, 0], Direction: Math.PI / 2, NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1 });
          else bim.store.addRailing(target.id, storey, { Path: [[0, 2, 0], [2, 2, 0]], Height: 1.1, RailDiameter: .1, PostDiameter: .1, PostSpacing: 1 });
          const bytes = bim.export.ifc(), output = await saved(bytes), map = new Map(output.rows);
          expect(output.parsed.schemaVersion).toBe(Schema);
          expect(output.parsed.lengthUnitScale).toBe(1 / k);
          const product = output.rows.find(([id, e]) => e.type === (kind === 'stair' ? 'IFCSTAIR' : 'IFCRAILING') && !before.some(([old]) => old === id))!;
          expect(product).toBeDefined();
          const schema = getSchemaRegistryForVersion(Schema);
          expect(product[1].attributes.length).toBe(schema.entities[kind === 'stair' ? 'IfcStair' : 'IfcRailing'].allAttributes!.length);
          let meshId = product[0];
          if (kind === 'stair') {
            const aggregate = output.rows.filter(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === product[0]);
            expect(aggregate).toHaveLength(1);
            const parts = aggregate[0][1].attributes[5];
            if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0] !== 'number') throw new Error('Missing actual flight');
            meshId = parts[0];
            const flight = map.get(meshId)!, attrs = schema.entities.IfcStairFlight.allAttributes!;
            expect(flight.attributes).toHaveLength(attrs.length);
            for (const [name, value] of [[Schema === 'IFC2X3' ? 'NumberOfRiser' : 'NumberOfRisers', 4], ['NumberOfTreads', 4], ['RiserHeight', .2 * k], ['TreadLength', .3 * k]] as const) {
              expect(flight.attributes[attrs.findIndex(a => a.name === name)]).toBeCloseTo(value, 8);
            }
          }
          const native = (await meshStairs(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))).get(meshId);
          expect(native?.length).toBeGreaterThan(0);
          const box = stairMeshBounds(native!);
          const min = kind === 'stair' ? [8.8, 19, 2] : [7.95, 19.95, 2];
          const max = kind === 'stair' ? [10, 20, 2.8] : [8.05, 22.05, 3.1];
          for (let axis = 0; axis < 3; axis++) { expect(box.min[axis]).toBeCloseTo(min[axis], 4); expect(box.max[axis]).toBeCloseTo(max[axis], 4); }
          const view = backend ? backend.tableAccess(target.id).mutationView : target.backend.getOrCreateMutationView();
          if (!view) throw new Error('Missing live view');
          const journal = view.getMutations(), next = view.peekNextExpressId();
          if (route === 'MCP') expect((await call('run_flow', { model_id: target.id, flow: document(kind, true) })).isError).toBe(true);
          else expect(() => kind === 'stair' ? bim.store.addStair(target.id, storey, { Position: [0, 0, 0], NumberOfRisers: 0, RiserHeight: .2, TreadLength: .3, Width: 1 })
            : bim.store.addRailing(target.id, storey, { Path: [[0, 0, 0], [2, 0, 0]], Height: 1, PostSpacing: 0 })).toThrow();
          expect((await saved(bim.export.ifc())).rows).toEqual(output.rows);
          expect(view.getMutations()).toEqual(journal); expect(view.peekNextExpressId()).toBe(next);
          if (route === 'MCP') {
            expect((await call('mutation_undo', { model_id: target.id })).isError).not.toBe(true);
            expect((await saved(bim.export.ifc())).rows).toEqual(before);
          }
          if (peer) expect((await saved(peer.bim.export.ifc())).rows).toEqual(peerData);
        } finally { transport.close(); }
      });
    }
  }
});
