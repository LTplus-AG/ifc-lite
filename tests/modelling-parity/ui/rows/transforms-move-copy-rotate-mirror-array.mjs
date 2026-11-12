import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

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
      let editItems = [];
      tasks.push(await task(s, 'look for Mirror in the Edit menu', async () => {
        await s.ui.click(s.page.locator('[data-model-tool-rail]').getByRole('button', { name: 'Edit', exact: true }));
        editItems = await s.state(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.innerText.split('\n')[0].trim()));
        await s.ui.key('Escape');
      }));
      const shot = await s.shot('transforms');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
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
          { name: 'a Mirror command in the Edit menu', ok: editItems.some((x) => /mirror/i.test(x)), detail: `Edit menu: ${editItems.join(', ') || 'empty'}` },
        ],
      };
    },
  };
