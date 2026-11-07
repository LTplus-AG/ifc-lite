/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8159: a reversed IfcGridAxis (SameSense = .F.) is the same line walked the
 * other way, so a column snapped to a crossing of reversed axes must land on the
 * same point. The intersection writer stores offsets as given (signed, in axis
 * order); what a sign means geometrically is decided by the consumer that reads
 * the axis direction, which is not part of this package. */
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcCreator } from '../ifc-creator.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';

async function session() {
  const creator = new IfcCreator({ Schema: 'IFC4', Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: 0 });
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(creator.toIfc().content).buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'g');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const grid = addGridToStore(editor, anchor, {
    Position: [2, 3, 0.5], Direction: Math.PI / 2,
    ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
  });
  return { store, view, editor, anchor, grid, reader: new AnchorEntityReader(store, view) };
}

// Grid frame (6, 4) -> storey (2 - 4, 3 + 6) = (-2, 9), elevation 0.5.
const PARAMS = { Position: [-2, 9, 1.25] as [number, number, number], Width: 0.4, Depth: 0.2, Height: 3 };

describe('grid column on reversed axes (#8159)', () => {
  for (const [name, reverse] of [['neither', []], ['U only', ['u']], ['V only', ['v']], ['both', ['u', 'v']]] as const) {
    it(`snaps to the same crossing with ${name} axis reversed`, async () => {
      const s = await session();
      const binding = { GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]] as const };
      if (reverse.includes('u' as never)) s.editor.setPositionalAttribute(binding.IntersectingAxes[0], 2, false);
      if (reverse.includes('v' as never)) s.editor.setPositionalAttribute(binding.IntersectingAxes[1], 2, false);
      const result = addColumnOnGridToStore(s.editor, s.store, s.anchor, PARAMS, binding);
      // The crossing is verified against PARAMS.Position inside the call (1e-6 m);
      // the column sits 0.75 m above the grid plane in the grid's own placement.
      const placement = s.reader.entity(result.gridPlacement.placementId)!;
      expect(placement.type.toUpperCase()).toBe('IFCGRIDPLACEMENT');
      const column = s.reader.entity(result.columnId)!;
      const local = s.reader.entity(refId(column.attributes[5])!)!;
      expect(refId(local.attributes[0])).toBe(result.gridPlacement.placementId);
    });
  }

  it('refuses a crossing that is not where the reversed axes meet', async () => {
    const s = await session();
    const binding = { GridId: s.grid.gridId, IntersectingAxes: [s.grid.uAxisIds[1], s.grid.vAxisIds[1]] as const };
    s.editor.setPositionalAttribute(binding.IntersectingAxes[0], 2, false);
    expect(() => addColumnOnGridToStore(s.editor, s.store, s.anchor, { ...PARAMS, Position: [-2, 7, 1.25] }, binding))
      .toThrow(/no longer matches the live grid crossing/);
  });

  it('writes signed offsets exactly as given, in axis order, independent of axis sense', async () => {
    const s = await session();
    const axes: [number, number] = [s.grid.uAxisIds[1], s.grid.vAxisIds[1]];
    s.editor.setPositionalAttribute(axes[0], 2, false);
    for (const offsets of [[0.25, -0.5], [-0.25, 0.5]] as const) {
      const placed = gridIntersectionPlacement(s.editor, s.anchor, { Axes: axes, Offsets: [offsets[0], offsets[1]] }, s.store);
      const intersection = s.reader.entity(placed.intersectionId)!;
      expect(intersection.attributes[0]).toEqual(axes.map((id) => `#${id}`));
      expect((intersection.attributes[1] as Array<{ real: number }>).map((v) => v.real)).toEqual([...offsets]);
    }
  });
});
