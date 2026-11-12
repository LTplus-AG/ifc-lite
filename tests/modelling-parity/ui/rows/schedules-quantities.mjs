import { task, downloadCount, nextDownload } from '../lib/driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, inspector, typeScope, newType, layer, applyLayers, body, wallSize, layerThicknesses, scheduleLengths, near, finish } from '../lib/authoring-helpers.mjs';

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
      const { step } = await oracleModel(s);
      const q = step.of('IFCWALL').map((w) => step.quantities(w.id));
      return finish(s,tasks,[
        check('two walls have 5 m Length and positive NetVolume',q.length === 2 && q.every((v) => near(v.Length,5) && v.NetVolume > 0),JSON.stringify(q)),
        check('schedule contains the two authored walls',rows.length === 2,`${rows.length} schedule rows`),
        check('CSV contains wall lengths',!!csv && scheduleLengths(csv.text).length === 2 && scheduleLengths(csv.text).every((v) => near(v,5)),csv?.text.slice(0,600) ?? 'no schedule CSV download'),
        check('grouped schedule totals',false,'not yet measured: grouping and numeric total in the schedule'),
      ]);
    },
  };
