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
import { addWindowToStore } from './window.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const ANCHOR = { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 };

describe('addWindowToStore', () => {
  it('emits IfcWindow with OverallHeight/OverallWidth + IFC4 PredefinedType + default PartitioningType + null UserDefinedPartitioningType', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);

    const result = addWindowToStore(editor, ANCHOR, { Position: [1, 2, 0], Width: 0.9, Height: 1.2 });

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const win = byId.get(result.windowId);
    expect(win?.type).toBe('IfcWindow');
    expect(win?.attributes[8]).toBe(1.2); // OverallHeight
    expect(win?.attributes[9]).toBe(0.9); // OverallWidth
    expect(win?.attributes[10]).toBe('.NOTDEFINED.'); // PredefinedType
    expect(win?.attributes[11]).toBe('.NOTDEFINED.'); // PartitioningType (default)
    expect(win?.attributes[12]).toBeNull(); // UserDefinedPartitioningType
  });

  it('drops the IFC4 attribute tail for IFC2X3', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addWindowToStore(
      editor,
      { ...ANCHOR, schema: 'IFC2X3' },
      { Position: [0, 0, 0], Width: 0.9, Height: 1.2 },
    );
    const win = view.getNewEntities().find((e) => e.expressId === result.windowId);
    // 8 IfcRoot/IfcProduct attrs + OverallHeight + OverallWidth = 10.
    expect(win?.attributes).toHaveLength(10);
  });

  it('rejects non-positive dimensions', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(10), view);
    expect(() => addWindowToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, axisContextId: 5, storeyId: 3, storeyPlacementId: 4 },
      { Position: [0, 0, 0], Width: 0, Height: 1.2 },
    )).toThrow(/positive/);
  });

  it('passes through a valid IfcWindowTypePartitioningEnum token unchanged', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addWindowToStore(editor, ANCHOR, {
      Position: [0, 0, 0], Width: 0.9, Height: 1.2, PartitioningType: 'DOUBLE_PANEL_VERTICAL',
    });
    const win = view.getNewEntities().find((e) => e.expressId === result.windowId);
    expect(win?.attributes[11]).toBe('.DOUBLE_PANEL_VERTICAL.');
    expect(win?.attributes[12]).toBeNull();
  });

  it('normalises an out-of-enum PartitioningType to USERDEFINED and records the original value', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addWindowToStore(editor, ANCHOR, {
      Position: [0, 0, 0], Width: 0.9, Height: 1.2, PartitioningType: 'LOUVERED_SASH',
    });
    const win = view.getNewEntities().find((e) => e.expressId === result.windowId);
    expect(win?.attributes[11]).toBe('.USERDEFINED.');
    expect(win?.attributes[12]).toBe('LOUVERED_SASH');
  });

  it('leaves an already-USERDEFINED PartitioningType as USERDEFINED and honours the explicit UserDefinedPartitioningType', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addWindowToStore(editor, ANCHOR, {
      Position: [0, 0, 0], Width: 0.9, Height: 1.2,
      PartitioningType: 'USERDEFINED', UserDefinedPartitioningType: 'Bespoke sash',
    });
    const win = view.getNewEntities().find((e) => e.expressId === result.windowId);
    expect(win?.attributes[11]).toBe('.USERDEFINED.');
    expect(win?.attributes[12]).toBe('Bespoke sash');
  });

  it('leaves an already-USERDEFINED PartitioningType without a label as null, not the enum token', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(40), view);
    const result = addWindowToStore(editor, ANCHOR, {
      Position: [0, 0, 0], Width: 0.9, Height: 1.2, PartitioningType: 'USERDEFINED',
    });
    const win = view.getNewEntities().find((e) => e.expressId === result.windowId);
    expect(win?.attributes[11]).toBe('.USERDEFINED.');
    expect(win?.attributes[12]).toBeNull();
  });
});
