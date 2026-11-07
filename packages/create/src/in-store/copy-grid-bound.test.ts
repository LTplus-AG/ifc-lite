/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9199 (#9026 item 8): a copy of an element on a grid binds to the crossing it
 * lands on, and comes free as a plain storey-placed element anywhere else. The
 * ground truth is the placement as the geometry reader would resolve it, so these
 * read each copy back through its own records, never through the copy's arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { addColumnToStore } from './column.js';
import { arrayCopyTransforms } from './copy-array.js';
import { copyBatchInStore, copySourcesInStore } from './copy-batch.js';
import { GRID_LANDING_TOLERANCE_M } from './copy-grid-landing.js';
import { productStoreyOrigin } from './copy-placement.js';
import { copyRefusal, createCopyContext, type CopyContext } from './copy-product.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes, type GridInStoreParams } from './grid.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { duplicateInStore } from './duplicate.js';
import { asRef } from './style-entity-reader.js';

const SECTION = { Width: 0.4, Depth: 0.4, Height: 3 };
const BAYS = { UOffsets: [0, 6, 12], VOffsets: [0, 4] };

async function session(options: { schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3'; grid?: Partial<GridInStoreParams>; elevation?: number } = {}) {
  const creator = new IfcCreator({ Schema: options.schema ?? 'IFC4', Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: options.elevation ?? 0 });
  const upperId = creator.addIfcBuildingStorey({ Name: 'U', Elevation: (options.elevation ?? 0) + 3 });
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(creator.toIfc().content).buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'g');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const grid = addGridToStore(editor, anchor, { ...rectangularGridAxes(BAYS), ...options.grid });
  return { store, view, editor, anchor, grid, storeyId, upperId };
}
type Session = Awaited<ReturnType<typeof session>>;

/** A column on crossing (u, v) of the grid. */
function gridColumn(s: Session, u: number, v: number, position: [number, number, number] = [BAYS.UOffsets[u], BAYS.VOffsets[v], 0]) {
  return addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...SECTION, Position: position }, {
    GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[u], s.grid.vAxisIds[v]],
  });
}

const typeOf = (ctx: CopyContext, id: number | null) => (id === null ? undefined : ctx.read(id)?.type.toUpperCase());
const parentOf = (ctx: CopyContext, id: number) => asRef(ctx.read(asRef(ctx.read(id)?.attributes[5])!)?.attributes[0]);

/** The two axes a copy's IfcGridPlacement names, in either schema layout. */
function boundAxes(ctx: CopyContext, id: number): number[] | null {
  const parent = parentOf(ctx, id);
  const record = parent === null ? null : ctx.read(parent);
  if (record?.type.toUpperCase() !== 'IFCGRIDPLACEMENT') return null;
  const location = ctx.read(asRef(record.attributes[record.attributes.length >= 3 ? 1 : 0])!);
  return (location!.attributes[0] as unknown[]).map((axis) => asRef(axis)!);
}

const near = (actual: readonly number[], expected: readonly number[]) =>
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6));

/** A linear array along +X. */
const row = (count: number, spacing: number) => arrayCopyTransforms({ mode: 'linear', count, anchor: [0, 0], cursor: [1, 0], distance: spacing })!;

