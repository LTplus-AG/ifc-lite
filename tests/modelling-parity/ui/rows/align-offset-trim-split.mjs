/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editCommand } from '../lib/command-ui.mjs';
import { task } from '../lib/driver.mjs';
import { escape, tool, typeFields, oracleModel } from '../lib/model-ui.mjs';
import { check, wall, selectWall, finish } from '../lib/authoring-helpers.mjs';

export default {
    id:'ui.align-trim-split', capability:'align-offset-trim-split', title:'Split a typed 5 m wall at 2 m',
    async run(s) {
      const tasks = [await task(s,'draw and select wall',async () => { await wall(s); await selectWall(s); })];
      const original = (await oracleModel(s)).step;
      let offset = null, offsetUndo = null;
      tasks.push(await task(s,'Offset the original 5 m wall by 1.5 m',async () => {
        await selectWall(s);
        await editCommand(s,'element.offset');
        await s.ui.click(s.page.getByRole('textbox',{name:/Distance/}));
        await s.ui.key('Control+A');
        await s.ui.type('1.5');
        await s.ui.clickWorld([2,2,0]);
        await escape(s);
        offset = (await oracleModel(s)).step;
      }));
      if (offset) tasks.push(await task(s,'undo removes the parallel offset copy',async () => {
        await s.ui.key('Control+z',{settle:800});
        offsetUndo = (await oracleModel(s)).step;
      }));
      await selectWall(s);
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
        check('clicked split makes 2 m and 3 m pieces within 30 mm',lengths.length === 2 && Math.abs(lengths[0]-2) < .03 && Math.abs(lengths[1]-3) < .03,JSON.stringify(lengths)),
        check('align puts both left edges at the reference x',aligned.length === 2 && Math.abs(aligned[0].start[0]-aligned[1].start[0]) < .03,JSON.stringify(aligned)),
        check('trim removes the segment beyond x=3',!!trimmed && Math.abs(trimmed.end[0]-3) < .03,JSON.stringify(trimmed)),
        check('Offset creates a parallel 5 m copy at y=1.5', !!offset && offset.count('IFCWALL') === original.count('IFCWALL')+1 && offset.wallAxes().some(w => Math.abs(w.start[1]-1.5) <= .01 && Math.abs(w.end[1]-1.5) <= .01 && Math.abs(w.length-5) <= .001), JSON.stringify(offset?.wallAxes()) ?? 'No completed Offset gesture'),
        check('Undo removes the offset copy', !!offsetUndo && offsetUndo.count('IFCWALL') === original.count('IFCWALL') && offsetUndo.wallAxes().every(w => Math.abs(w.start[1]) <= .01 && Math.abs(w.end[1]) <= .01), JSON.stringify(offsetUndo?.wallAxes()) ?? 'No completed Offset to undo'),
      ]);
    },
  };
