/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addWallToStore, addOpeningToStore, resolveSpatialAnchor, placedBodyExtent, resolveHostAnchor } from '@ifc-lite/create';
// Existing viewer entrypoint survives a production revert, allowing the
// canonical oracle to observe the same real-fixture geometry assertions.
import { heightRefusal, planCutRefit } from './hosted-opening-refit.js';

it('#6232 rejects nonfinite, reversed and overflowing cut extents without emitting invalid geometry', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../public/samples/hello-wall.ifc', import.meta.url)));
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(dataStore, view);
  const target = { dataStore, view, editor };
  const wall = addWallToStore(editor, resolveSpatialAnchor(dataStore, 42, view), { Start: [0, 10, 0], End: [5, 10, 0], Thickness: .2, Height: 3 }).wallId;
  const opening = addOpeningToStore(editor, resolveHostAnchor(dataStore, wall, view), { Offset: 2, Width: 1, Height: 1 }).openingId;
  const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
  const extents: Array<[number, number]> = [[NaN, 1], [0, Infinity], [-Infinity, 1], [1, -1], [0, 0], [-Number.MAX_VALUE, Number.MAX_VALUE]];
  for (const extent of extents) assert.equal(planCutRefit(target, wall, 1, extent, 1).ok, false);
  for (const scale of [NaN, Infinity, 0, -1, Number.MIN_VALUE]) assert.equal(planCutRefit(target, wall, 1, [-.6, .6], scale).ok, false);
  for (const height of [NaN, Infinity, -Infinity, 0, -1]) assert.notEqual(heightRefusal(target, wall, height, 1), null);
  for (const scale of [NaN, Infinity, 0, -1, Number.MIN_VALUE]) assert.notEqual(heightRefusal(target, wall, 3, scale), null);
  assert.match(heightRefusal(target, wall, .5, 1) ?? '', /reaches above/);
  assert.equal(heightRefusal(target, wall, 3, 1), null);
  assert.deepEqual({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }, before);

  const fit = planCutRefit(target, wall, 1, [-.6, .6], 1);
  if (!fit.ok) throw new Error(fit.reason);
  for (const update of fit.updates) editor.setPositionalAttribute(update.entityId, update.index, update.value);
  const body = placedBodyExtent(dataStore, opening, view)!;
  assert.ok(Math.abs(body.min[1] + .65) < 1e-6);
  assert.ok(Math.abs(body.max[1] - .65) < 1e-6);
});
