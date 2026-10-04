/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIfcModel } from '../loader.js';
import { deriveSplitGlobalId } from '../../../create/src/in-store/edit/split-guid.js';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { placedBodyExtent, readWallJoinTarget, readWallJoinRels } from '@ifc-lite/create';
import { AnchorEntityReader } from '../../../create/src/in-store/resolve-anchor.js';
import { liveToolSession } from '../test/live-tool-session.js';

async function graph(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => {
    const entity = extractor.extractEntity(location)!;
    return { id, type: entity.type, attributes: entity.attributes };
  }).sort((a, b) => a.id - b.id);
}

// #6232 D5: real public protocol -> recorded shared SDK operation -> physical
// source graph; identical source ids in peer models expose accidental routing.
describe('#6232 physical command protocol', () => {
  for (const count of [1, 2]) {
    it(`moves a real imported wall, refuses its unsupported profile and sizes an authored wall with Undo (${count} models)`, async () => {
      const { registry, call } = await liveToolSession(count);
      const target = count === 1 ? 'alpha' : 'beta';
      const model = registry.get(target)!, peer = count === 2 ? registry.get('alpha')! : null;
      const before = model.bim.export.ifc(), peerBefore = peer?.bim.export.ifc();
      const view = model.backend.ensureEditor().getMutationView();
      const extent = () => placedBodyExtent(model.store, 1222, view)!;
      const original = extent();
      expect(original.max[2] - original.min[2]).toBeGreaterThan(2);
      const moved = await call('edit_element_geometry', { model_id: target, operation: { kind: 'transform', express_ids: [1222], transform: { kind: 'move', delta: [0, 2] } } });
      expect(moved.isError).not.toBe(true);
      expect(extent().min[1]).toBeCloseTo(original.min[1] + 2);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      const sized = await call('edit_element_geometry', { model_id: target, operation: { kind: 'size', express_id: 1222, patch: { kind: 'wall', Height: 4 } } });
      // The real Bonsai wall uses IfcArbitraryClosedProfileDef. The strict
      // shared viewer policy refuses this profile instead of guessing slots.
      expect(sized.isError).toBe(true);
      expect(sized.structuredContent?.message).toContain('simple IfcRectangleProfileDef');
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      const supported = model.bim.store.addWall(target, 42, { Start: [0, 30, 0], End: [5, 30, 0], Thickness: .2, Height: 3 });
      const beforeSize = await graph(model.bim.export.ifc());
      const height = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'size', express_id: supported.expressId, patch: { kind: 'wall', Height: 4 } } });
      expect(height.isError, JSON.stringify(height)).not.toBe(true);
      const changed = placedBodyExtent(model.store, supported.expressId, view)!;
      expect(changed.max[2] - changed.min[2]).toBeCloseTo(4);
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(beforeSize);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
    });
  }
  for (const count of [1, 2]) {
    it(`rotates an authored wall about its picked pivot and moves both joined endpoints with Undo (${count} models)`, async () => {
      const { registry, call } = await liveToolSession(count);
      const target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
      const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = peer?.bim.export.ifc();
      const first = model.bim.store.addWall(target, 42, { Start: [0, 10, 0], End: [5, 10, 0], Thickness: .2, Height: 3 });
      const second = model.bim.store.addWall(target, 42, { Start: [5, 10, 0], End: [5, 14, 0], Thickness: .2, Height: 3 });
      model.bim.store.joinWalls(target, first.expressId, second.expressId);
      const view = model.backend.getMutationView()!;
      const read = (id: number) => readWallJoinTarget(model.store, view, id, 1)!;
      const before = model.bim.export.ifc();
      const endpoint = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'wall_endpoints', express_id: first.expressId, start: [0, 10, 0], end: [6, 11, 0] } });
      expect(endpoint.isError).not.toBe(true);
      expect(read(first.expressId).wall.end).toEqual([6, 11]);
      expect(read(second.expressId).wall.start).toEqual([6, 11]);
      expect(readWallJoinRels(model.store, view)).toHaveLength(1);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      const turning = model.bim.store.addWall(target, 42, { Start: [10, 10, 0], End: [15, 10, 0], Thickness: .2, Height: 3 });
      const beforeTurn = model.bim.export.ifc();
      const rotated = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'transform', express_ids: [turning.expressId], transform: { kind: 'rotate', pivot: [10, 10], angle: Math.PI / 2 } } });
      expect(rotated.isError).not.toBe(true);
      expect(read(turning.expressId).wall.start[0]).toBeCloseTo(10);
      expect(read(turning.expressId).wall.end[0]).toBeCloseTo(10);
      expect(read(turning.expressId).wall.end[1]).toBeCloseTo(15);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(beforeTurn));
    });

    it(`splits the larger identity-preserving segment, trims the picked end and undoes each complete graph (${count} models)`, async () => {
      const { registry, call } = await liveToolSession(count);
      const target = count === 1 ? 'alpha' : 'beta', model = registry.get(target)!;
      const peer = count === 2 ? registry.get('alpha')! : null, peerBefore = peer?.bim.export.ifc();
      const wall = model.bim.store.addWall(target, 42, { Start: [0, 20, 0], End: [8, 20, 0], Thickness: .2, Height: 3 });
      const view = model.backend.getMutationView()!, before = model.bim.export.ifc();
      const sourceGlobalId = new AnchorEntityReader(model.store, view).entity(wall.expressId)!.attributes[0];
      const split = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'split', requests: [{ expressId: wall.expressId, cut: { kind: 'wall', distance: 2 } }] } });
      expect(split.isError).not.toBe(true);
      const entities = split.structuredContent?.entities;
      if (!Array.isArray(entities) || entities.length !== 1) throw new Error('Split must return one complete source/left/right identity result');
      const row = entities[0] as { source: { modelId: string; expressId: number }; added: { modelId: string; expressId: number }; left: { modelId: string; expressId: number }; right: { modelId: string; expressId: number } };
      expect(row.right).toEqual(wall); expect(row.source).toEqual(wall);
      expect(row.added).toEqual(row.left); expect(row.left.modelId).toBe(target);
      expect(new AnchorEntityReader(model.store, view).entity(wall.expressId)?.attributes[0]).toEqual(sourceGlobalId);
      expect(readWallJoinTarget(model.store, view, wall.expressId, 1)?.wall.start).toEqual([2, 20]);
      expect(readWallJoinTarget(model.store, view, row.added.expressId, 1)?.wall.end).toEqual([2, 20]);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      const trimmed = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'trim_extend', express_id: wall.expressId, params: { mode: 'trim', click: [7, 20],
          boundary: { a: [5, 19], b: [5, 21], tMin: 0, tMax: 1, reach: 0 } } } });
      expect(trimmed.isError).not.toBe(true);
      expect(readWallJoinTarget(model.store, view, wall.expressId, 1)?.wall.end).toEqual([5, 20]);
      expect(new AnchorEntityReader(model.store, view).entity(wall.expressId)?.attributes[0]).toEqual(sourceGlobalId);
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      const extended = await call('edit_element_geometry', { model_id: target,
        operation: { kind: 'trim_extend', express_id: wall.expressId, params: { mode: 'extend', click: [7, 20],
          boundary: { a: [10, 19], b: [10, 21], tMin: 0, tMax: 1, reach: 0 } } } });
      expect(extended.isError).not.toBe(true);
      expect(readWallJoinTarget(model.store, view, wall.expressId, 1)?.wall.end).toEqual([10, 20]);
      expect((await call('mutation_undo', { model_id: target })).isError).not.toBe(true);
      expect(await graph(model.bim.export.ifc())).toEqual(await graph(before));
      if (peer && peerBefore) expect(await graph(peer.bim.export.ifc())).toEqual(await graph(peerBefore));
    });
  }
  for (const persistedPeer of [false, true]) {
    it(`avoids a split GlobalId already present in a peer ${persistedPeer ? 'source file' : 'live overlay'} and replays it after Undo (#6232)`, async () => {
      const { registry, call } = await liveToolSession(2);
      const target = registry.get('beta')!, peer = registry.get('alpha')!;
      const wall = target.bim.store.addWall('beta', 42, { Start: [0, 40, 0], End: [8, 40, 0], Thickness: .2, Height: 3 });
      const view = target.backend.getMutationView()!;
      const guid = new AnchorEntityReader(target.store, view).entity(wall.expressId)!.attributes[0];
      if (typeof guid !== 'string') throw new Error('Source wall must carry an IFC GlobalId');
      const occupied = deriveSplitGlobalId(guid, () => false);
      const expected = deriveSplitGlobalId(guid, candidate => candidate === occupied);
      peer.bim.store.addWall('alpha', 42, { Start: [0, 50, 0], End: [8, 50, 0], Thickness: .2, Height: 3, GlobalId: occupied });
      const directory = persistedPeer ? await mkdtemp(join(tmpdir(), 'ifc-lite-6232-peer-')) : null;
      try {
        if (directory) {
          const path = join(directory, 'peer.ifc');
          await writeFile(path, peer.bim.export.ifc());
          registry.add(await loadIfcModel(path, { modelId: 'alpha' }));
          expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
          expect(registry.get('alpha')!.store.entities.getExpressIdByGlobalId(occupied)).toBeGreaterThan(0);
        }
        const peerBefore = await graph(registry.get('alpha')!.bim.export.ifc());
        const before = await graph(target.bim.export.ifc());
        const split = async () => {
          const result = await call('edit_element_geometry', { model_id: 'beta', operation: {
            kind: 'split', requests: [{ expressId: wall.expressId, cut: { kind: 'wall', distance: 2 } }] } });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const rows = result.structuredContent?.entities;
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Split must return one identity result');
          const row = rows[0] as { added: { expressId: number }; source: { modelId: string; expressId: number } };
          expect(row.source).toEqual(wall);
          expect(new AnchorEntityReader(target.store, view).entity(row.added.expressId)?.attributes[0]).toEqual(expected);
          expect(new AnchorEntityReader(target.store, view).entity(wall.expressId)?.attributes[0]).toEqual(guid);
          expect(await graph(registry.get('alpha')!.bim.export.ifc())).toEqual(peerBefore);
        };
        await split();
        expect((await call('mutation_undo', { model_id: 'beta' })).isError).not.toBe(true);
        expect(await graph(target.bim.export.ifc())).toEqual(before);
        await split();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('rejects read-only, ambiguous and invalid physical writes without modifying the graph', async () => {
    const { registry, call } = await liveToolSession(2);
    const operation = { kind: 'transform', express_ids: [1222], transform: { kind: 'move', delta: [1, 1] } };
    expect((await call('edit_element_geometry', { operation })).isError).toBe(true);
    const before = registry.get('beta')!.bim.export.ifc();
    expect((await call('edit_element_geometry', { model_id: 'beta', operation: { kind: 'transform', express_ids: [1222, 999999], transform: { kind: 'move', delta: [1, 1] } } })).isError).toBe(true);
    expect(await graph(registry.get('beta')!.bim.export.ifc())).toEqual(await graph(before));
    const readOnly = await liveToolSession(1, true);
    expect((await readOnly.call('edit_element_geometry', { operation })).isError).toBe(true);
  });
});
