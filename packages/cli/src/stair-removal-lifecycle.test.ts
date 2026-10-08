/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: assembly ownership, shared shapes and atomic refusal on actual Bonsai IFC. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { createBimContext, type ModellingStoreBackendMethods } from '@ifc-lite/sdk';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import { AnchorEntityReader } from '../../create/src/in-store/resolve-anchor.js';
import { meshStairs, stairWasmAvailable } from '../../create/src/in-store/__test__/stair-mesh.oracle.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && stairWasmAvailable;
const PARAMS = { Position: [1, 2, 0] as [number, number, number], NumberOfRisers: 4,
  RiserHeight: .2, TreadLength: .3, Width: 1, Name: 'Owned stair' };
async function data(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  return [...parsed.entityIndex.byId].map(([id, location]) => {
    const record = extractor.extractEntity(location);
    if (!record) throw new Error(`Missing actual IFC record #${id}`);
    return [id, record] as const;
  }).sort((a, b) => a[0] - b[0]);
}
async function made(dense = false) {
  const source = readFileSync(SAMPLE, 'utf8');
  // A real parsed dense geometry/property domain. These numeric coordinates
  // deliberately collide with possible product IDs; they are not references.
  const added = Array.from({ length: 4096 }, (_, i) => `#${20000 + i}=IFCCARTESIANPOINT((42.,${i}.,0.));`).join('\n');
  async function loadDense() {
    const directory = await mkdtemp(join(tmpdir(), 'ifc-lite-d5-dense-stair-'));
    try {
      const path = join(directory, 'dense-bonsai.ifc');
      await writeFile(path, source.replace('ENDSEC;\nEND-ISO', `${added}\nENDSEC;\nEND-ISO`));
      return await loadIfcModel(path, { modelId: 'm' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const loaded = dense ? await loadDense() : await loadIfcModel(SAMPLE, { modelId: 'm' });
  const { bim, backend } = loaded;
  bim.store.addEntity('m', { type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
  const ref = bim.store.addStair('m', 42, PARAMS);
  const records = await data(bim.export.ifc());
  const relationship = records.find(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === ref.expressId);
  const parts = relationship?.[1].attributes[5];
  if (!relationship || !Array.isArray(parts) || typeof parts[0] !== 'number') throw new Error('Missing real stair aggregation');
  const flightId = parts[0];
  const flight = records.find(([id]) => id === flightId)![1];
  return { ...loaded, ref, flightId, aggregateId: relationship[0], flightShape: flight.attributes[6], view: backend.getOrCreateMutationView() };
}

describe.skipIf(!AVAILABLE)('#6232 canonical stair assembly lifecycle', () => {
  for (const control of ['duplicate root', 'shared flight', 'foreign product'] as const) {
    it(`${control} refuses before IFC, journal or allocator changes`, async () => {
      const m = await made();
      if (control === 'duplicate root') {
        m.bim.store.addEntity('m', { type: 'IfcRelAggregates', attributes: ['1kTvXnbbzCWw8lcMd1dR4o', null, null, null, `#${m.ref.expressId}`, [`#${m.flightId}`]] });
      } else if (control === 'shared flight') {
        const other = m.bim.store.addStair('m', 42, { ...PARAMS, Position: [5, 2, 0] });
        const rel = (await data(m.bim.export.ifc())).find(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === other.expressId)!;
        m.backend.ensureEditor().setPositionalAttribute(rel[0], 5, [`#${m.flightId}`]);
      } else {
        const column = m.bim.store.addColumn('m', 42, { Position: [5, 2, 0], Width: .2, Depth: .2, Height: 3 });
        m.backend.ensureEditor().setPositionalAttribute(column.expressId, 6, `#${m.flightId}`);
      }
      const before = await data(m.bim.export.ifc()), journal = m.view.getMutations(), next = m.view.peekNextExpressId();
      expect(() => m.bim.store.replaceElement(m.ref, 42, { kind: 'railing', params: { Path: [[0, 0, 0], [2, 0, 0]], Height: 1 } }))
        .toThrow(control === 'duplicate root' ? /must aggregate exactly one live IfcStairFlight/
          : control === 'shared flight' ? /belongs to another assembly/ : /foreign product #\d+\.Representation references/);
      expect(await data(m.bim.export.ifc())).toEqual(before);
      expect(m.view.getMutations()).toEqual(journal);
      expect(m.view.peekNextExpressId()).toBe(next);
      expect(() => m.bim.store.removeStair(m.ref)).toThrow(control === 'duplicate root'
        ? /must aggregate exactly one live IfcStairFlight/ : control === 'shared flight'
          ? /belongs to another assembly/ : /foreign product #\d+\.Representation references/);
      expect(await data(m.bim.export.ifc())).toEqual(before);
      expect(m.view.getMutations()).toEqual(journal);
      expect(m.view.peekNextExpressId()).toBe(next);
    });
  }
  for (const type of ['IFCRELAGGREGATES', 'IFCWALL'] as const) {
    it(`an indexed but unreadable live ${type} refuses the whole pair`, async () => {
      const m = await made();
      const id = m.store.entityIndex.byType.get(type)![0];
      const location = m.store.entityIndex.byId.get(id)!;
      // Stated boundary invariant: a stale source/index handoff advertises a
      // live row but its actual resident bytes no longer decode. Exercise the
      // real source accessor/extractor, never a reader returning a mocked null.
      m.store.source.materialize()[location.byteOffset] = '?'.charCodeAt(0);
      expect(new AnchorEntityReader(m.store, m.view).entity(id)).toBeNull();
      const bytes = m.store.source.materialize().slice(), journal = m.view.getMutations();
      const records = m.view.getNewEntities(), next = m.view.peekNextExpressId();
      expect(() => m.bim.store.replaceElement(m.ref, 42, { kind: 'railing', params: { Path: [[0, 0, 0], [2, 0, 0]], Height: 1 } }))
        .toThrow(/live (IfcRelAggregates|product) #\d+ cannot be read/);
      expect(() => m.bim.store.removeStair(m.ref)).toThrow(/live (IfcRelAggregates|product) #\d+ cannot be read/);
      expect(m.view.getMutations()).toEqual(journal);
      expect(m.view.getNewEntities()).toEqual(records);
      expect(m.view.isDeleted(m.ref.expressId)).toBe(false);
      expect(m.view.isDeleted(m.flightId)).toBe(false);
      expect(m.view.peekNextExpressId()).toBe(next);
      expect(m.store.source.materialize()).toEqual(bytes);
    });
  }
  it('replacement resolves the current source placement and refuses before removing the old pair', async () => {
    const m = await made();
    m.bim.store.setPositionalAttribute({ modelId: 'm', expressId: 42 }, 5, null);
    const before = await data(m.bim.export.ifc()), journal = m.view.getMutations(), next = m.view.peekNextExpressId();
    expect(() => m.bim.store.replaceElement(m.ref, 42, { kind: 'stair', params: PARAMS }))
      .toThrow('resolveSpatialAnchor: storey #42 has no resolvable IfcLocalPlacement');
    expect(await data(m.bim.export.ifc())).toEqual(before);
    expect(m.view.getMutations()).toEqual(journal); expect(m.view.peekNextExpressId()).toBe(next);
  });
  it('retains shared shape leaves, numeric non-reference collisions and dense parsed geometry', async () => {
    const m = await made(true);
    expect(m.store.entityIndex.byType.get('IFCCARTESIANPOINT')!.length).toBeGreaterThan(4096);
    const column = m.bim.store.addColumn('m', 42, { Position: [0, 0, 0], Width: .2, Depth: .2, Height: 3 });
    if (typeof m.flightShape !== 'number' || !Number.isInteger(m.flightShape)) throw new Error('Missing saved shape reference');
    m.backend.ensureEditor().setPositionalAttribute(column.expressId, 6, `#${m.flightShape}`);
    m.backend.ensureEditor().setPositionalAttribute(42, 9, m.flightId);
    const before = await data(m.bim.export.ifc());
    const bytes = m.bim.export.ifc();
    const nativeBefore = await meshStairs(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
    expect(nativeBefore.get(column.expressId)?.length).toBeGreaterThan(0);
    expect(m.bim.store.removeStair(m.ref)).toBe(true);
    const after = await data(m.bim.export.ifc());
    const retained = before.filter(([id, e]) => id !== m.ref.expressId && id !== m.flightId
      && e.type !== 'IFCRELAGGREGATES' && e.type !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(after.filter(([id]) => retained.some(([old]) => old === id))).toEqual(retained);
    expect(after.some(([id]) => id === m.ref.expressId || id === m.flightId)).toBe(false);
    const exported = m.bim.export.ifc();
    const nativeAfter = await meshStairs(typeof exported === 'string' ? exported : new TextDecoder().decode(exported));
    expect(nativeAfter.get(column.expressId)).toEqual(nativeBefore.get(column.expressId));
    expect(nativeAfter.has(m.flightId)).toBe(false);
  });
  for (const count of [1, 2]) it(`public Undo/${count} restores a removed complete native assembly and prior journal`, async () => {
    const m = await made(), registry = new InMemoryModelRegistry();
    registry.add(m);
    const peer = count === 2 ? await loadIfcModel(SAMPLE, { modelId: 'peer' }) : null;
    if (peer) registry.add(peer);
    const peerData = peer ? await data(peer.bim.export.ifc()) : null;
    const before = await data(m.bim.export.ifc()), journal = m.view.getMutations();
    const exported = m.bim.export.ifc();
    const native = await meshStairs(typeof exported === 'string' ? exported : new TextDecoder().decode(exported));
    expect(m.bim.store.removeStair(m.ref)).toBe(true);
    const transport = new InProcessTransport();
    try {
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 removal', version: 'test' } } });
      const response = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mutation_undo', arguments: { model_id: 'm' } } });
      if (!response || !('result' in response)) throw new Error(`Missing public Undo response: ${JSON.stringify(response)}`);
      expect((response.result as CallToolResult).isError).not.toBe(true);
      expect(await data(m.bim.export.ifc())).toEqual(before);
      expect(m.view.getMutations()).toEqual(journal);
      const restored = m.bim.export.ifc();
      expect(await meshStairs(typeof restored === 'string' ? restored : new TextDecoder().decode(restored))).toEqual(native);
      if (peer) expect(await data(peer.bim.export.ifc())).toEqual(peerData);
    } finally { transport.close(); }
  });
  it('an existing third-party backend without optional capabilities refuses clearly', async () => {
    const m = await made();
    // Omission is structurally assignable: the new capabilities are optional.
    const old: Omit<ModellingStoreBackendMethods, 'addStair' | 'addRailing' | 'removeStair' | 'replaceElement'> = m.backend.store;
    const compatible: ModellingStoreBackendMethods = old;
    const store = { ...m.backend.store, ...compatible, addStair: undefined, addRailing: undefined, removeStair: undefined, replaceElement: undefined };
    const backend = Object.assign(Object.create(Object.getPrototypeOf(m.backend)), m.backend, { store }) as typeof m.backend;
    const bim = createBimContext({ backend });
    const before = await data(m.bim.export.ifc());
    expect(() => bim.store.addStair('m', 42, PARAMS)).toThrow('bim.store.addStair is not supported by this backend');
    expect(() => bim.store.addRailing('m', 42, { Path: [[0, 0, 0], [2, 0, 0]], Height: 1 })).toThrow('bim.store.addRailing is not supported by this backend');
    expect(() => bim.store.removeStair(m.ref)).toThrow('bim.store.removeStair is not supported by this backend');
    expect(() => bim.store.replaceElement(m.ref, 42, { kind: 'stair', params: PARAMS })).toThrow('bim.store.replaceElement is not supported by this backend');
    expect(await data(m.bim.export.ifc())).toEqual(before);
  });
});
