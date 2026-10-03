/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addWallToStore } from './wall.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { readWallJoinTarget } from './wall-join-read.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { transformElementsInStore, type StoreyTransformOp } from './element-transform-edit.js';

it('#6232 joined transforms refuse shared neighbour geometry atomically', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const wall = (Start: [number, number, number], End: [number, number, number]) => addWallToStore(editor, anchor, { Start, End, Thickness: .2, Height: 3, Axis: true });
  const a = wall([0, 10, 0], [4, 10, 0]), b = wall([4, 10, 0], [4, 14, 0]);
  joinWallsInStore(editor, store, resolveWallJoinAnchor(store, view), a.wallId, b.wallId);
  const peer = wall([20, 10, 0], [24, 10, 0]);
  const shared = readWallJoinTarget(store, view, b.wallId, 1)!;
  const snapshot = () => structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
  const operations: StoreyTransformOp[] = [{ kind: 'move', delta: [0, 1] }, { kind: 'rotate', pivot: [0, 10], angle: .1 }];
  for (const record of ['shape', 'solid']) {
    editor.setPositionalAttribute(peer.wallId, 6, `#${record === 'shape' ? shared.productShapeId : peer.productShapeId}`);
    editor.setPositionalAttribute(peer.shapeRepId, 3, [`#${record === 'solid' ? shared.solidId : peer.solidId}`]);
    const before = snapshot();
    for (const op of operations) {
      expect(() => editor.runAtomic(draft => transformElementsInStore({ dataStore: store, view: draft.getMutationView(), editor: draft, selected: [a.wallId], op }))).toThrow(/shares placement or geometry/);
      expect(snapshot()).toEqual(before);
    }
  }
});
