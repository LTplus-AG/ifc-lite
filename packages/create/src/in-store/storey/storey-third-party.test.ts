/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9013 on a real third-party model: ArchiCAD 20's FZK-Haus (IFC4, two
 * storeys at 0 and +2.70). Raising the ground floor's floor-to-floor height
 * moves the upper storey and everything on it in real geometry, reports the
 * spiral stair it cannot refit before anything is written, and survives
 * export and reload in IFC4 and IFC4X3.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../__test__/stair-mesh.oracle.js';
import { effectiveStoreyId } from '../edit/effective-storey.js';
import { applyStoreyLevelEdit } from './storey-level-apply.js';
import { planStoreyLevelEdit } from './storey-level-plan.js';
import { readStoreyInventory, storeyContents } from './storey-model.js';
import { parse, session } from './storey-fixtures.oracle.js';

const FIXTURE = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
const GROUND = 479;
const ROOF = 35065;

describe.skipIf(!existsSync(FIXTURE))('ArchiCAD FZK-Haus (run `pnpm fixtures` when skipped)', () => {
  const load = async () => session(await parse(readFileSync(FIXTURE, 'utf8')));

  it('plans the edit and names the stair it leaves unrefit', async () => {
    const s = await load();
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'floorHeight', storeyId: GROUND, Height: 3 });
    expect(plan.refusals).toEqual([]);
    expect(plan.storeys.map((x) => [x.Name, x.from, x.to])).toEqual([['Dachgeschoss', 2.7, 3]]);
    // ArchiCAD hangs the storey's contents from its placement: one write moves them all.
    expect(plan.placements.map((w) => w.leaf.placementId)).toEqual([35064]);
    expect(plan.notices).toEqual([expect.objectContaining({ code: 'stairNotRefit', elementIds: [14502] })]);
  });

  it.skipIf(!stairWasmAvailable)('moves the upper storey in real geometry and survives export and reload', async () => {
    const s = await load();
    const upper = [...storeyContents(readStoreyInventory(s.store, s.view), ROOF)];
    const before = await meshStairs(s.text());
    const meshed = upper.filter((id) => before.has(id));
    expect(meshed.length).toBeGreaterThan(10);
    const ground = [...storeyContents(readStoreyInventory(s.store, s.view), GROUND)].filter((id) => before.has(id));
    applyStoreyLevelEdit(s.store, s.editor, { kind: 'floorHeight', storeyId: GROUND, Height: 3 });
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const text = s.text(schema);
      const after = await meshStairs(text);
      for (const id of meshed) {
        const a = stairMeshBounds(before.get(id)!), b = stairMeshBounds(after.get(id)!);
        expect(b.min[2] - a.min[2]).toBeCloseTo(0.3, 4);
        expect(b.max[0]).toBeCloseTo(a.max[0], 4);
      }
      for (const id of ground.slice(0, 20)) {
        expect(stairMeshBounds(after.get(id)!).min[2]).toBeCloseTo(stairMeshBounds(before.get(id)!).min[2], 4);
      }
      const reloaded = session(await parse(text));
      const inventory = readStoreyInventory(reloaded.store, reloaded.view);
      expect(inventory.storeys.map((x) => [x.Name, x.elevation])).toEqual([['Erdgeschoss', 0], ['Dachgeschoss', 3]]);
      for (const id of upper.slice(0, 20)) expect(effectiveStoreyId(reloaded.store, null, id)).toBe(ROOF);
    }
  }, 120_000);
});
