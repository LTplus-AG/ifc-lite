/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addDoorToStore } from './door.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addDoorToStore', () => {
  it('emits IfcDoor with OverallHeight/OverallWidth + IFC4 PredefinedType + OperationType + UserDefinedOperationType', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);

    const result = addDoorToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [1, 2, 0], Width: 0.9, Height: 2.1 },
    );

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const door = byId.get(result.doorId);
    expect(door?.type).toBe('IfcDoor');
    expect(door?.attributes[8]).toBe(2.1);  // OverallHeight
    expect(door?.attributes[9]).toBe(0.9);  // OverallWidth
    expect(door?.attributes[10]).toBe('.NOTDEFINED.');
    expect(door?.attributes[11]).toBe('.SINGLE_SWING_LEFT.');
    expect(door?.attributes[12]).toBeNull();  // UserDefinedOperationType
  });

  it('drops the IFC4 attribute tail for IFC2X3', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addDoorToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54, schema: 'IFC2X3' },
      { Position: [0, 0, 0], Width: 0.9, Height: 2.1 },
    );
    const door = view.getNewEntities().find((e) => e.expressId === result.doorId);
    // 8 IfcRoot/IfcProduct attrs + OverallHeight + OverallWidth = 10.
    expect(door?.attributes).toHaveLength(10);
  });

  it('rejects non-positive dimensions', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(10), view);
    expect(() => addDoorToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Position: [0, 0, 0], Width: 0, Height: 2.1 },
    )).toThrow(/positive/);
  });
});
