/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { readWallJoinRels, readWallJoinTarget } from './wall-join-read.js';
import { splitElementInStore } from './element-split.js';
import { readAttributes, resolvePlacementChain } from './edit/placement-core.js';
import { meshStairs as meshProducts, stairMeshBounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

// Actual Bonsai source plus a stated unit metamorph; mm is not a second vendor fixture.
const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const cases = [1, .001].flatMap(scale => [false, true].flatMap(persisted => ['nested', 'root'].flatMap(frame => ['start', 'end'].map(join => ({ scale, persisted, frame, join })))));
it.skipIf(!stairWasmAvailable).each(cases)('#6232 joined Split preserves offset/rotated parent, scale=$scale persisted=$persisted frame=$frame join=$join (pnpm build:wasm)', async ({ scale, persisted, frame, join }) => {
  let source = await readFile(sample, 'utf8');
  if (scale === .001) source = source.replace('.LENGTHUNIT.,$,.METRE.', '.LENGTHUNIT.,.MILLI.,.METRE.');
  let store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  expect(anchor.lengthUnitScale).toBe(scale);
  const target = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: .2, Height: 3, Axis: true }).wallId;
  const neighbour = addWallToStore(editor, anchor, { Start: join === 'start' ? [0, -3, 0] : [8, 0, 0], End: join === 'start' ? [0, 0, 0] : [8, 3, 0], Thickness: .2, Height: 3, Axis: true }).wallId;
  const point = editor.addEntity('IfcCartesianPoint', [[20 / scale, -7 / scale, 2 / scale]]).expressId;
  const z = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const x = editor.addEntity('IfcDirection', [[Math.SQRT1_2, Math.SQRT1_2, 0]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${z}`, `#${x}`]).expressId;
  const parent = editor.addEntity('IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, `#${axis}`]).expressId;
  const expectedParent = frame === 'nested' ? parent : null;
  for (const id of [target, neighbour]) {
    const placement = resolvePlacementChain(store, view, editor, id)!;
    editor.setPositionalAttribute(placement.localPlacementId, 0, expectedParent === null ? null : `#${expectedParent}`);
  }
  joinWallsInStore(editor, store, resolveWallJoinAnchor(store, view), target, neighbour);
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  }
  const snapshot = () => structuredClone({ text: text(), records: view.getNewEntities(), journal: view.getMutations() });
  const parentRecords = () => structuredClone([parent, axis, point, x, z].map(id => readAttributes(store, view, editor, id)));
  const parentBefore = parentRecords();
  const before = snapshot(), next = view.peekNextExpressId(), nativeBefore = await meshProducts(text());
  expect(nativeBefore.get(target)?.length).toBeGreaterThan(0);
  expect(nativeBefore.get(neighbour)?.length).toBeGreaterThan(0);
  // A retained start join exposes wrong-world geometry; an end join must migrate
  // to the added piece without a false 'not placed in the same frame' refusal.
  const result = recordCompoundMutation(view, draft => splitElementInStore(store, new StoreEditor(store, draft), target, { kind: 'wall', distance: 6 }));
  const nativeAfter = await meshProducts(text());
  const actual = stairMeshBounds([...nativeAfter.get(target)!, ...nativeAfter.get(result.addedId)!]);
  const expected = stairMeshBounds(nativeBefore.get(target)!);
  for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++) expect(actual[edge][i]).toBeCloseTo(expected[edge][i], 4);
  expect(readWallJoinTarget(store, view, result.addedId, scale)?.parentPlacementId).toBe(expectedParent);
  expect(parentRecords()).toEqual(parentBefore);
  expect(nativeAfter.get(neighbour)).toEqual(nativeBefore.get(neighbour));
  const rels = readWallJoinRels(store, view, new Set([target, result.addedId, neighbour]));
  expect(rels).toHaveLength(1);
  const connected = join === 'start' ? target : result.addedId;
  expect(new Set([rels[0].relatingId, rels[0].relatedId])).toEqual(new Set([connected, neighbour]));
  // Preserve unrelated imported products and the old parent record.
  for (const [id, meshes] of nativeBefore) if (id !== target && id !== neighbour) expect(nativeAfter.get(id)).toEqual(meshes);
  undoRecordedMutationOperations(view, 1, () => { throw new Error('Joined Split must record one compound'); });
  expect(snapshot()).toEqual(before);
  expect(view.peekNextExpressId()).toBeGreaterThan(next);
  expect(await meshProducts(text())).toEqual(nativeBefore);
});
