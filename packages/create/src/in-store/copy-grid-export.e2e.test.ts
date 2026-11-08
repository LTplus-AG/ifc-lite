/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9199: copies of a grid column survive export and reopening in every schema,
 * including a conversion across IFC4X3, where `IfcGridPlacement` changes layout
 * (#9132). The file is parsed afresh, so nothing here reads the session's memory.
 */
import { describe, expect, it } from 'vitest';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { arrayCopyTransforms } from './copy-array.js';
import { copyBatchInStore } from './copy-batch.js';
import { createCopyContext, productStoreyOrigin } from './copy-product.js';
import { addGridToStore, rectangularGridAxes } from './grid.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { asRef } from './style-entity-reader.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

const parse = (content: Uint8Array | string) => new IfcParser().parseColumnar(
  (typeof content === 'string' ? new TextEncoder().encode(content) : content).slice().buffer as ArrayBuffer, { disableWorkerScan: true });

function session(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'g');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  return { view, editor: new StoreEditor(store, view) };
}

/** Each column's storey-local plan point, and whether it hangs from an IfcGridPlacement. */
function columnsIn(store: IfcDataStore): { at: [number, number]; onGrid: boolean; z: number }[] {
  const { view, editor } = session(store);
  const ctx = createCopyContext(store, editor);
  return [...iterateEffectiveEntityIds(store, view, ['IFCCOLUMN'])].map(({ expressId }) => {
    const origin = productStoreyOrigin(ctx, expressId)!.origin;
    const placement = ctx.read(asRef(ctx.read(expressId)!.attributes[5])!)!;
    const parent = ctx.read(asRef(placement.attributes[0])!);
    return { at: [+origin[0].toFixed(6), +origin[1].toFixed(6)] as [number, number], z: +origin[2].toFixed(6), onGrid: parent?.type.toUpperCase() === 'IFCGRIDPLACEMENT' };
  }).sort((a, b) => a.at[0] - b.at[0]);
}

describe('copies of a grid column across export and reopening (#9199)', () => {
  const routes: [Schema, Schema][] = [['IFC2X3', 'IFC2X3'], ['IFC4', 'IFC4'], ['IFC4X3', 'IFC4X3'], ['IFC4', 'IFC4X3'], ['IFC4X3', 'IFC4'], ['IFC2X3', 'IFC4X3']];
  for (const [authored, exported] of routes) {
    it(`authored on ${authored}, exported as ${exported}: bay copies on the grid, the off-bay copy free, none moved`, async () => {
      const creator = new IfcCreator({ Schema: authored, Timestamp: 0 });
      const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: 3 });
      const store = await parse(creator.toIfc().content);
      const { view, editor } = session(store);
      const anchor = resolveSpatialAnchor(store, storeyId, view);
      // Off the origin and turned: a dropped or wrong frame moves every copy.
      const grid = addGridToStore(editor, anchor, { ...rectangularGridAxes({ UOffsets: [0, 6, 12], VOffsets: [0, 4] }), Position: [10, 20, 0], Direction: Math.PI / 2 });
      const { columnId } = addColumnOnGridToStore(editor, store, anchor, { Position: [10, 20, 0], Width: 0.4, Depth: 0.4, Height: 3 }, {
        GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[0], grid.vAxisIds[0]],
      });
      const row = arrayCopyTransforms({ mode: 'linear', count: 3, anchor: [0, 0], cursor: [0, 1], distance: 6 })!;
      copyBatchInStore(store, editor, [columnId], [...row, { offset: [-4, 0, 0] }, { offset: [1, 1, 0] }]);

      const step = new StepExporter(store, view).export({ schema: exported, applyMutations: true }).content;
      const reopened = columnsIn(await parse(step)).sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);

      // IFC2X3 places one product per placement (#9209) and its grid placement
      // cannot carry a heading. These columns keep the storey's heading on a
      // grid turned a quarter, so each turns back in the grid's frame and comes
      // free, at the same point.
      const bound = exported !== 'IFC2X3';
      expect(reopened.map(({ at, onGrid }) => ({ at, onGrid }))).toEqual([
        { at: [10, 20], onGrid: bound },
        { at: [11, 21], onGrid: false },
        { at: [6, 20], onGrid: bound },
        { at: [10, 26], onGrid: bound },
        { at: [10, 32], onGrid: bound },
      ].sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]));
      expect(reopened.every((c) => c.z === 0)).toBe(true);

      const placements = new TextDecoder().decode(step).match(/IFCGRIDPLACEMENT\([^;]*\);/g) ?? [];
      expect(placements).toHaveLength(bound ? 4 : 0);
      // IFC4X3 names the grid's placement first; below it only two attributes exist.
      for (const record of placements) expect(record).toMatch(exported === 'IFC4X3' ? /^IFCGRIDPLACEMENT\(#\d+,#\d+,\$\);$/ : /^IFCGRIDPLACEMENT\(#\d+,\$\);$/);
    });
  }
});
