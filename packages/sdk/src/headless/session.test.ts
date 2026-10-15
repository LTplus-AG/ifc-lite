/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openModel, HeadlessSessionClosedError, UnsupportedOperationError, HeadlessBackend } from '../headless.js';
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
    backend.viewer.colorize([{ modelId: 'sample', expressId: 1 }], '#ff0000');
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
