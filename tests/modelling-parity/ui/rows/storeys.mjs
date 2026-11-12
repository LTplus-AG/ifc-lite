import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.storeys',
    capability: 'storeys',
    title: 'Storey manager: add above, edit floor-to-floor, rename, delete',
    async run(s) {
      const notes = [];
      const tasks = [];
      tasks.push(await task(s, 'open storey manager', () => openStoreyManager(s)));
      const before = (await readSession(s)).storeyId;
      tasks.push(await task(s, 'add storey above', () => s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 })));
      const after = (await readSession(s)).storeyId;
      if (after !== before) notes.push('"Add storey above" makes the new storey the one you draw on.');
      tasks.push(await task(s, 'edit Level 1 floor-to-floor to 3.5', async () => {
        await s.ui.click(s.page.getByLabel('Floor-to-floor height of Level 1, metres'));
        await s.ui.key('Control+A');
        await s.ui.type('3.5');
        await s.ui.key('Enter', { settle: 800 });
      }));
      tasks.push(await task(s, 'rename Level 2 to First floor', async () => {
        await s.ui.click(s.page.getByLabel('Name of Level 2'));
        await s.ui.key('Control+A');
        await s.ui.type('First floor');
        await s.ui.key('Enter', { settle: 500 });
      }));
      let sawAdded = false;
      let sawDeleted = false;
      tasks.push(await task(s, 'add and delete a storey', async () => {
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        const rows = await readStoreyManager(s);
        sawAdded = /Level 3/.test(rows ?? '');
        if (!sawAdded) throw new Error(`no Level 3 after adding: ${rows?.slice(0, 200)}`);
        await s.ui.click(s.page.getByRole('button', { name: 'Delete Level 3' }), { settle: 600 });
        sawDeleted = !/Level 3/.test((await readStoreyManager(s)) ?? '');
      }));
      const shot = await s.shot('storeys');
      const { step } = await oracleModel(s);
      const storeys = step.storeys();
      const l1 = storeys.find((x) => x.name === 'Level 1');
      const l2 = storeys.find((x) => x.name === 'First floor');
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'the manager showed Level 3 after adding it and not after deleting it', ok: sawAdded && sawDeleted, detail: `added ${sawAdded}, deleted ${sawDeleted}` },
          { name: 'two storeys after add, add, delete', ok: storeys.length === 2, detail: storeys.map((x) => `${x.name}@${x.elevation}`).join(', ') },
          { name: 'renamed storey exported as "First floor"', ok: !!l2, detail: storeys.map((x) => x.name).join(', ') },
          { name: 'floor-to-floor 3.5 moved First floor to +3.5', ok: !!l1 && !!l2 && near(l2.elevation - l1.elevation, 3.5, 1e-6), detail: l2 ? `First floor at ${l2.elevation}` : 'missing' },
        ],
      };
    },
  };
