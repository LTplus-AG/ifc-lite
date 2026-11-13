/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { fullScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { loadIfcModelFromBytes } from '../loader.js';
import { entityCreate } from './entity-create.js';

afterEach(() => vi.restoreAllMocks());

for (const count of [16, 64]) it(`#9406 MCP raw creation maintains endpoints across ${count} walls without rebuilding on the first ordinary add`, async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const model = await loadIfcModelFromBytes(new TextEncoder().encode(creator.toIfc().content), 'wall-index.ifc', 'm');
  const registry = new InMemoryModelRegistry();
  registry.add(model);
  const ctx = { registry, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER,
    signal: new AbortController().signal, config: DEFAULT_CONFIG };
  const anchor = resolveSpatialAnchor(model.store, level);
  // Drive the real raw tool synchronously while the canonical builder emits
  // its complete graph. The subsequent ordinary call must reuse its index.
  const writer = { addEntity: (type: string, attributes: Parameters<StoreEditor['addEntity']>[1]) => {
    const result = entityCreate.handler({ model_id: model.id, type, attributes }, ctx);
    if (result instanceof Promise) throw new Error('Raw builder requires synchronous entity_create');
    const expressId = result.structuredContent?.expressId;
    if (typeof expressId !== 'number') throw new Error('Raw tool did not create its entity');
    return { expressId };
  } } as unknown as StoreEditor;
  const params = (i: number) => ({ Start: [i * 10, 0, 0] as [number, number, number],
    End: [i * 10 + 4, 0, 0] as [number, number, number], Height: 3, Thickness: .2 });
  const previous = new Set<number>();
  for (let i = 0; i < count; i++) previous.add(addWallToStore(writer, anchor, params(i)).wallId);
  const read = vi.spyOn(MutablePropertyView.prototype, 'readNewEntity');
  model.bim.store.addWall(model.id, level, params(count));
  expect(read.mock.calls.filter(([id]) => previous.has(id))).toHaveLength(0);
  // Positive control: the raw wall must still join when its endpoint matches.
  model.bim.store.addWall(model.id, level, { Start: [4, 0, 0], End: [4, 3, 0], Height: 3, Thickness: .2 });
  expect(model.bim.query().byType('IfcRelConnectsPathElements').toArray()).toHaveLength(1);
});
