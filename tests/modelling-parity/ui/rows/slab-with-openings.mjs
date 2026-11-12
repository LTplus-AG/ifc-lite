/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { task } from '../lib/driver.mjs';
import { escape, tool, oracleModel } from '../lib/model-ui.mjs';
import { check, field, wall, inspector, body, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.slab-openings', capability: 'slab-with-openings',
    title: 'Sketch an L slab, try a shaft, then edit thickness',
    async run(s) {
      const tasks = [await task(s, 'polygon slab, six corners and Enter', async () => {
        await tool(s, 'slab.place');
        await s.ui.click(s.page.getByRole('radio', { name: 'Polygon', exact: true }));
        for (const p of [[0,0],[5,0],[5,2],[3,2],[3,4],[0,4]]) await s.ui.clickWorld([...p,0]);
        await s.ui.key('Enter');
        await escape(s);
      })];
      tasks.push(await task(s, 'opening tool: cut the slab at (1,1)', async () => {
        await tool(s, 'opening.place');
        await s.ui.clickWorld([1,1,0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'select slab and change thickness to 0.3 m', async () => {
        await s.ui.clickWorld([2,1,0]);
        await inspector(s);
        await field(s, s.page.getByLabel('Thickness in metres', { exact: true }), 0.3);
      }));
      const { step } = await oracleModel(s);
      const slab = step.of('IFCSLAB')[0];
      const solid = step.get(body(step, slab)?.args[3]?.[0]);
      const profile = step.get(solid?.args[0]);
      const points = step.get(profile?.args[2])?.args[0] ?? [];
      const voids = step.of('IFCRELVOIDSELEMENT').filter((r) => r.args[4]?.ref === slab?.id);
      return finish(s, tasks, [
        check('one L-shaped slab with six corners', step.count('IFCSLAB') === 1 && points.length >= 6, `${step.count('IFCSLAB')} slabs, ${points.length} profile points`),
        check('shaft remains hosted in slab after thickening', voids.length === 1 && near(solid?.args[3], .3), `${voids.length} slab voids; thickness ${solid?.args[3]}; opening tool currently expects a wall host`),
        check('shaft geometry is empty in plan and 3D', false, 'not measured: requires a slab shaft tool and geometry oracle'),
      ]);
    },
  };
