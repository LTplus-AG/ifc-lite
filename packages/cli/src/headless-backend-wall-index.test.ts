/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from './headless-backend.js';

afterEach(() => vi.restoreAllMocks());

for (const count of [16, 64]) it(`#9406 CLI first ordinary wall after ${count} raw walls does not reread unrelated geometry`, async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const bytes = new TextEncoder().encode(creator.toIfc().content);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const bim = createBimContext({ backend: new HeadlessBackend(store, 'wall-index.ifc') });
  const S = bim.store, M = bim.model.activeId()!;
  const anchor = resolveSpatialAnchor(store, level);
  const writer = { addEntity: (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) =>
    S.addEntity(M, { type, attributes }) } as unknown as StoreEditor;
  const params = (i: number) => ({ Start: [i * 10, 0, 0] as [number, number, number],
    End: [i * 10 + 4, 0, 0] as [number, number, number], Height: 3, Thickness: .2 });
  const previous = new Set<number>();
  for (let i = 0; i < count; i++) previous.add(addWallToStore(writer, anchor, params(i)).wallId);
  const read = vi.spyOn(MutablePropertyView.prototype, 'readNewEntity');
  S.addWall(M, level, params(count));
  expect(read.mock.calls.filter(([id]) => previous.has(id))).toHaveLength(0);
  // Positive control: maintaining the lookup must still find a raw wall's end.
  S.addWall(M, level, { Start: [4, 0, 0], End: [4, 3, 0], Height: 3, Thickness: .2 });
  expect(bim.query().byType('IfcRelConnectsPathElements').toArray()).toHaveLength(1);
});
