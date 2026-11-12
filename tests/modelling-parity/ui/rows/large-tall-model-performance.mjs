/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { task } from '../lib/driver.mjs';
import { oracleModel } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, wallSize, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id:'ui.session-scale', capability:'large-tall-model-performance', title:'Modest 20-wall session: select, edit and undo',
    async run(s) {
      await s.harness.aim([3,-5,70],[3,20,0]);
      const tasks = [await task(s,'setup: draw 20 separate typed walls',async () => {
        for (let i=0;i<20;i++) await wall(s,i*2);
      }).then(t => Object.assign(t, { setup: true }))];
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
  };
