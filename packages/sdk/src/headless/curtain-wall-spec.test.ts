/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openModel } from '../headless.js';

it.each([
  { Height: 3, VGrid: [1, 2] },
  { Height: 6, VGrid: Array.from({ length: 20 }, (_, i) => (i + 1) / 4 + 0.000000000123456) },
])('#9352 the SDK reads the authored V-grid spec live and after export/reopen (height=$Height)', async ({ Height, VGrid }) => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const bim = model.bim;
    const storey = bim.query().byType('IfcBuildingStorey').toArray()[0].ref.expressId;
    const wall = bim.store.addCurtainWall('m', storey, {
      Start: [0, 5, 0], End: [4, 5, 0], Height, UGrid: 2, VGrid,
    });
    const spec = (context: typeof bim) => context.properties(wall)
      .find(p => p.name === 'IfcLite_CurtainWallLayout')?.properties.find(p => p.name === 'VGrid')?.value;
    expect(spec(bim)).toBe(JSON.stringify(VGrid));
    const exported = bim.export.ifc();
    const reopened = await openModel(typeof exported === 'string' ? new TextEncoder().encode(exported) : exported,
      { modelId: 'm', disableWorkerScan: true });
    try { expect(spec(reopened.bim)).toBe(JSON.stringify(VGrid)); } finally { reopened.close(); }
  } finally { model.close(); }
});
