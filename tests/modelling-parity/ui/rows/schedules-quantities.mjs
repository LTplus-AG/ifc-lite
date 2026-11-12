/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readScheduleTotals } from '../lib/schedule-ui.mjs';
import { task, downloadCount, nextDownload } from '../lib/driver.mjs';
import { oracleModel } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, scheduleLengths, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id:'ui.schedules', capability:'schedules-quantities', title:'Two walls carry quantities; grouped schedule export',
    async run(s) {
      const tasks = [await task(s,'draw two 5 m walls',async () => { await wall(s); await wall(s,3); })];
      let csv = null;
      tasks.push(await task(s,'Analyze > Lists > Wall Schedule > Export CSV',async () => {
        await s.ui.click(s.page.getByRole('tab',{name:'Analyze',exact:true}));
        const lists = s.page.getByRole('button',{name:'Lists',exact:true}).first();
        if (await lists.isVisible()) await s.ui.click(lists);
        else {
          await s.ui.click(s.page.getByRole('button',{name:/^More panels/}));
          await s.ui.click(s.page.locator('[role=menuitem][data-panel-id=lists]'));
        }
        await s.ui.click(s.page.getByRole('button',{name:/Wall Schedule/}).first(),{settle:1000});
        const before = await downloadCount(s.page);
        await s.ui.click(s.page.getByRole('button',{name:'Export',exact:true}).last());
        await s.ui.click(s.page.getByRole('menuitem',{name:/CSV/}));
        csv = await nextDownload(s.page,before,10000);
      }));
      const rows = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().listResult?.rows ?? []);
      const original = (await oracleModel(s)).step;
      let totals = null, editedTotals = null;
      tasks.push(await task(s, 'group by Type and sum Length in the schedule', async () => {
        // Column menu is adjacent to its sortable header, not a list settings mutation.
        const menu = name => s.page.getByRole('button', { name, exact: false }).first().locator('..').getByRole('button', { name: 'Column options', exact: true });
        const typeMenu = menu(/^Type$/);
        if (!(await typeMenu.count())) throw new Error('Wall Schedule has no Type column to group by; Class and ObjectType do not identify the assigned wall type.');
        await s.ui.click(typeMenu);
        await s.ui.click(s.page.getByRole('menuitem', { name: /Group by this column/ }));
        await s.ui.click(menu(/^Length/));
        await s.ui.click(s.page.getByRole('menuitemcheckbox', { name: /Sum this column/ }));
        totals = await readScheduleTotals(s);
      }));
      tasks.push(await task(s, 'edit one wall length to 6 m and read live totals', async () => {
        await selectWall(s);
        const length = s.page.getByLabel('Length in metres', { exact: true });
        if (!(await length.isEditable())) throw new Error('Wall Length is read-only in Model inspector; cannot edit it to 6 m.');
        await field(s,length,6);
        await s.settle(1200);
        editedTotals = await readScheduleTotals(s);
      }));
      const { step } = await oracleModel(s);
      const q = original.of('IFCWALL').map((w) => original.quantities(w.id));
      return finish(s,tasks,[
        check('two walls have 5 m Length and positive NetVolume',q.length === 2 && q.every((v) => near(v.Length,5) && v.NetVolume > 0),JSON.stringify(q)),
        check('schedule contains the two authored walls',rows.length === 2,`${rows.length} schedule rows`),
        check('CSV contains wall lengths',!!csv && scheduleLengths(csv.text).length === 2 && scheduleLengths(csv.text).every((v) => near(v,5)),csv?.text.slice(0,600) ?? 'no schedule CSV download'),
        check('group and footer Length totals are 10 m', totals?.groups.length > 0 && near(totals.total,10) && near(totals.groups.reduce((a,b)=>a+b,0),10), JSON.stringify(totals)),
        check('group and footer totals refresh to 11 m after editing', editedTotals?.groups.length > 0 && near(editedTotals.total,11) && near(editedTotals.groups.reduce((a,b)=>a+b,0),11), JSON.stringify(editedTotals)),
      ]);
    },
  };
