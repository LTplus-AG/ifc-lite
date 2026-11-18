/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { task } from '../lib/driver.mjs';
import { escape, oracleModel, openStoreyManager, tool, typeFields } from '../lib/model-ui.mjs';


import { near, nearPt, fmt } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.grid-columns',
    capability: 'columns-beams-on-grid-follow-levels',
    title: 'Grid 18x12 typed, a column on a grid intersection, a beam, then a storey height change',
    async run(s) {
      const tasks = [];
      await s.harness.aim([9, -6, 40], [9, 6, 0]);
      tasks.push(await task(s, 'setup: add a storey above, so columns run to it', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
        await s.ui.click(s.page.getByRole('button', { name: 'Back to the inspector' }));
      }).then(t => Object.assign(t, { setup: true })));
      tasks.push(await task(s, 'grid: Shift+G, click origin, type 18 x 12', async () => {
        await escape(s);
        await tool(s, 'grid.place');
        await s.ui.clickWorld([0, 0, 0]);
        await typeFields(s, [18, 12]);
        await escape(s);
      }));
      tasks.push(await task(s, 'column: Shift+C, click near the grid intersection (6,6)', async () => {
        await tool(s, 'column.place');
        await s.ui.clickWorld([6.08, 6.08, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'beam: Shift+B, click (0,0) then (6,0)', async () => {
        await tool(s, 'beam.place');
        await s.ui.clickWorld([0.05, 0.05, 0]);
        await s.ui.clickWorld([6.05, 0.05, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'raise Level 1 floor-to-floor to 4.0 in the storey manager', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.getByLabel('Floor-to-floor height of Level 1, metres'));
        await s.ui.key('Control+A');
        await s.ui.type('4');
        await s.ui.key('Enter', { settle: 1200 });
      }));
      const shot = await s.shot('grid');
      const { step } = await oracleModel(s);
      const col = step.of('IFCCOLUMN')[0];
      // Column height = depth of its body extrusion.
      const body = col && (step.get(col.args?.[6])?.args?.[2] ?? []).map(step.get).find((r) => r?.args?.[1] === 'Body');
      const solid = body && step.get(body.args[3]?.[0]);
      const colHeight = solid?.type === 'IFCEXTRUDEDAREASOLID' ? solid.args[3] : null;
      const p = col ? step.placement(col.id).origin : null;
      // The grid origin carries the click's few-mm error; binding to the grid is exact.
      const bound = !!col && step.get(step.get(col.args?.[5])?.args?.[0])?.type === 'IFCGRIDPLACEMENT';
      const axes = step.count('IFCGRIDAXIS');
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'IfcGrid with axes', ok: step.count('IFCGRID') === 1 && axes >= 4, detail: `${step.count('IFCGRID')} grids, ${axes} axes` },
          { name: 'column bound to the grid intersection (6,6) by IfcGridPlacement', ok: bound && !!p && nearPt(p, [6, 6], 0.03), detail: p ? `${fmt(p)}${bound ? ', grid placement' : ', free placement'}` : 'no column' },
          { name: 'IfcBeam', ok: step.count('IFCBEAM') === 1, detail: `${step.count('IFCBEAM')}` },
          { name: 'the column follows the storey height change to 4.0 m', ok: typeof colHeight === 'number' && near(colHeight, 4, 0.01), detail: `column height ${colHeight}` },
        ],
      };
    },
  };
