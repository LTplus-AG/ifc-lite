/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { editOwnershipRefusal, effectiveReferencers } from './edit-ownership.js';
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

it('#9013 an edited deferred property atom keeps its references in the live lookup', async () => {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    '#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    "#2=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(1.),#1);",
    "#3=IFCPROPERTYSET('2O2Fr$t4X7Zf8NOew3FLOH',$,'Pset_Test',$,(#2));",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true, deferPropertyAtomIndex: true });
  expect(store.deferredEntityIndex?.has(2), 'the property atom is deferred out of the primary index').toBe(true);
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  expect(effectiveReferencers(store, view)(1)).toEqual([2]);
  editor.setPositionalAttribute(2, 0, 'Breadth');
  expect(effectiveReferencers(store, view)(1), 'renaming the atom does not drop its unit reference').toEqual([2]);
  editor.setPositionalAttribute(2, 3, null);
  expect(effectiveReferencers(store, view)(1), 'clearing its unit does').toEqual([]);
  editor.setPositionalAttribute(2, 3, '#13');
  expect(effectiveReferencers(store, view)(13), 'a new source reference is indexed even without a baseline edge').toEqual([2]);
});

it('#8452 ownership lookup does not serialize unrelated authored records', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  let visits = 0;
  for (let i = 0; i < 2000; i++) {
    const entity = view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
    view.setPositionalAttribute(entity.expressId, 0, [i + 1, 0, 0], true);
    Object.defineProperty(entity, 'type', { enumerable: true, get() { visits++; return 'IfcCartesianPoint'; } });
  }
  const other = editor.addEntity('IfcWall', ['guid', null, 'Shared', null, null, '#1235', '#1230', null, null]).expressId;
  visits = 0;
  expect(effectiveReferencers(store, view)(1230)).toContain(other);
  expect(visits).toBe(0);
  editor.setAttribute(other, 'Name', '#999');
  expect(effectiveReferencers(store, view)(999), 'a quoted Name is not a STEP reference').not.toContain(other);
});
