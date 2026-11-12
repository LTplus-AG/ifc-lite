/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { editCommand } from '../lib/command-ui.mjs';
import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool, typeFields } from '../lib/model-ui.mjs';


import { near, nearPt, fmt, selectAt } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.transforms',
    capability: 'transforms-move-copy-rotate-mirror-array',
    title: 'Move 2 m, rotate 90 degrees, array x3, mirror',
    async run(s) {
      const tasks = [];
      await s.harness.aim([2, -5, 42], [2, 5, 0]);
      tasks.push(await task(s, 'setup: three 4 m walls at y = 0, 5, 10', async () => {
        for (const y of [0, 5, 10]) {
          await s.ui.clickWorld([0, y, 0]);
          await typeFields(s, [4, 0]);
          await escape(s, 1);
        }
        await escape(s);
      }).then((t) => ({ ...t, setup: true })));
      const notes = [];
      tasks.push(await task(s, 'move: select the y=0 wall, Shift+M, from (0,0), type 2 towards +Y', async () => {
        await selectAt(s, [[2, 0, 1.5]]);
        await s.ui.key('Shift+M', { settle: 300 });
        await s.ui.clickWorld([0, 0, 0]);
        await s.ui.hoverWorld([0, 1.5, 0]);
        await typeFields(s, [2]);
        await escape(s);
      }));
      tasks.push(await task(s, 'rotate: select the y=5 wall, Shift+Q, type 90', async () => {
        await selectAt(s, [[2, 5, 1.5]]);
        await s.ui.key('Shift+Q', { settle: 300 });
        await typeFields(s, [90]);
        await escape(s);
      }));
      tasks.push(await task(s, 'array: select the y=10 wall, Shift+A, count 3, spacing 1.5, two clicks for +Y', async () => {
        await selectAt(s, [[2, 10, 1.5]]);
        await s.ui.key('Shift+A', { settle: 300 });
        await typeFields(s, [3, 1.5], { enter: false });
        await s.ui.key('Tab');
        await s.ui.clickWorld([6, 10, 0]);
        await s.ui.clickWorld([6, 12, 0]);
        await escape(s);
      }));
      const beforeMirror = (await oracleModel(s)).step;
      const original = beforeMirror.wallAxes().find(w => near(w.start[1],10,.01) && near(w.end[1],10,.01));
      const guid = original && beforeMirror.get(original.id).args[0];
      let mirrored = null, restored = null;
      tasks.push(await task(s, 'mirror y=10 wall about y=12', async () => {
        await selectAt(s, [[2,10,1.5]]);
        await editCommand(s,'element.mirror');
        await s.ui.clickWorld([0,12,0]);
        await s.ui.clickWorld([4,12,0]);
        await escape(s);
        mirrored = (await oracleModel(s)).step;
      }));
      if (mirrored) tasks.push(await task(s,'undo mirror restores the original wall',async () => {
        await s.ui.key('Control+z',{settle:800});
        restored = (await oracleModel(s)).step;
      }));
      const wallWithGuid = step => {
        const entity = step?.of('IFCWALL').find(w => w.args[0] === guid);
        return entity && step.wallAxes().find(w => w.id === entity.id);
      };
      const reflected = wallWithGuid(mirrored), undone = wallWithGuid(restored);
      const shot = await s.shot('transforms');
      const axes = beforeMirror.wallAxes();
      // Clicked wall origins carry the click's few-mm error, so the move is judged to 30 mm.
      const moved = axes.some((a) => nearPt(a.start, [0, 2], 0.03) && nearPt(a.end, [4, 2], 0.03));
      const rotated = axes.some((a) => near(a.end[0] - a.start[0], 0, 1e-3) && near(a.length, 4, 1e-3));
      const arrayed = axes.filter((a) => near(a.length, 4, 1e-3) && a.start[1] > 9).length;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'move by a typed 2 m', ok: moved, detail: axes.map((a) => `${fmt(a.start)}->${fmt(a.end)}`).join(' ') },
          { name: 'rotate by a typed 90 degrees', ok: rotated, detail: rotated ? 'a vertical 4 m wall exists' : 'no vertical wall' },
          { name: 'array makes 3 walls from one', ok: arrayed >= 3, detail: `${arrayed} walls in the array region` },
          { name: 'Mirror reflects the selected wall about y=12', ok: !!reflected && near(reflected.start[1],14,.01) && near(reflected.end[1],14,.01) && near(reflected.length,4,.001), detail: JSON.stringify(reflected) ?? 'Mirror gesture did not produce an exported wall' },
          { name: 'Undo restores the mirrored wall to y=10', ok: !!undone && near(undone.start[1],10,.01) && near(undone.end[1],10,.01) && restored.count('IFCWALL') === beforeMirror.count('IFCWALL'), detail: JSON.stringify(undone) ?? 'No completed Mirror to undo' },
        ],
      };
    },
  };
