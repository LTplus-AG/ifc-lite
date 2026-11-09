/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9296 U4. Real input only; unsupported sub-tasks remain explicit failed checks.
import { task, downloadCount, nextDownload } from './lib/driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from './lib/model-ui.mjs';

const check = (name, ok, detail) => ({ name, ok: !!ok, detail });
async function field(s, locator, value) {
  await s.ui.click(locator);
  await s.ui.key('Control+A');
  await s.ui.type(String(value));
  await s.ui.key('Enter', { settle: 500 });
}
async function wall(s, y = 0, x = 0) {
  await tool(s, 'wall.place');
  await s.ui.clickWorld([x, y, 0]);
  await typeFields(s, [5, 0]);
  await escape(s);
}
async function selectWall(s, y = 0) {
  await escape(s);
  await s.ui.clickWorld([2.5, y, 1]);
}
async function newType(s, name) {
  await s.ui.click(s.page.locator('[data-inspector-type]'));
  await s.ui.click(s.page.getByRole('option', { name: 'New type…', exact: true }));
  await field(s, s.page.getByLabel('Type name', { exact: true }), name);
}
async function layer(s, n, thickness, material) {
  await field(s, s.page.getByLabel(`Layer ${n} thickness in metres`, { exact: true }), thickness);
  await s.ui.click(s.page.getByLabel(`Layer ${n} material`, { exact: true }));
  await s.ui.click(s.page.getByRole('option', { name: 'New material…', exact: true }));
  await field(s, s.page.getByLabel('Material name', { exact: true }).last(), material);
}
const applyLayers = (s) => s.ui.click(s.page.locator('[data-inspector-apply-layers]'), { settle: 800 });
const body = (step, e) => (step.get(e?.args[6])?.args[2] ?? []).map(step.get).find((r) => r?.args[1] === 'Body');
export function wallSize(step, e) {
  const solid = step.get(body(step, e)?.args[3]?.[0]);
  const profile = step.get(solid?.args[0]);
  return { height: solid?.args[3], thickness: profile?.type === 'IFCRECTANGLEPROFILEDEF' ? profile.args[4] : null };
}
export function layerThicknesses(step) {
  return step.of('IFCMATERIALLAYERSET').map((set) => (set.args[0] ?? []).map((r) => step.get(r)?.args[1]));
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.001;
const finish = async (s, tasks, checks, notes = []) => ({ tasks, checks, notes, evidence: [await s.shot('result')] });

export const U4_PROBES = [
  {
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
  },
  {
    id: 'ui.wall-constraints', capability: 'wall-top-base-constraints',
    title: 'Attach a wall to Level 2 and raise the floor-to-floor',
    async run(s) {
      const tasks = [await task(s, 'add Level 2 and draw on Level 1', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first());
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
        await s.ui.click(s.page.getByRole('button', { name: 'Back to the inspector' }));
        await wall(s);
        await selectWall(s);
        await s.ui.click(s.page.getByRole('radio', { name: 'To storey above', exact: true }));
      })];
      tasks.push(await task(s, 'raise Level 1 to 3.4 m', async () => {
        await openStoreyManager(s);
        await field(s, s.page.getByLabel('Floor-to-floor height of Level 1, metres'), 3.4);
      }));
      const { step } = await oracleModel(s);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      return finish(s, tasks, [
        check('wall reaches the moved storey at 3.4 m', sizes.length === 1 && near(sizes[0].height,3.4), JSON.stringify(sizes)),
        check('top/base offsets and slab underside attachment', false, 'wall inspector offers fixed height or storey above; no top/base offset or slab attachment flow exercised'),
      ]);
    },
  },
  {
    id: 'ui.layered-walls', capability: 'layered-walls',
    title: 'Create a layered wall type with three named materials',
    async run(s) {
      const tasks = [await task(s, 'wall type WT-230, brick/insulation/plaster layers', async () => {
        await newType(s, 'WT-230');
        await layer(s,1,.115,'Brick');
        await s.ui.click(s.page.getByRole('button', { name: 'Layer', exact: true }));
        await layer(s,2,.1,'Insulation');
        await s.ui.click(s.page.getByRole('button', { name: 'Layer', exact: true }));
        await layer(s,3,.015,'Plaster');
        await s.ui.click(s.page.getByRole('radio', { name: 'Type', exact: true }));
        await applyLayers(s);
        await wall(s);
      })];
      const { step } = await oracleModel(s);
      const layers = layerThicknesses(step);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      return finish(s,tasks,[
        check('ordered 115/100/15 mm layer set exported', layers.some((ls) => ls.length === 3 && ls.every((v,i) => near(v,[.115,.1,.015][i]))), JSON.stringify(layers)),
        check('typed wall thickness follows the 230 mm type', sizes.length === 1 && near(sizes[0].thickness,.23), JSON.stringify(sizes)),
        check('section and retyping update layers', false, 'not yet measured: section layer display and switching to a second layered type'),
      ]);
    },
  },
  {
    id: 'ui.type-editing', capability: 'type-editing',
    title: 'Place two walls of one type, edit its layer thickness',
    async run(s) {
      const tasks = [await task(s, 'create WT-200 and place two instances', async () => {
        await newType(s,'WT-200');
        await wall(s);
        await wall(s,3);
        await selectWall(s);
      })];
      tasks.push(await task(s,'apply 300 mm layers to Type',async () => {
        await field(s,s.page.getByLabel('Layer 1 thickness in metres'),.3);
        await s.ui.click(s.page.getByRole('radio',{name:'Type',exact:true}));
        await applyLayers(s);
      }));
      const { step } = await oracleModel(s);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      const typed = new Set(step.of('IFCRELDEFINESBYTYPE').flatMap((r) => (r.args[4] ?? []).map((v) => v.ref)));
      return finish(s,tasks,[
        check('two typed walls exported', sizes.length === 2 && step.of('IFCWALL').every((w) => typed.has(w.id)), `${sizes.length} walls; ${typed.size} typed occurrences`),
        check('both instances update to 300 mm', sizes.length === 2 && sizes.every((v) => near(v.thickness,.3)), JSON.stringify(sizes)),
        check('edit type pset and swap one instance',false,'not yet measured: shared type property editing and swapping one instance'),
      ]);
    },
  },
  {
    id:'ui.materials', capability:'materials', title:'Create and assign a material through wall layers',
    async run(s) {
      const tasks = [await task(s,'create Brick material and draw layered wall',async () => {
        await layer(s,1,.2,'Brick');
        await applyLayers(s);
        await wall(s);
      })];
      const { step } = await oracleModel(s);
      const names = step.of('IFCMATERIAL').map((m) => m.args[0]);
      return finish(s,tasks,[
        check('named material assigned through exported layers',names.includes('Brick') && step.count('IFCRELASSOCIATESMATERIAL') > 0 && step.count('IFCMATERIALLAYERSETUSAGE') > 0, JSON.stringify(names)),
        check('material appearance colour and reassignment',false,'layer editor creates names; material colour editing, reassignment and rendered colour are not measured'),
      ]);
    },
  },
  {
    id:'ui.align-trim-split', capability:'align-offset-trim-split', title:'Split a typed 5 m wall at 2 m',
    async run(s) {
      const tasks = [await task(s,'draw and select wall',async () => { await wall(s); await selectWall(s); })];
      tasks.push(await task(s,'K, click the cut at 2 m',async () => {
        await s.ui.key('k');
        await s.ui.clickWorld([2,0,0]);
        await escape(s);
      }));
      const split = (await oracleModel(s)).step;
      const lengths = split.wallAxes().map((w) => w.length).sort((a,b) => a-b);
      tasks.push(await task(s,'align a displaced wall to a reference left edge',async () => {
        await wall(s,3);
        await wall(s,6,1);
        await escape(s);
        await s.ui.key('Shift+J');
        await s.ui.clickWorld([2.5,3,0]);
        await s.ui.clickWorld([3.5,6,0]);
        await s.ui.key('Enter');
        await escape(s);
      }));
      const aligned = (await oracleModel(s)).step.wallAxes().filter((w) => w.start[1] > 2);
      tasks.push(await task(s,'trim the y=3 wall against a vertical boundary at x=3',async () => {
        await tool(s,'wall.place');
        await s.ui.clickWorld([3,2,0]);
        await typeFields(s,[6,90]);
        await escape(s);
        await s.ui.key('Shift+E');
        await s.ui.clickWorld([3,5,0]);
        await s.ui.clickWorld([4.5,3,0]);
        await escape(s);
      }));
      const { step } = await oracleModel(s);
      const trimmed = step.wallAxes().find((w) => Math.abs(w.start[1]-3) < .03 && Math.abs(w.end[1]-3) < .03);
      return finish(s,tasks,[
        check('split makes 2 m and 3 m pieces',lengths.length === 2 && near(lengths[0],2) && near(lengths[1],3),JSON.stringify(lengths)),
        check('align puts both left edges at the reference x',aligned.length === 2 && Math.abs(aligned[0].start[0]-aligned[1].start[0]) < .03,JSON.stringify(aligned)),
        check('trim removes the segment beyond x=3',!!trimmed && Math.abs(trimmed.end[0]-3) < .03,JSON.stringify(trimmed)),
        check('parallel offset command',false,'Edit rail has Align and Trim/Extend but no parallel Offset command; typed move is measured separately'),
      ]);
    },
  },
  {
    id:'ui.schedules', capability:'schedules-quantities', title:'Two walls carry quantities; grouped schedule export',
    async run(s) {
      const tasks = [await task(s,'draw two 5 m walls',async () => { await wall(s); await wall(s,3); })];
      let csv = null;
      tasks.push(await task(s,'Analyze > Lists > Wall Schedule > Export CSV',async () => {
        await s.ui.click(s.page.getByRole('tab',{name:'Analyze',exact:true}));
        await s.ui.click(s.page.getByRole('button',{name:'Entity lists',exact:true}));
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
        check('CSV contains wall lengths',!!csv && csv.text.split('\n').filter((l) => /5(?:[.,]0+)?/.test(l)).length >= 2,csv?.text.slice(0,600) ?? 'no schedule CSV download'),
        check('grouped schedule totals',false,'not yet measured: grouping and numeric total in the schedule'),
      ]);
    },
  },
  {
    id:'ui.session-scale', capability:'large-tall-model-performance', title:'Modest 20-wall session: select, edit and undo',
    async run(s) {
      await s.harness.aim([3,-5,70],[3,20,0]);
      const tasks = [await task(s,'setup: draw 20 separate typed walls',async () => {
        for (let i=0;i<20;i++) await wall(s,i*2);
      }).then((t) => ({...t,setup:true}))];
      tasks.push(await task(s,'select first wall, edit height to 4 m, undo',async () => {
        await selectWall(s);
        await field(s,s.page.getByLabel('Height in metres',{exact:true}),4);
      }));
      const changed = await oracleModel(s);
      tasks.push(await task(s,'undo height edit',() => s.ui.key('Control+z',{settle:800})));
      const { step } = await oracleModel(s);
      return finish(s,tasks,[
        check('20 walls retained after interaction',step.count('IFCWALL') === 20,`${step.count('IFCWALL')} walls`),
        check('height edit reached 4 m and undo restored it',changed.step.of('IFCWALL').some((w) => near(wallSize(changed.step,w).height,4)) && step.of('IFCWALL').every((w) => !near(wallSize(step,w).height,4)),'exported heights before and after undo'),
        check('large/tall session performance qualified',false,'20-wall untimed correctness smoke only; 1K/10K/50K and F5 timing require exclusive benchmark admission'),
      ],['Task durations are diagnostic only under ifc-gpu-check, never performance evidence.']);
    },
  },
];
