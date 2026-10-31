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

it('decodes an edited record over a SharedArrayBuffer-backed source (browser TextDecoder rejects shared views)', async () => {
  const file = new Uint8Array(await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const shared = new SharedArrayBuffer(file.byteLength);
  new Uint8Array(shared).set(file);
  const store = await new IfcParser().parseColumnar(shared as unknown as ArrayBuffer, { disableWorkerScan: true });
  expect(store.source.slice(0, 4).buffer).toBeInstanceOf(SharedArrayBuffer);
  // Node's TextDecoder accepts shared views; browsers throw. Model the browser.
  const NodeDecoder = globalThis.TextDecoder;
  class BrowserDecoder extends NodeDecoder {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      if (input && ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
        throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.");
      }
      return super.decode(input, options);
    }
  }
  globalThis.TextDecoder = BrowserDecoder;
  try {
    const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
    const carried = expandAffectedSet(store, view, [1222], 'hostsChanged');
    // An attribute change on the source wall makes the check re-read its record text.
    editor.setPositionalAttribute(1222, 2, 'Renamed');
    expect(editOwnershipRefusal(store, view, [1231], carried)).toBeNull();
  } finally {
    globalThis.TextDecoder = NodeDecoder;
  }
});
