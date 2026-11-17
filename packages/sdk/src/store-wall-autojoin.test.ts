/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { IfcCreator, addHostedElementInStore, addWallToStore, readWallJoinRels, readWallJoinTarget, resolveSpatialAnchor } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createOrdinaryStoreBackend } from './store-ordinary-backend.js';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

it('#9296 / #9406 adds a wall beside an unreadable hosted opening and reports the skipped implicit join', async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const original = await parse(new TextEncoder().encode(creator.toIfc().content));
  const originalView = new MutablePropertyView(null, 'm');
  const originalEditor = new StoreEditor(original, originalView);
  const anchor = resolveSpatialAnchor(original, level, originalView);
  const host = addWallToStore(originalEditor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3 }).wallId;
  const door = addHostedElementInStore(original, originalEditor, host, { kind: 'door', params: { Offset: 1, Width: .9, Height: 2.1 } });
  // IFC permits an opening without a representation. Load it from STEP so this
  // exercises the same source-entity path as an imported third-party model.
  originalEditor.setPositionalAttribute(door.openingId, 6, null);
  const store = await parse(new StepExporter(original, originalView).export({ schema: 'IFC4', applyMutations: true }).content);
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const resolve = () => ({ modelId: 'm', store, editor, mutationView: view, view, ownerHistoryId: anchor.ownerHistoryId });
  const sdk = new StoreNamespace({ store: {
    ...createOrdinaryStoreBackend(resolve), ...createModellingStoreBackend(resolve),
  } } as unknown as BimBackend);
  const beforeHost = readWallJoinTarget(store, view, host, 1);
  const wall = sdk.addWall('m', level, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: .2, Height: 3 });
  expect(wall).toMatchObject({ modelId: 'm', notices: [expect.stringMatching(/skipped.*join.*unreadable opening geometry/i)] });
  expect(readWallJoinRels(store, view)).toEqual([]);
  expect(readWallJoinTarget(store, view, host, 1)).toEqual(beforeHost);
  const saved = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const reopened = await parse(saved);
  expect(reopened.entityIndex.byType.get('IFCWALL')).toContain(wall.expressId);
  expect(reopened.entityIndex.byType.get('IFCRELVOIDSELEMENT')).toHaveLength(1);
  expect(reopened.entityIndex.byType.get('IFCRELFILLSELEMENT')).toHaveLength(1);
  // The explicit operation still refuses, without changing either wall.
  const beforeJoin = view.getMutations();
  expect(() => sdk.joinWalls('m', host, wall.expressId)).toThrow(/unreadable opening geometry/);
  expect(view.getMutations()).toEqual(beforeJoin);
  const next = sdk.addWall('m', level, { Start: [4, 3, 0], End: [1, 3, 0], Thickness: .2, Height: 3 });
  expect(next.notices).toBeUndefined();
  expect(readWallJoinRels(store, view)).toHaveLength(1);
});
