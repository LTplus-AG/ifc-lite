/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9209: IFC2X3 says each object placement places exactly one product. Grid
 * columns authored in a session, with and without a heading, exported as
 * IFC2X3 from an IFC4 model and from an IFC2X3 one, through the overlay path a
 * session writes. IFC4 keeps the grid placement with its local child. */
import { describe, expect, it } from 'vitest';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { addGridToStore, rectangularGridAxes } from './grid.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

async function gridColumns(schema: 'IFC4' | 'IFC2X3') {
  const creator = new IfcCreator({ Schema: schema, Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'S', Elevation: 3 });
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(creator.toIfc().content).buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'g');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const grid = addGridToStore(editor, anchor, rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }));
  const column = (u: number, v: number, z: number, RefDirection?: [number, number, number]) => addColumnOnGridToStore(
    editor, store, anchor, { Position: [u * 6, v * 4, z], Width: 0.4, Depth: 0.3, Height: 3, RefDirection },
    { GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[u], grid.vAxisIds[v]] });
  const plain = column(0, 0, 0);
  const lifted = column(1, 0, 1.5);
  const turned = column(1, 1, 0, [0, 1, 0]);
  const exportAs = (target: 'IFC2X3' | 'IFC4') =>
    new TextDecoder().decode(new StepExporter(store, view).export({ schema: target, applyMutations: true }).content);
  return { grid, plain, lifted, turned, exportAs };
}

/** `#id` → its record, and which records name each placement as their ObjectPlacement. */
function placements(step: string): { record: Map<number, string>; placedBy: Map<number, number[]> } {
  const record = new Map<number, string>();
  for (const m of step.matchAll(/^#(\d+)=(.*)$/gm)) record.set(Number(m[1]), m[2]);
  const placedBy = new Map<number, number[]>();
  for (const [id, text] of record) {
    if (/^IFC(LOCAL|GRID)PLACEMENT\(/.test(text)) placedBy.set(id, placedBy.get(id) ?? []);
  }
  for (const [id, text] of record) {
    if (/^IFC(LOCAL|GRID)PLACEMENT\(/.test(text)) continue;
    const slot = /^\w+\((?:'[^']*'|[^,]*),(?:#\d+|\$),(?:'[^']*'|\$),(?:'[^']*'|\$),(?:'[^']*'|\$),#(\d+),/.exec(text)?.[1];
    if (slot !== undefined && placedBy.has(Number(slot))) placedBy.get(Number(slot))!.push(id);
  }
  return { record, placedBy };
}

describe('grid columns exported as IFC2X3 place one product per placement (#9209)', () => {
  for (const schema of ['IFC4', 'IFC2X3'] as const) {
    it(`from an ${schema} model`, async () => {
      const { grid, plain, lifted, turned, exportAs } = await gridColumns(schema);
      const { record, placedBy } = placements(exportAs('IFC2X3'));

      for (const [id, products] of placedBy) expect(products, `#${id}=${record.get(id)}`).toHaveLength(1);
      // The plain and lifted columns keep their grid binding, folded into their own placement.
      expect(record.get(plain.placementId)).toBe(`IFCGRIDPLACEMENT(#${plain.gridPlacement.intersectionId},$);`);
      expect(record.get(lifted.placementId)).toBe(`IFCGRIDPLACEMENT(#${lifted.gridPlacement.intersectionId},$);`);
      expect(record.get(lifted.gridPlacement.intersectionId)).toMatch(/^IFCVIRTUALGRIDINTERSECTION\(\(#\d+,#\d+\),\(0\.,0\.,1\.5\)\);$/);
      // The turned one comes free in the grid's own frame, at its crossing (6, 4).
      const freed = /^IFCLOCALPLACEMENT\(#(\d+),#(\d+)\);$/.exec(record.get(turned.placementId)!);
      expect(Number(freed?.[1])).toBe(grid.placementId);
      const origin = /^IFCAXIS2PLACEMENT3D\(#(\d+),/.exec(record.get(Number(freed?.[2]))!)?.[1];
      expect(record.get(Number(origin))).toBe('IFCCARTESIANPOINT((6.,4.,0.));');
      for (const { gridPlacement } of [plain, lifted, turned]) expect(record.has(gridPlacement.placementId)).toBe(false);
    });
  }

  it('leaves IFC4 output as it was', async () => {
    const { plain, turned, exportAs } = await gridColumns('IFC4');
    const { record } = placements(exportAs('IFC4'));
    for (const column of [plain, turned]) {
      expect(record.get(column.gridPlacement.placementId)).toBe(`IFCGRIDPLACEMENT(#${column.gridPlacement.intersectionId},$);`);
      expect(record.get(column.placementId)).toMatch(new RegExp(`^IFCLOCALPLACEMENT\\(#${column.gridPlacement.placementId},#\\d+\\);$`));
    }
  });
});
