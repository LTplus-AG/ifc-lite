/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { task } from '../lib/driver.mjs';
import { escape, oracleModel, openStoreyManager, switchStorey, tool, typeFields } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, wallSize, finish } from '../lib/authoring-helpers.mjs';

const near = (a,b) => Number.isFinite(a) && Math.abs(a-b) <= .005;
const wallBounds = (step,index = 0) => {
  const w = step.of('IFCWALL')[index];
  if (!w) return null;
  const base = step.placement(w.id).origin[2];
  const height = wallSize(step,w).height;
  return { base, height, top: base+height };
};

/** #9878's handoff is driven through the inspector and viewport, never SDK attachment. */
export default {
  id: 'ui.wall-constraints', capability: 'wall-top-base-constraints',
  title: 'Wall top/base offsets, storey following and picked slab underside',
  async run(s) {
    const tasks = [await task(s,'add Level 2 and attach wall A on Level 1',async () => {
      await openStoreyManager(s);
      await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button',{name:'Add storey above'}).first());
      await s.ui.click(s.page.getByRole('radio',{name:'Draw on Level 1'}));
      await s.ui.click(s.page.getByRole('button',{name:'Back to the inspector'}));
      await wall(s);
      await selectWall(s);
      await s.ui.click(s.page.locator('[data-model-inspector]').getByText('To storey above',{exact:true}));
    })];
    const initial = wallBounds((await oracleModel(s)).step);
    let topOffset = null, baseOffset = null, baseUndo = null;
    tasks.push(await task(s,'set Top offset to -0.2 m',async () => {
      await selectWall(s);
      const input = s.page.locator('#wall-top-offset');
      if (!(await input.count())) throw new Error('Wall inspector offers no top-offset field in this viewer.');
      await field(s,input,-.2);
      topOffset = wallBounds((await oracleModel(s)).step);
    }));
    tasks.push(await task(s,'set Base offset to 0.4 m, preserving the top',async () => {
      await selectWall(s);
      const input = s.page.locator('#wall-base-offset');
      if (!(await input.count())) throw new Error('Wall inspector offers no base-offset field in this viewer.');
      await field(s,input,.4);
      baseOffset = wallBounds((await oracleModel(s)).step);
    }));
    if (baseOffset) tasks.push(await task(s,'Undo restores the base and height',async () => {
      await s.ui.key('Control+z',{settle:800});
      baseUndo = wallBounds((await oracleModel(s)).step);
    }));
    tasks.push(await task(s,'raise Level 1 floor-to-floor to 3.4 m',async () => {
      await openStoreyManager(s);
      await field(s,s.page.getByLabel('Floor-to-floor height of Level 1, metres'),3.4);
      await s.ui.click(s.page.getByRole('button',{name:'Back to the inspector'}));
    }));
    const raised = wallBounds((await oracleModel(s)).step);
    tasks.push(await task(s,'draw wall B and a 300 mm slab on Level 2',async () => {
      await wall(s,3);
      await switchStorey(s,'Level 2');
      await tool(s,'slab.place');
      await s.ui.clickWorld([-.5,2,3.4]);
      await typeFields(s,[6,3]);
      await escape(s);
      await s.ui.clickWorld([2,4,3.4]);
      await field(s,s.page.getByLabel('Thickness in metres',{exact:true}),.3);
      await switchStorey(s,'Level 1');
      await s.ui.click(s.page.locator('[data-storey-context]').first());
      await s.ui.click(s.page.getByRole('radio',{name:'Show all',exact:true}));
      await s.ui.key('Escape');
      await s.harness.aim([12,12,8],[2.5,2,1.5]);
    }));
    let picked = null, invalidPick = null;
    tasks.push(await task(s,'pick the slab in the viewport as wall B top',async () => {
      await selectWall(s,3);
      const choice = s.page.getByRole('radiogroup',{name:'Wall top',exact:true}).locator('input[value="element"]');
      if (!(await choice.count())) throw new Error('Wall top offers no slab/roof attachment choice in this viewer.');
      await s.ui.click(choice.locator('..'));
      await s.ui.clickWorld([2,4,3.4]);
      picked = wallBounds((await oracleModel(s)).step,1);
    }));
    if (picked) tasks.push(await task(s,'invalid wall pick keeps the source selection; Escape cancels',async () => {
      await selectWall(s,3);
      const selected = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
      await s.ui.click(s.page.getByRole('button',{name:'Pick another slab or roof…',exact:true}));
      await s.ui.clickWorld([2.5,0,2.5]);
      const sameSelection = await s.state(id => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId === id,selected);
      const reason = await s.page.locator('[data-model-inspector]').innerText();
      await s.ui.key('Escape');
      const cancelled = wallBounds((await oracleModel(s)).step,1);
      invalidPick = { sameSelection, reason, top: cancelled?.top };
    }));
    return finish(s,tasks,[
      check('wall A initially reaches Level 2 at 3 m',near(initial?.top,3),JSON.stringify(initial)),
      check('Top offset -0.2 m makes the top 2.8 m',near(topOffset?.top,2.8),JSON.stringify(topOffset) ?? 'No top-offset gesture completed'),
      check('Base offset 0.4 m preserves top 2.8 m and height 2.4 m',near(baseOffset?.base,.4) && near(baseOffset?.height,2.4) && near(baseOffset?.top,2.8),JSON.stringify(baseOffset) ?? 'No base-offset gesture completed'),
      check('Undo restores base 0 and height 2.8 m',near(baseUndo?.base,0) && near(baseUndo?.height,2.8),JSON.stringify(baseUndo) ?? 'No base-offset Undo completed'),
      check('top follows the storey height change, retaining -0.2 m offset',near(raised?.top,3.2),JSON.stringify(raised)),
      check('wall B reaches the clicked slab underside at 3.1 m',near(picked?.top,3.1),JSON.stringify(picked) ?? 'No slab attachment gesture completed'),
      check('invalid target is refused and Escape preserves attachment',!!invalidPick?.sameSelection && /Pick a slab or roof/.test(invalidPick.reason) && near(invalidPick.top,3.1),JSON.stringify(invalidPick) ?? 'No attachment available to retarget'),
    ]);
  },
};