describe('copying an element on a grid crossing (#9199)', () => {
  it('an array at the bay spacing stays on the grid, each copy on its own crossing', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const results = copyBatchInStore(s.store, s.editor, [columnId], row(3, 6));
    const ctx = createCopyContext(s.store, s.editor);

    expect(results.map((r) => r.boundToGrid.length)).toEqual([1, 1]);
    expect(results.flatMap((r) => r.cameFree)).toEqual([]);
    expect(boundAxes(ctx, results[0].copyId)).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[0]]);
    expect(boundAxes(ctx, results[1].copyId)).toEqual([s.grid.uAxisIds[2], s.grid.vAxisIds[0]]);
    near(productStoreyOrigin(ctx, results[1].copyId)!.origin, [12, 0, 0]);
  });

  it('off the bay spacing they come free, under the storey, and say so', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const results = copyBatchInStore(s.store, s.editor, [columnId], row(3, 5));
    const ctx = createCopyContext(s.store, s.editor);

    expect(results.flatMap((r) => r.cameFree)).toEqual(results.map((r) => r.copyId));
    expect(results.flatMap((r) => r.boundToGrid)).toEqual([]);
    for (const { copyId } of results) {
      expect(typeOf(ctx, parentOf(ctx, copyId))).toBe('IFCLOCALPLACEMENT');
      expect(parentOf(ctx, copyId)).toBe(s.anchor.storeyPlacementId);
    }
    near(productStoreyOrigin(ctx, results[1].copyId)!.origin, [10, 0, 0]);
  });

  it('bound means bound: moving the grid carries a copy on a crossing and leaves a free one where it is', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const [bound, free] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }, { offset: [5, 0, 0] }]);
    const gridAxes = createCopyContext(s.store, s.editor).read(s.grid.placementId)!.attributes[1];
    const location = createCopyContext(s.store, s.editor).read(asRef(gridAxes)!)!.attributes[0];
    s.editor.setPositionalAttribute(asRef(location)!, 0, [2, 3, 0]);
    const ctx = createCopyContext(s.store, s.editor);
    near(productStoreyOrigin(ctx, columnId)!.origin, [2, 3, 0]);
    near(productStoreyOrigin(ctx, bound.copyId)!.origin, [8, 3, 0]);
    near(productStoreyOrigin(ctx, free.copyId)!.origin, [5, 0, 0]);
  });

  it('a row that passes crossings binds to those and frees the rest', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const results = copyBatchInStore(s.store, s.editor, [columnId], row(5, 3));
    expect(results.map((r) => (r.boundToGrid.length ? 'bound' : 'free'))).toEqual(['free', 'bound', 'free', 'bound']);
  });

  it('where the grid has no crossing it comes free, past the end of an axis too', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 2, 0);
    const [beyond] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }]);
    expect(beyond.cameFree).toEqual([beyond.copyId]);
  });

  it('the tolerance is a millimetre: just inside binds exactly on the crossing, just outside comes free', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const [inside, outside] = copyBatchInStore(s.store, s.editor, [columnId], [
      { offset: [6 + GRID_LANDING_TOLERANCE_M / 2, 0, 0] },
      { offset: [6 + GRID_LANDING_TOLERANCE_M * 2, 0, 0] },
    ]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(inside.boundToGrid).toEqual([inside.copyId]);
    near(productStoreyOrigin(ctx, inside.copyId)!.origin, [6, 0, 0]);
    expect(outside.cameFree).toEqual([outside.copyId]);
    near(productStoreyOrigin(ctx, outside.copyId)!.origin, [6 + GRID_LANDING_TOLERANCE_M * 2, 0, 0]);
  });

  it('a pasted copy stays on the crossing when the storey has an elevation and the grid sits off the origin, turned', async () => {
    // The grid is at (10, 20, 0.5) turned 90 degrees: its U axes run along storey Y.
    const s = await session({ elevation: 3, grid: { Position: [10, 20, 0.5], Direction: Math.PI / 2 } });
    const { columnId } = gridColumn(s, 0, 0, [10, 20, 1.5]);
    const origin = productStoreyOrigin(createCopyContext(s.store, s.editor), columnId)!.origin;
    near(origin, [10, 20, 1.5]);
    // One bay of U is 6 m along the grid's +X, which is storey +Y.
    const [copy, off] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [0, 6, 0] }, { offset: [1, 1, 0] }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(boundAxes(ctx, copy.copyId)).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[0]]);
    near(productStoreyOrigin(ctx, copy.copyId)!.origin, [10, 26, 1.5]);
    expect(off.cameFree).toEqual([off.copyId]);
    near(productStoreyOrigin(ctx, off.copyId)!.origin, [11, 21, 1.5]);
  });

  it('what the preview shows is what lands: the turn about the crossing and the move, bound or free', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 1, 0);
    const polar = arrayCopyTransforms({ mode: 'polar', count: 4, anchor: [6, 0], angleDegrees: 360 })!;
    const turned = copyBatchInStore(s.store, s.editor, [columnId], polar);
    const ctx = createCopyContext(s.store, s.editor);
    // About its own crossing, all land there: they stay bound, each with its heading.
    expect(turned.flatMap((r) => r.boundToGrid)).toHaveLength(3);
    for (const { copyId } of turned) near(productStoreyOrigin(ctx, copyId)!.origin, [6, 0, 0]);
    const headings = turned.map(({ copyId }) => {
      const axes = ctx.read(asRef(ctx.read(asRef(ctx.read(copyId)!.attributes[5])!)!.attributes[1])!)!;
      return ctx.read(asRef(axes.attributes[2])!)!.attributes[0] as number[];
    });
    near(headings[0], [0, 1, 0]);
    near(headings[1], [-1, 0, 0]);
    near(headings[2], [0, -1, 0]);

    // Turned about somewhere else, it lands where the turn says, on the grid or not.
    const [quarter] = copyBatchInStore(s.store, s.editor, [columnId], [{ turn: Math.PI / 2, pivot: [6, 2] }]);
    const later = createCopyContext(s.store, s.editor);
    expect(quarter.cameFree).toEqual([quarter.copyId]);
    near(productStoreyOrigin(later, quarter.copyId)!.origin, [8, 2, 0]);
  });

  it('keeps an offset from the crossing, and binds when the offset element itself lands on one', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [0, 0, 0] });
    const { placementId } = gridIntersectionPlacement(s.editor, s.anchor, {
      Axes: [s.grid.uAxisIds[0], s.grid.vAxisIds[0]], Offsets: [0.5, 0.25], GridPlacementId: s.grid.placementId,
    }, s.store);
    s.editor.setPositionalAttribute(columnId, 5, `#${placementId}`);
    const ctx = createCopyContext(s.store, s.editor);
    // Offset to the left of U (running +Y) is -X; to the left of V (running +X) is +Y.
    near(productStoreyOrigin(ctx, columnId)!.origin, [-0.5, 0.25, 0]);

    const [same, gripped] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }, { offset: [6.5, -0.25, 0] }]);
    const after = createCopyContext(s.store, s.editor);
    expect(boundAxes(after, same.copyId)).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[0]]);
    near(productStoreyOrigin(after, same.copyId)!.origin, [5.5, 0.25, 0]);
    expect(boundAxes(after, gripped.copyId)).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[0]]);
    near(productStoreyOrigin(after, gripped.copyId)!.origin, [6, 0, 0]);
  });

  it('copies a product pointing straight at its IfcGridPlacement, with a new local placement of its own', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [0, 0, 0] });
    const { placementId } = gridIntersectionPlacement(s.editor, s.anchor, {
      Axes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]], GridPlacementId: s.grid.placementId,
    }, s.store);
    s.editor.setPositionalAttribute(columnId, 5, `#${placementId}`);

    const [bound, free] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }, { offset: [1, 0, 0] }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(typeOf(ctx, asRef(ctx.read(bound.copyId)!.attributes[5]))).toBe('IFCLOCALPLACEMENT');
    expect(boundAxes(ctx, bound.copyId)).toEqual([s.grid.uAxisIds[2], s.grid.vAxisIds[1]]);
    near(productStoreyOrigin(ctx, bound.copyId)!.origin, [12, 4, 0]);
    expect(free.cameFree).toEqual([free.copyId]);
    near(productStoreyOrigin(ctx, free.copyId)!.origin, [7, 4, 0]);
  });

  it('a direct duplicateInStore of a product straight on its grid placement refuses rather than writing it at the origin', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [0, 0, 0] });
    const { placementId } = gridIntersectionPlacement(s.editor, s.anchor, {
      Axes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]], GridPlacementId: s.grid.placementId,
    }, s.store);
    s.editor.setPositionalAttribute(columnId, 5, `#${placementId}`);
    const source = resolveDuplicateSource(s.store, columnId, s.editor);
    expect(source.onGridPlacement).toBe(true);
    const before = s.editor.getNewEntities().length;
    expect(() => duplicateInStore(s.editor, source)).toThrow(/IfcGridPlacement/);
    expect(s.editor.getNewEntities()).toHaveLength(before);
    // An ordinary column reads as before.
    const { columnId: plain } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [1, 1, 0] });
    expect(resolveDuplicateSource(s.store, plain, s.editor).onGridPlacement).toBeUndefined();
  });

  it('an assembly with a grid-bound part: the part binds or comes free on its own, the whole stays together', async () => {
    for (const shape of ['through a local child', 'straight at the grid placement'] as const) {
      const s = await session();
      const { columnId: root } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [1, 1, 0] });
      const { columnId: part, gridPlacement } = gridColumn(s, 0, 1);
      if (shape === 'straight at the grid placement') s.editor.setPositionalAttribute(part, 5, `#${gridPlacement.placementId}`);
      s.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${root}`, [`#${part}`]]);

      const [onBay, offBay] = copyBatchInStore(s.store, s.editor, [root], [{ offset: [6, 0, 0] }, { offset: [1, 0, 0] }]);
      const ctx = createCopyContext(s.store, s.editor);
      expect(onBay.partIds).toHaveLength(1);
      expect(onBay.boundToGrid).toEqual(onBay.partIds);
      expect(onBay.cameFree).toEqual([]);
      expect(boundAxes(ctx, onBay.partIds[0])).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[1]]);
      near(productStoreyOrigin(ctx, onBay.partIds[0])!.origin, [6, 4, 0]);
      expect(offBay.cameFree).toEqual(offBay.partIds);
      near(productStoreyOrigin(ctx, offBay.partIds[0])!.origin, [1, 4, 0]);
      expect(parentOf(ctx, offBay.partIds[0])).toBe(s.anchor.storeyPlacementId);
    }
  });

  it('a part placed under a grid-bound root follows the copy, and is not counted as a second one', async () => {
    const s = await session();
    const { columnId: root } = gridColumn(s, 0, 0);
    const rootPlacement = asRef(createCopyContext(s.store, s.editor).read(root)!.attributes[5])!;
    const { columnId: part } = addColumnToStore(s.editor, { ...s.anchor, storeyPlacementId: rootPlacement }, { ...SECTION, Position: [1, 0, 0] });
    s.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${root}`, [`#${part}`]]);

    const [onBay, offBay] = copyBatchInStore(s.store, s.editor, [root], [{ offset: [6, 0, 0] }, { offset: [5, 0, 0] }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(onBay.boundToGrid).toEqual([onBay.copyId]);
    expect(offBay.cameFree).toEqual([offBay.copyId]);
    for (const result of [onBay, offBay]) {
      expect(result.partIds).toHaveLength(1);
      expect(parentOf(ctx, result.partIds[0])).toBe(asRef(ctx.read(result.copyId)!.attributes[5]));
    }
    near(productStoreyOrigin(ctx, onBay.partIds[0])!.origin, [7, 0, 0]);
    near(productStoreyOrigin(ctx, offBay.partIds[0])!.origin, [6, 0, 0]);
  });

  it('on another storey it comes free when no grid reaches it, at its height above that floor', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    const [elsewhere] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0], targetStoreyId: s.upperId }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(elsewhere.cameFree).toEqual([elsewhere.copyId]);
    expect(elsewhere.storeyId).toBe(s.upperId);
    expect(parentOf(ctx, elsewhere.copyId)).toBe(asRef(ctx.read(s.upperId)!.attributes[5]));
    near(productStoreyOrigin(ctx, elsewhere.copyId)!.origin, [6, 0, 0]);
  });

  it('a grid in the building reaches every storey: the copy binds there, at the same height above its floor', async () => {
    const s = await session();
    const { expressId: buildingId } = [...iterateEffectiveEntityIds(s.store, s.view, ['IFCBUILDING'])][0];
    const buildingPlacement = asRef(createCopyContext(s.store, s.editor).read(buildingId)!.attributes[5])!;
    const buildingAnchor = { ...s.anchor, storeyId: buildingId, storeyPlacementId: buildingPlacement };
    const grid = addGridToStore(s.editor, buildingAnchor, rectangularGridAxes(BAYS));
    const { columnId } = addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...SECTION, Position: [0, 0, 0] }, {
      GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[0], grid.vAxisIds[0]],
    });
    const [upper] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0], targetStoreyId: s.upperId }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(upper.boundToGrid).toEqual([upper.copyId]);
    expect(boundAxes(ctx, upper.copyId)).toEqual([grid.uAxisIds[1], grid.vAxisIds[0]]);
    near(productStoreyOrigin(ctx, upper.copyId)!.origin, [6, 0, 0]);
  });

  it('with no storey placement there is no frame to bind in: it comes free, at its place in the model', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 1, 1);
    s.editor.setPositionalAttribute(s.storeyId, 5, null);
    const [copy] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(copy.cameFree).toEqual([copy.copyId]);
    expect(parentOf(ctx, copy.copyId)).toBeNull();
  });

  it('is one atomic batch: a copy that fails after another bound leaves no grid placement behind', async () => {
    const s = await session();
    const { columnId } = gridColumn(s, 0, 0);
    s.editor.setPositionalAttribute(s.upperId, 5, null);
    const before = s.editor.getNewEntities().length;
    expect(() => copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }, { offset: [12, 0, 0], targetStoreyId: s.upperId }]))
      .toThrow(/no placement to copy under/);
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });

  it('refuses in plain words, and writes nothing, when its place on the grid cannot be read', async () => {
    const s = await session();
    const { columnId, gridPlacement } = gridColumn(s, 0, 0);
    s.editor.setPositionalAttribute(gridPlacement.intersectionId, 0, [`#${s.grid.uAxisIds[0]}`, `#${s.grid.uAxisIds[1]}`]);
    const ctx = createCopyContext(s.store, s.editor);
    const before = s.editor.getNewEntities().length;
    const refusal = copyRefusal(ctx, columnId);
    expect(refusal).toMatch(/grid crossing/);
    expect(refusal).not.toMatch(/#\d/);
    expect(copySourcesInStore(ctx, [columnId])).toEqual({ refusal });
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });

  it('refuses in the same plain words when a link between it and the grid is tilted', async () => {
    const s = await session();
    const { columnId, gridPlacement } = gridColumn(s, 0, 0);
    const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const tilt = s.editor.addEntity('IfcDirection', [[0, 1, 1]]).expressId;
    const axes = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${tilt}`, null]).expressId;
    const tilted = s.editor.addEntity('IfcLocalPlacement', [`#${gridPlacement.placementId}`, `#${axes}`]).expressId;
    const own = asRef(createCopyContext(s.store, s.editor).read(columnId)!.attributes[5])!;
    s.editor.setPositionalAttribute(own, 0, `#${tilted}`);
    const ctx = createCopyContext(s.store, s.editor);
    const before = s.editor.getNewEntities().length;

    const refusal = copyRefusal(ctx, columnId);
    expect(refusal).toMatch(/grid crossing/);
    expect(copySourcesInStore(ctx, [columnId])).toEqual({ refusal });
    expect(() => productStoreyOrigin(ctx, columnId)).toThrow(/grid crossing/);
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });

  it('leaves an element with no grid placement exactly as before, beside a grid', async () => {
    const s = await session();
    const { columnId } = addColumnToStore(s.editor, s.anchor, { ...SECTION, Position: [0, 0, 0] });
    const [copy] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }]);
    const ctx = createCopyContext(s.store, s.editor);
    expect(copy.boundToGrid).toEqual([]);
    expect(copy.cameFree).toEqual([]);
    expect(parentOf(ctx, copy.copyId)).toBe(s.anchor.storeyPlacementId);
    near(productStoreyOrigin(ctx, copy.copyId)!.origin, [6, 0, 0]);
  });

  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`binds in the schema's own IfcGridPlacement layout on ${schema}`, async () => {
      const s = await session({ schema, grid: { Position: [10, 20, 0] } });
      const { columnId } = gridColumn(s, 0, 0, [10, 20, 0]);
      const [copy] = copyBatchInStore(s.store, s.editor, [columnId], [{ offset: [6, 0, 0] }]);
      const ctx = createCopyContext(s.store, s.editor);
      const placement = ctx.read(parentOf(ctx, copy.copyId)!)!;
      if (schema === 'IFC4X3') {
        expect(placement.attributes).toHaveLength(3);
        expect(placement.attributes[0]).toBe(`#${s.grid.placementId}`);
      } else {
        expect(placement.attributes).toHaveLength(2);
      }
      expect(boundAxes(ctx, copy.copyId)).toEqual([s.grid.uAxisIds[1], s.grid.vAxisIds[0]]);
      near(productStoreyOrigin(ctx, copy.copyId)!.origin, [16, 20, 0]);
    });
  }
});
