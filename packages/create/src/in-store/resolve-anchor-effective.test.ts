/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addColumnToStore } from './column.js';

// Bonsai/IfcOpenShell IFC4 sample, with one parsed storey (#42).
const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

async function session() {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

describe('resolveSpatialAnchor over live entities (#5249)', () => {
  it('rejects a deleted source storey and authors a column on an overlay-created storey', async () => {
    const { store, view, editor } = await session();
    expect(resolveSpatialAnchor(store, 42, view).storeyId).toBe(42);
    expect(editor.removeEntity(42)).toBe(true);
    expect(() => resolveSpatialAnchor(store, 42, view)).toThrow(/storey #42/);

    const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
    const storey = editor.addEntity('IfcBuildingStorey', [
      '0Storey000000000000003', null, 'New Level', null, null,
      null, null, null, '.ELEMENT.', 0,
    ]).expressId;
    editor.setPositionalAttribute(storey, 5, `#${placement}`);

    const anchor = resolveSpatialAnchor(store, storey, view);
    expect(anchor.storeyId).toBe(storey);
    expect(anchor.storeyPlacementId).toBe(placement);
    const column = addColumnToStore(editor, anchor, {
      Position: [1, 2, 0], Width: 0.3, Depth: 0.4, Height: 3,
    });
    expect(editor.getNewEntity(column.columnId)?.type).toBe('IfcColumn');
    expect(editor.getNewEntities().some((entity) =>
      entity.type === 'IfcRelContainedInSpatialStructure'
      && entity.attributes.some((value) => value === `#${storey}`),
    )).toBe(true);
  });

  it('does not return a placement that the overlay deleted or retyped away', async () => {
    const { store, view, editor } = await session();
    const placement = resolveSpatialAnchor(store, 42, view).storeyPlacementId;
    expect(editor.removeEntity(placement)).toBe(true);
    expect(() => resolveSpatialAnchor(store, 42, view)).toThrow(/IfcLocalPlacement/);
  });

  it('honours named placement edits and positional clearing before authoring', async () => {
    const { store, view, editor } = await session();
    const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
    view.setAttribute(42, 'ObjectPlacement', `#${placement}`);
    expect(resolveSpatialAnchor(store, 42, view).storeyPlacementId).toBe(placement);

    view.setPositionalAttribute(42, 5, null);
    expect(() => resolveSpatialAnchor(store, 42, view)).toThrow(/IfcLocalPlacement/);
  });

  it('uses live OwnerHistory and representation context after source candidates are removed', async () => {
    const { store, view, editor } = await session();
    for (const { expressId } of iterateEffectiveEntityIds(store, view, [
      'IFCOWNERHISTORY',
      'IFCGEOMETRICREPRESENTATIONCONTEXT',
      'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    ])) {
      expect(editor.removeEntity(expressId)).toBe(true);
    }
    const ownerHistoryId = editor.addEntity('IfcOwnerHistory', []).expressId;
    const contextId = editor.addEntity('IfcGeometricRepresentationContext', [
      'Model', 'Model', 3, null, null, null,
    ]).expressId;

    const anchor = resolveSpatialAnchor(store, 42, view);
    expect(anchor.ownerHistoryId).toBe(ownerHistoryId);
    expect(anchor.bodyContextId).toBe(contextId);
    expect(anchor.axisContextId).toBe(contextId);
    const column = addColumnToStore(editor, anchor, {
      Position: [1, 2, 0], Width: 0.3, Depth: 0.4, Height: 3,
    });
    expect(editor.getNewEntity(column.columnId)?.attributes[1]).toBe(`#${ownerHistoryId}`);
    expect(editor.getNewEntities().some((entity) =>
      entity.type === 'IfcShapeRepresentation'
      && entity.attributes[0] === `#${contextId}`,
    )).toBe(true);
  });
});
