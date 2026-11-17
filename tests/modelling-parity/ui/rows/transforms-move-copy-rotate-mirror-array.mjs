/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { rotatedWall, arrayWalls } from '../lib/measured-oracles.mjs';
import { editCommand } from '../lib/command-ui.mjs';
import { meshIfc, bboxOfParts } from '../../probes/sdk/lib/parity.mjs';
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
      }).then(t => Object.assign(t, { setup: true })));
      const notes = [];
      tasks.push(await task(s, 'move: select the y=0 wall, Shift+M, from (0,0), type 2 towards +Y', async () => {
        await selectAt(s, [[2, 0, 1.5]]);
        await s.ui.key('Shift+M', { settle: 300 });
        await s.ui.clickWorld([0, 0, 0]);
        await s.ui.hoverWorld([0, 1.5, 0]);
        await typeFields(s, [2]);
        await escape(s);
      }));
      const beforeRotate = (await oracleModel(s)).step;
      const rotationSource = beforeRotate.wallAxes().find(w => near(w.start[1],5,.03) && near(w.end[1],5,.03));
      const rotationPivot = rotationSource && rotationSource.start.map((v,i) => (v+rotationSource.end[i])/2);
      const rotationGuid = rotationSource && beforeRotate.get(rotationSource.id).args[0];
      tasks.push(await task(s, 'rotate: select the y=5 wall, Shift+Q, type 90', async () => {
        await selectAt(s, [[2, 5, 1.5]]);
        await s.ui.key('Shift+Q', { settle: 300 });
        await typeFields(s, [90]);
        await escape(s);
      }));
      const beforeMirror = (await oracleModel(s)).step;
      const original = beforeMirror.wallAxes().find(w => near(w.start[1],10,.01) && near(w.end[1],10,.01));
      const guid = original && beforeMirror.get(original.id).args[0];
      let mirrored = null, restored = null, reflectedBounds = null, mirroredFile = null;
      tasks.push(await task(s, 'mirror y=10 wall about y=12', async () => {
        await selectAt(s, [[2,10,1.5]]);
        await editCommand(s,'element.mirror');
        await s.ui.clickWorld([0,12,0]);
        await s.ui.clickWorld([4,12,0]);
        await escape(s);
        const exported = await oracleModel(s);
        mirrored = exported.step;
        mirroredFile = { name:'ui.transforms-mirrored.ifc',bytes:Buffer.from(exported.text) };
        const entity = mirrored.of('IFCWALL').find(w => w.args[0] === guid);
        const meshes = await meshIfc(exported.text);
        reflectedBounds = entity ? bboxOfParts(meshes.get(entity.id)?.parts ?? []) : null;
      }));
      if (mirrored) tasks.push(await task(s,'undo mirror restores the original wall',async () => {
        await s.ui.key('Control+z',{settle:800});
        restored = (await oracleModel(s)).step;
      }));
      const wallWithGuid = step => {
        const entity = step?.of('IFCWALL').find(w => w.args[0] === guid);
        return entity && step.wallAxes().find(w => w.id === entity.id);
      };
      const undone = wallWithGuid(restored);
      tasks.push(await task(s, 'array: select the y=10 wall, Shift+A, count 3, spacing 1.5, two clicks for +Y', async () => {
        await selectAt(s, [[2, 10, 1.5]]);
        await s.ui.key('Shift+A', { settle: 300 });
        await typeFields(s, [3, 1.5], { enter: false });
        await s.ui.key('Tab');
        await s.ui.clickWorld([6, 10, 0]);
        await s.ui.clickWorld([6, 12, 0]);
        await escape(s);
      }));
      const shot = await s.shot('transforms');
      const finalStep = (await oracleModel(s)).step;
      const axes = finalStep.wallAxes();
      const rotatedEntity = finalStep.of('IFCWALL').find(w => w.args[0] === rotationGuid);
      // Clicked wall origins carry the click's few-mm error, so the move is judged to 30 mm.
      const moved = axes.some((a) => nearPt(a.start, [0, 2], 0.03) && nearPt(a.end, [4, 2], 0.03));
      const rotated = rotatedWall(rotationSource, axes.find(w => w.id === rotatedEntity?.id), rotationPivot);
      const arrayed = axes.filter((a) => near(a.length, 4, 1e-3) && a.start[1] > 9).length;
      return {
        tasks, notes, evidence: [shot], artifacts: { mirrorIfc: mirroredFile },
        checks: [
          { name: 'move by a typed 2 m', ok: moved, detail: axes.map((a) => `${fmt(a.start)}->${fmt(a.end)}`).join(' ') },
          { name: 'rotate by a typed 90 degrees', ok: rotated, detail: rotated ? 'selected wall turned +90 degrees about its original centre' : 'selected wall has wrong signed rotation' },
          { name: 'array makes 3 walls from one', ok: arrayWalls(axes,2), detail: `${arrayed} walls in the array region` },
          { name: 'Mirror reflects the selected wall about y=12', ok: !!reflectedBounds && near(reflectedBounds.centre[1],14,.01) && near(reflectedBounds.min[0],0,.01) && near(reflectedBounds.max[0],4,.01) && near(reflectedBounds.size[1],.2,.005) && mirrored.count('IFCWALL') === beforeMirror.count('IFCWALL'), detail: JSON.stringify(reflectedBounds) ?? 'Mirror gesture did not produce an exported wall' },
          { name: 'Undo restores the mirrored wall to y=10', ok: !!undone && near(undone.start[1],10,.01) && near(undone.end[1],10,.01) && restored.count('IFCWALL') === beforeMirror.count('IFCWALL'), detail: JSON.stringify(undone) ?? 'No completed Mirror to undo' },
        ],
      };
    },
  };
