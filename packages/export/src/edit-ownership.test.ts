/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { editOwnershipRefusal } from './edit-ownership.js';
import { expandAffectedSet } from './affected-set.js';

it('#6232 reuses immutable source references while live overlay ownership follows retarget and Undo', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const parsed = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  let scans = 0;
  const byId = new Proxy(parsed.entityIndex.byId, {
    get(target, key) {
      if (key === Symbol.iterator) return function* () { scans++; yield* target; };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = { ...parsed, entityIndex: { ...parsed.entityIndex, byId } };
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const allowed = expandAffectedSet(store, view, [1222], 'hostsChanged');
  scans = 0;
  expect(editOwnershipRefusal(store, view, [1260], allowed)).toBeNull();
  expect(scans).toBe(1);
  const other = editor.addEntity('IfcWall', ['3JUHrTM_j3UxZiBnyBfByx', null, 'Shared', null, null, '#1235', '#1230', null, null]).expressId;
  expect(editOwnershipRefusal(store, view, [1260], allowed)).toContain(`#${other}`);
  editor.setPositionalAttribute(other, 6, null);
  expect(editOwnershipRefusal(store, view, [1260], allowed)).toBeNull();
  view.removePositionalMutation(other, 6);
  expect(editOwnershipRefusal(store, view, [1260], allowed)).toContain(`#${other}`);
  editor.removeEntity(other);
  expect(editOwnershipRefusal(store, view, [1260], allowed)).toBeNull();
  expect(scans).toBe(1);
});

it('#6232 refuses source placement/body leaves shared by another live occurrence, respecting retargets and tombstones', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const carried = expandAffectedSet(store, view, [1222], 'hostsChanged');
  // The real Bonsai wall #1222 owns placement #1235 and body #1230.
  const other = editor.addEntity('IfcWall', ['3JUHrTM_j3UxZiBnyBfByx', null, 'Other occurrence', null, null, '#1235', '#1230', null, null]).expressId;
  expect(editOwnershipRefusal(store, view, [1231], carried)).toContain(`#${other}`);
  expect(editOwnershipRefusal(store, view, [1260], carried)).toContain(`#${other}`);
  expect(editOwnershipRefusal(store, view, [1231, 1260], new Set([...carried, other]))).toBeNull();

  // A numeric coordinate matching a source id is not an entity reference.
  const point = editor.addEntity('IfcCartesianPoint', [[1231, 0, 0]]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, '#1232', '#1233']).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', ['#65', `#${axis}`]).expressId;
  editor.setPositionalAttribute(other, 5, `#${placement}`);
  expect(editOwnershipRefusal(store, view, [1231], carried)).toBeNull();
  expect(editOwnershipRefusal(store, view, [1260], carried)).toContain(`#${other}`);
  editor.removeEntity(other);
  expect(editOwnershipRefusal(store, view, [1231, 1260], carried)).toBeNull();
});
