/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openModel, HeadlessSessionClosedError, UnsupportedOperationError, HeadlessBackend } from '../headless.js';
import type { PlanBox } from '@ifc-lite/create';
import { IfcQuery } from '@ifc-lite/query';
import { parseModel } from '@ifc-lite/parser';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

describe('headless developer workflow (DX2)', () => {
  it('queries, edits, exports and reopens through the supported SDK entry point', async () => {
    const model = await openModel(readFileSync(sample), { modelId: 'authoring', modelName: 'source.ifc', disableWorkerScan: true });
    try {
      expect(model.report.completeness).toBe('complete');
      const wall = model.bim.query().byType('IfcWall').toArray()[0];
      expect(wall.ref.modelId).toBe('authoring');
      const originalId = wall.globalId;
      model.bim.mutate.setProperty(wall.ref, 'Pset_WallCommon', 'FireRating', 'REI 120');
      expect(model.bim.property(wall.ref, 'Pset_WallCommon', 'FireRating')).toBe('REI 120');
      const exported = model.bim.export.ifc();
      const reopened = await parseModel(typeof exported === 'string' ? new TextEncoder().encode(exported) : exported, { disableWorkerScan: true });
      const node = new IfcQuery(reopened.store).entity(wall.ref.expressId);
      expect(node.globalId).toBe(originalId);
      expect(node.property('Pset_WallCommon', 'FireRating')).toBe('REI 120');
    } finally { model.close(); }
  });

  it('refuses reads and edits through retained references after an idempotent close', async () => {
    const model = await openModel(readFileSync(sample), { disableWorkerScan: true });
    const query = model.bim.query().byType('IfcWall');
    const wall = query.toArray()[0];
    const mutate = model.bim.mutate;
    model.close();
    model.close();
    expect(() => query.toArray()).toThrow(HeadlessSessionClosedError);
    expect(() => mutate.setProperty(wall.ref, 'Pset_WallCommon', 'FireRating', 'REI 90'))
      .toThrow(HeadlessSessionClosedError);
    expect(() => model.bim.model.list()).toThrow(HeadlessSessionClosedError);
  });

  it('keeps identical EXPRESS ids in separate model sessions isolated', async () => {
    const first = await openModel(readFileSync(sample), { modelId: 'first', disableWorkerScan: true });
    const second = await openModel(readFileSync(sample), { modelId: 'second', disableWorkerScan: true });
    try {
      const a = first.bim.query().byType('IfcWall').toArray()[0];
      const b = second.bim.query().byType('IfcWall').toArray()[0];
      expect(a.ref.expressId).toBe(b.ref.expressId);
      expect(() => second.bim.query().model('first').count()).toThrow(/belongs to model/);
      expect(second.bim.query().model('second').byType('IfcWall').count()).toBe(1);
      expect(() => second.bim.entity(a.ref)).toThrow(/belongs to model/);
      expect(() => second.bim.properties(a.ref)).toThrow(/belongs to model/);
      expect(() => second.bim.store.removeEntity(a.ref)).toThrow(/belongs to model/);
      expect(second.bim.entity(b.ref)?.globalId).toBe(b.globalId);
      expect(second.bim.query().byType('IfcWall').count()).toBe(1);
    } finally { first.close(); second.close(); }
  });

  it('refuses an in-flight host geometry result after the session closes', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<ReadonlyMap<number, PlanBox>>(resolve => { release = () => resolve(new Map()); });
    const sampleBuilding = new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url);
    const model = await openModel(readFileSync(sampleBuilding), { disableWorkerScan: true, backend: {
      alignGeometry: async () => { entered(); return blocked; },
    } });
    try {
      const walls = model.bim.query().byType('IfcWall').toArray();
      const owner = model.bim.storey(walls[0].ref);
      expect(owner).not.toBeNull();
      const sameFloor = walls.filter(wall => model.bim.storey(wall.ref)?.ref.expressId === owner?.ref.expressId);
      expect(sameFloor.length).toBeGreaterThan(1);
      const pending = model.bim.store.alignElements('model', sameFloor[0].ref.expressId, [sameFloor[1].ref.expressId], 'left');
      await Promise.race([started, pending.then(() => { throw new Error('Align completed before its host preparation'); })]);
      model.close();
      release();
      await expect(pending).rejects.toBeInstanceOf(HeadlessSessionClosedError);
    } finally { model.close(); release(); }
  });

  it('reports supported data operations and refuses unavailable viewer calls explicitly', async () => {
    const model = await openModel(readFileSync(sample), { disableWorkerScan: true });
    try {
      expect(model.capability('query.entities').supported).toBe(true);
      expect(model.capability('mutate.setProperty').supported).toBe(true);
      expect(model.capability('export.ifc').supported).toBe(true);
      expect(model.capability('store.addDoor').supported).toBe(false);
      expect(model.capability('viewer.colorize').supported).toBe(false);
      expect(model.capability('store.roomCommand').supported).toBe(false);
      const wall = model.bim.query().byType('IfcWall').toArray()[0];
      expect(() => model.bim.viewer.colorize([wall.ref], '#ff0000')).toThrow(UnsupportedOperationError);
      try { model.bim.viewer.colorize([wall.ref], '#ff0000'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'UNSUPPORTED_OPERATION', operation: 'viewer.colorize' });
      }
      // @ts-expect-error A misspelled backend operation is not a declared capability.
      model.capability('query.entites');
    } finally { model.close(); }
  });

  it('updates viewer capability when a legacy host attaches and detaches adapters', async () => {
    const loaded = await parseModel(readFileSync(sample), { disableWorkerScan: true });
    const backend = new HeadlessBackend(loaded.store, 'sample.ifc', 'sample');
    const colors: unknown[] = [];
    expect(backend.capability('viewer.colorize').supported).toBe(false);
    backend.attachStreamingAdapters({ ...backend.viewer, colorize: (...args) => { colors.push(args); } }, backend.visibility);
    expect(backend.capability('viewer.colorize').supported).toBe(true);
    backend.viewer.colorize([{ modelId: 'sample', expressId: 1 }], [1, 0, 0, 1]);
    expect(colors).toHaveLength(1);
    backend.detachStreamingAdapters();
    expect(backend.capability('viewer.colorize').supported).toBe(false);
    backend.dispose();
  });

  const fzk = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  it.skipIf(!existsSync(fzk))('reads five doors from the independently authored FZK fixture (pnpm fixtures)', async () => {
    const model = await openModel(readFileSync(fzk), { disableWorkerScan: true });
    try {
      expect(model.bim.query().byType('IfcDoor').count()).toBe(5);
      expect(model.report.completeness).toBe('complete');
    } finally { model.close(); }
  });
});
