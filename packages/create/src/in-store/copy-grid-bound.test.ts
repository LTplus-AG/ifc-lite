/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9026 item 8: an element on a grid crossing is refused in plain language,
 * and nothing is written. What a copy would bind to is an open product decision. */
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcCreator } from '../ifc-creator.js';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { addColumnToStore } from './column.js';
import { copySourcesInStore } from './copy-batch.js';
import { copyProductInStore, copyRefusal, createCopyContext } from './copy-product.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

const asRefId = (value: unknown) => Number(String(value).slice(1));

async function session() {
  const creator = new IfcCreator({ Schema: 'IFC4', Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: 0 });
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(creator.toIfc().content).buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'g');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const grid = addGridToStore(editor, anchor, rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }));
  return { store, editor, anchor, grid, storeyId };
}

const SECTION = { Width: 0.4, Depth: 0.4, Height: 3 };

describe('copying an element on a grid crossing (#9026 item 8)', () => {
  it('refuses a grid column in words a person can read, through every copy entry, writing nothing', async () => {
    const s = await session();
    const { columnId } = addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...SECTION, Position: [6, 4, 0] }, {
      GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]],
    });
    const ctx = createCopyContext(s.store, s.editor);
    const before = s.editor.getNewEntities().length;

    const refusal = copyRefusal(ctx, columnId);
    expect(refusal).toMatch(/grid intersection/);
    expect(refusal).not.toMatch(/#\d/);
    expect(copySourcesInStore(ctx, [columnId])).toEqual({ refusal });
    expect(() => copyProductInStore(ctx, columnId, { offset: [6, 0, 0] })).toThrow(/grid intersection/);
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });

  it('names the grid too when the product points straight at an IfcGridPlacement, with no local child', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [0, 0, 0] });
    const { placementId } = gridIntersectionPlacement(s.editor, s.anchor, {
      Axes: [s.grid.uAxisIds[0], s.grid.vAxisIds[0]], GridPlacementId: s.grid.placementId,
    }, s.store);
    s.editor.setPositionalAttribute(columnId, 5, `#${placementId}`);

    const ctx = createCopyContext(s.store, s.editor);
    expect(copySourcesInStore(ctx, [columnId])).toEqual({ refusal: copyRefusal(ctx, columnId) });
    expect(copyRefusal(ctx, columnId)).toMatch(/grid intersection/);
  });

  for (const shape of ['through a local child', 'straight at the grid placement'] as const) {
    it(`refuses up front when a carried part is grid-bound, ${shape}`, async () => {
      const s = await session();
      const { columnId: root } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [1, 1, 0] });
      const { columnId: part, gridPlacement } = addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...SECTION, Position: [6, 4, 0] }, {
        GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]],
      });
      if (shape === 'straight at the grid placement') s.editor.setPositionalAttribute(part, 5, `#${gridPlacement.placementId}`);
      s.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${root}`, [`#${part}`]]);
      const ctx = createCopyContext(s.store, s.editor);
      const before = s.editor.getNewEntities().length;

      expect(copyRefusal(ctx, root)).toMatch(/grid intersection/);
      const result = copySourcesInStore(ctx, [root]);
      expect(result).toEqual({ refusal: expect.stringMatching(/grid intersection/) });
      expect(() => copyProductInStore(ctx, root, { offset: [6, 0, 0] })).toThrow(/grid intersection/);
      expect(s.editor.getNewEntities()).toHaveLength(before);
    });
  }

  it('leaves a grid column on a storey with no placement copying as before: it has no storey frame to be tied to', async () => {
    const s = await session();
    const { columnId, gridPlacement } = addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...SECTION, Position: [6, 4, 0] }, {
      GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]],
    });
    s.editor.setPositionalAttribute(s.storeyId, 5, null);
    const ctx = createCopyContext(s.store, s.editor);
    expect(copySourcesInStore(ctx, [columnId])).toEqual({ ids: [columnId] });
    const { copyId } = copyProductInStore(ctx, columnId, { offset: [1, 0, 0] });
    const placement = s.editor.getNewEntity(asRefId(s.editor.getNewEntity(copyId)!.attributes[5]))!;
    expect(placement.attributes[0]).toBe(`#${gridPlacement.placementId}`);
  });

  it('still copies a column on the same storey that is not bound to the grid', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [6, 4, 0] });
    const ctx = createCopyContext(s.store, s.editor);
    expect(copyRefusal(ctx, columnId)).toBeNull();
    expect(copyProductInStore(ctx, columnId, { offset: [1, 0, 0] }).copyId).toBeGreaterThan(columnId);
  });
});
