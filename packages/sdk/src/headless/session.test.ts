/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openModel, HeadlessSessionClosedError } from '../headless.js';
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

  const fzk = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  it.skipIf(!existsSync(fzk))('reads five doors from the independently authored FZK fixture (pnpm fixtures)', async () => {
    const model = await openModel(readFileSync(fzk), { disableWorkerScan: true });
    try {
      expect(model.bim.query().byType('IfcDoor').count()).toBe(5);
      expect(model.report.completeness).toBe('complete');
    } finally { model.close(); }
  });
});
