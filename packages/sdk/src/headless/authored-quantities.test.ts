/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { IfcQuery } from '@ifc-lite/query';
import { parseModel } from '@ifc-lite/parser';
import { openModel } from '../headless.js';

// #9296: CLI and MCP inherit this backend; live reads and STEP must agree.
describe('headless authored base quantities (#9296)', () => {
  for (const Schema of ['IFC4', 'IFC2X3', 'IFC4X3'] as const) {
    it(`reads live quantities and exports them in ${Schema}`, async () => {
      const creator = new IfcCreator({ Schema });
      const storey = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
      const session = await openModel(new TextEncoder().encode(creator.toIfc().content), { disableWorkerScan: true });
      try {
        const { bim } = session;
        const modelId = bim.model.activeId()!;
        const wall = bim.store.addWall(modelId, storey, { Start: [0, 0, 0], End: [5, 0, 0], Height: 3, Thickness: 0.2 });
        const slab = bim.store.addSlab(modelId, storey, { Position: [0, 0, 0], Width: 5, Depth: 4, Thickness: 0.25 });
        const column = bim.store.addColumn(modelId, storey, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 });
        const expected = [
          [wall, 'Qto_WallBaseQuantities', { Length: 5, NetVolume: 3 }],
          [slab, 'Qto_SlabBaseQuantities', { NetArea: 20, NetVolume: 5 }],
          [column, 'Qto_ColumnBaseQuantities', { Length: 3, NetVolume: 0.36 }],
        ] as const;
        const values = (sets: ReturnType<typeof bim.quantities>, name: string) => Object.fromEntries(
          sets.find(set => set.name === name)?.quantities.map(q => [q.name, q.value]) ?? [],
        );
        for (const [ref, set, want] of expected) expect(values(bim.quantities(ref), set)).toMatchObject(want);
        // Read again after another authoring operation: the cache must not freeze the gross result.
        bim.store.addHostedDoor(modelId, wall.expressId, { Offset: 1, Width: 1, Height: 2 });
        expect(values(bim.quantities(wall), 'Qto_WallBaseQuantities').NetVolume).toBeCloseTo(2.6);
        for (const schema of ['IFC4', 'IFC2X3', 'IFC4X3'] as const) {
          const content = bim.export.ifc(undefined, { schema });
          const reopened = await parseModel(typeof content === 'string' ? new TextEncoder().encode(content) : content, { disableWorkerScan: true });
          const query = new IfcQuery(reopened.store);
          for (const [ref, set] of expected) {
            expect(query.entity(ref.expressId).quantities().find(q => q.name === set)?.quantities)
              .toEqual(bim.quantities(ref).find(q => q.name === set)?.quantities);
          }
          // Reopening a loaded file must keep its quantities even when a mutation view is created.
          const loaded = await openModel(typeof content === 'string' ? new TextEncoder().encode(content) : content, { disableWorkerScan: true });
          try {
            const ref = { modelId: loaded.bim.model.activeId()!, expressId: wall.expressId };
            const before = loaded.bim.quantities(ref);
            loaded.bim.mutate.setProperty(ref, 'Pset_WallCommon', 'Reference', 'untouched quantities');
            expect(loaded.bim.quantities(ref)).toEqual(before);
          } finally { loaded.close(); }
        }
      } finally { session.close(); }
    });
  }
});
