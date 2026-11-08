// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addColumnToStore } from './column.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { cloneElementMetadata } from './edit/metadata-clone.js';
import { resolveDuplicateSource } from './resolve-source.js';

async function session() {
  const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const column = addColumnToStore(editor, resolveSpatialAnchor(store, 42, view), { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  return { store, view, editor, column };
}

describe('source relationship lookup #8452', () => {
  it('resolves authored containment without reading unrelated session payloads', async () => {
    const { store, view, editor, column } = await session();
    let visits = 0;
    for (let i = 0; i < 2000; i++) {
      const entity = view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
      Object.defineProperty(entity, 'type', { enumerable: true, get() { visits++; return 'IfcCartesianPoint'; } });
    }
    visits = 0;
    expect(resolveDuplicateSource(store, column.columnId, editor).storeyId).toBe(42);
    expect(visits).toBe(0);
  });

  it('honours positional and named endpoint edits, retypes and deletion', async () => {
    const { store, view, editor, column } = await session();
    const other = editor.addEntity('IfcBuildingStorey', ['guid', null, 'Other', null, null, null, null, null, null, 3]).expressId;
    const material = editor.addEntity('IfcMaterial', ['Concrete']).expressId;
    const rel = editor.addEntity('IfcRelAssociatesMaterial', ['guid', null, null, null, ['#1222'], `#${material}`]).expressId;
    editor.setPositionalAttribute(rel, 4, [`#${column.columnId}`]);
    expect(resolveDuplicateSource(store, column.columnId, editor).associations.some(a => a.relatingExpressId === material)).toBe(true);
    editor.setAttribute(rel, 'RelatedObjects', '#1222');
    // Positional slots win over named edits, as export does.
    expect(resolveDuplicateSource(store, column.columnId, editor).associations.some(a => a.relatingExpressId === material)).toBe(true);
    editor.setPositionalAttribute(column.relContainedId, 5, `#${other}`);
    expect(resolveDuplicateSource(store, column.columnId, editor).storeyId).toBe(other);
    view.setEntityType(rel, 'IfcRelAssociatesDocument', null);
    expect(resolveDuplicateSource(store, column.columnId, editor).associations.some(a => a.relType.toUpperCase() === 'IFCRELASSOCIATESMATERIAL')).toBe(false);
    editor.removeEntity(column.relContainedId);
    expect(resolveDuplicateSource(store, column.columnId, editor).storeyId).toBeNull();
  });
});

it('deleted file-backed containment is filtered by the source graph edge guard #8452', async () => {
  const { store, editor } = await session();
  expect(resolveDuplicateSource(store, 1222, editor).storeyId).toBe(42);
  editor.removeEntity(1223); // Bonsai's actual IfcRelContainedInSpatialStructure.
  expect(resolveDuplicateSource(store, 1222, editor).storeyId).toBeNull();
});


it('metadata cloning visits only candidate authored associations #8452', async () => {
  const { store, view, editor, column } = await session();
  const material = editor.addEntity('IfcMaterial', ['Concrete']).expressId;
  const rel = editor.addEntity('IfcRelAssociatesMaterial', ['guid', null, null, null, [`#${column.columnId}`], `#${material}`]).expressId;
  let visits = 0;
  for (let i = 0; i < 2000; i++) {
    const id = editor.addEntity('IfcRelAssociatesMaterial', ['guid', null, null, null, ['#1222'], `#${material}`]).expressId;
    Object.defineProperty(view.getNewEntity(id)!, 'type', { enumerable: true, get() { visits++; return 'IfcRelAssociatesMaterial'; } });
  }
  const target = addColumnToStore(editor, resolveSpatialAnchor(store, 42, view), { Position: [1, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  visits = 0;
  cloneElementMetadata(store, view, editor, column.columnId, [target.columnId]);
  expect(view.getPositionalMutationsForEntity(rel)?.get(4)).toEqual([`#${column.columnId}`, `#${target.columnId}`]);
  expect(visits).toBe(0);
});
