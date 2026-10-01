/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: generic IFC intersections preserve radial axes, while requiring
 * two distinct rows of one live, unambiguous grid. Geometry limitations of
 * linear snapping must not narrow the canonical IFC emission contract. */
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter, serializeEntitySubgraph } from '@ifc-lite/export';
import { IfcCreator } from '../ifc-creator.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';

const parse = (text: string) => new IfcParser().parseColumnar(
  new TextEncoder().encode(text).buffer, { disableWorkerScan: true },
);

async function sourceGrid(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', variant: 'radial' | 'same-row' | 'ordinary' | 'shared') {
  const creator = new IfcCreator({ Schema: schema, Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'Grid tests', Elevation: 0 });
  const source = await parse(creator.toIfc().content);
  const overlay = new MutablePropertyView(null, 'source');
  overlay.setOnDemandExtractor((id) => extractPropertiesOnDemand(source, id));
  const draft = new StoreEditor(source, overlay);
  const anchor = resolveSpatialAnchor(source, storeyId, overlay);
  const grid = addGridToStore(draft, anchor, {
    Position: [2, 3, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
  });
  if (variant === 'radial') {
    const centre = draft.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
    const frame = draft.addEntity('IfcAxis2Placement2D', [`#${centre}`, null]).expressId;
    const circle = draft.addEntity('IfcCircle', [`#${frame}`, 6]).expressId;
    draft.setPositionalAttribute(grid.uAxisIds[1], 1, `#${circle}`);
  } else if (variant === 'same-row') {
    // Deliberately nonparallel curves in one row: a determinant-only guard
    // accepts them, but IfcVirtualGridIntersection requires different rows.
    draft.setPositionalAttribute(grid.uAxisIds[1], 1, draft.getNewEntity(grid.vAxisIds[0])!.attributes[1]);
  } else if (variant === 'shared') {
    const other = addGridToStore(draft, anchor, {
      Position: [0, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
    });
    draft.setPositionalAttribute(other.gridId, 7, [`#${grid.uAxisIds[1]}`]);
  }
  const exported = new StepExporter(source, overlay).export({ schema, applyMutations: true });
  const store = await parse(new TextDecoder().decode(exported.content));
  const view = new MutablePropertyView(null, 'parsed');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  return { store, view, editor, grid, anchor: resolveSpatialAnchor(store, storeyId, view), schema };
}

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) describe(`#6232 generic grid ownership in ${schema}`, () => {
  it('preserves a valid parsed circular/radial intersection through export and reload', async () => {
    const a = await sourceGrid(schema, 'radial');
    const result = gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]], GridPlacementId: a.grid.placementId,
    }, a.store);
    const text = new StepExporter(a.store, a.view).export({ schema, applyMutations: true });
    const restored = await parse(new TextDecoder().decode(text.content));
    const reader = new AnchorEntityReader(restored, null);
    expect(reader.entity(result.placementId)?.type.toUpperCase()).toBe('IFCGRIDPLACEMENT');
    expect(reader.entity(result.intersectionId)?.attributes[0]).toEqual([a.grid.uAxisIds[1], a.grid.vAxisIds[0]]);
    const curve = reader.entity(a.grid.uAxisIds[1])!.attributes[1];
    expect(typeof curve).toBe('number');
    expect(reader.entity(Number(curve))?.type.toUpperCase()).toBe('IFCCIRCLE');
    const mini = serializeEntitySubgraph(a.store, a.view, { targets: new Set([result.placementId]) });
    expect(mini.unreadable).toEqual([]);
    expect(mini.ids).toContain(a.grid.gridId);
    const restoredMini = await parse(new TextDecoder().decode(mini.bytes));
    expect(new AnchorEntityReader(restoredMini, null).entity(Number(curve))?.type.toUpperCase()).toBe('IFCCIRCLE');
  });

  it('refuses two nonparallel axes from the same row before emitting helpers', async () => {
    const a = await sourceGrid(schema, 'same-row');
    expect(() => gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[0], a.grid.uAxisIds[1]], GridPlacementId: a.grid.placementId,
    }, a.store)).toThrow(/row|famil/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('refuses an axis owned by two parsed grids before emitting helpers', async () => {
    const a = await sourceGrid(schema, 'shared');
    expect(() => gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    }, a.store)).toThrow(/unambiguous|owner|grid/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('reads effective deletion of the source grid instead of inventing an owner', async () => {
    const a = await sourceGrid(schema, 'ordinary');
    a.editor.removeEntity(a.grid.gridId);
    expect(() => gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    }, a.store)).toThrow(/unambiguous|owner|grid/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('refuses an axis ambiguously listed in two different rows of its grid', async () => {
    const a = await sourceGrid(schema, 'ordinary');
    a.editor.setPositionalAttribute(a.grid.gridId, 8, [`#${a.grid.uAxisIds[1]}`, `#${a.grid.vAxisIds[0]}`]);
    expect(() => gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    }, a.store)).toThrow(/row|unambiguous/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('refuses an effectively deleted axis before emitting references to it', async () => {
    const a = await sourceGrid(schema, 'ordinary');
    a.editor.removeEntity(a.grid.uAxisIds[1]);
    expect(() => gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    }, a.store)).toThrow(/axis|grid/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('requires explicit paired source context for file-backed axes under a manually built anchor', async () => {
    const a = await sourceGrid(schema, 'ordinary');
    expect(() => gridIntersectionPlacement(a.editor, { ...a.anchor }, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    })).toThrow(/source.*context/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
    expect(gridIntersectionPlacement(a.editor, { ...a.anchor }, {
      Axes: [a.grid.uAxisIds[1], a.grid.vAxisIds[0]],
    }, a.store).placementId).toBeGreaterThan(0);
  });
});
